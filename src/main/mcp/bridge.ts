// MCP server for AI apps (Claude Desktop and others), run as `Looit --mcp`.
//
// The AI app starts this process and talks MCP (JSON-RPC, one message per
// line) over stdin/stdout. It answers the handshake and the tool list itself,
// so connecting doesn't start Looit; the first tool call starts Looit if it
// isn't running and forwards the call to it over a private named pipe.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { app } from 'electron';
import { aiPipePath, readLines, type PipeRequest, type PipeResponse } from '../ai/pipe';
import { GUIDE, SERVER_INSTRUCTIONS } from './guide';
import { TOOLS } from './tools';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** Answer for clients asking for a version we don't know (they decide whether to continue). */
const FALLBACK_PROTOCOL = '2025-06-18';
const APP_START_TIMEOUT_MS = 45_000;

type Json = Record<string, unknown>;
interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}

export interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
}

function send(message: Json): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

/** The connection to the running Looit app. */
class AppConnection {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private launched = false;

  async call(method: string, params: unknown): Promise<unknown> {
    const socket = await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ id, method, params } satisfies PipeRequest)}\n`);
    });
  }

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    this.connecting ??= this.open().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async open(): Promise<net.Socket> {
    const deadline = Date.now() + APP_START_TIMEOUT_MS;
    for (;;) {
      try {
        const socket = await tryConnect();
        this.attach(socket);
        return socket;
      } catch {
        // Not running (or not listening yet): start it once, then keep trying.
        if (!this.launched) {
          this.launched = true;
          launchLooit();
        }
        if (Date.now() > deadline) throw new Error('Looit did not start. Open Looit, then try again.');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    readLines(socket, (line) => {
      let msg: PipeResponse;
      try {
        msg = JSON.parse(line) as PipeResponse;
      } catch {
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      for (const p of this.pending.values()) p.reject(new Error('Looit was closed.'));
      this.pending.clear();
      // A later call may start Looit again.
      this.launched = false;
    });
    socket.on('error', () => {});
  }
}

function tryConnect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(aiPipePath());
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function launchLooit(): void {
  // Packaged: the app itself. Development: Electron plus the app folder.
  const args = app.isPackaged ? [] : [app.getAppPath()];
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

const looit = new AppConnection();

async function callTool(name: string, args: unknown): Promise<ToolResult> {
  if (name === 'looit_guide') return { content: [{ type: 'text', text: GUIDE }] };
  if (!TOOLS.some((t) => t.name === name))
    return { content: [{ type: 'text', text: `Unknown tool ${name}.` }], isError: true };
  try {
    return (await looit.call('tool', { name, arguments: args ?? {} })) as ToolResult;
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

async function handleMessage(msg: RpcMessage): Promise<void> {
  const { id, method } = msg;
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== 'string') return; // a response to us; we send no requests
  const reply = (result: Json) => isRequest && send({ id, result });
  switch (method) {
    case 'initialize': {
      const requested = String(msg.params?.protocolVersion ?? '');
      reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'looit', title: 'Looit', version: app.getVersion() },
        instructions: SERVER_INSTRUCTIONS,
      });
      return;
    }
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: TOOLS });
      return;
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      reply((await callTool(name, msg.params?.arguments)) as unknown as Json);
      return;
    }
    default:
      // Notifications (initialized, cancelled, …) need no answer.
      if (isRequest) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

export function runBridge(): void {
  // stdout carries the protocol only; anything else goes to stderr.
  console.log = console.info = console.warn = console.error;
  // A throwaway profile, so this helper never competes with the app for its data folder.
  app.setPath('userData', path.join(app.getPath('temp'), 'looit-mcp-bridge'));
  app.disableHardwareAcceleration();
  process.on('uncaughtException', (err) => console.error('Looit MCP bridge:', err));

  // Electron's process.stdin gets no data from a pipe on Windows; reading the
  // descriptor directly does.
  const stdin = fs.createReadStream('', { fd: 0, encoding: 'utf8' });
  let buffer = '';
  stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        send({ id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      void handleMessage(msg).catch((err) => {
        if (msg.id !== undefined && msg.id !== null)
          send({ id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
      });
    }
  });
  // The AI app closed the connection: we're done.
  stdin.on('end', () => app.exit(0));
  stdin.on('error', () => app.exit(0));
}
