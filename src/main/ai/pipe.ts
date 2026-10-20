// The private channel between the MCP bridge (started by an AI app) and the
// running Looit app: a named pipe carrying one JSON message per line.

import type net from 'node:net';
import os from 'node:os';

/** Per Windows user, so another account's Looit is never reached. */
export function aiPipePath(): string {
  const user =
    os
      .userInfo()
      .username.replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 40) || 'user';
  return `\\\\.\\pipe\\looit-ai-${user}`;
}

export interface PipeRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface PipeResponse {
  id: number;
  result?: unknown;
  error?: string;
}

/** Larger messages (e.g. a project with an embedded background image) are refused. */
const MAX_LINE_CHARS = 64 * 1024 * 1024;

/** Calls `onLine` for each complete line received on `socket`. */
export function readLines(socket: net.Socket, onLine: (line: string) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_CHARS) {
      socket.destroy(new Error('Message too large.'));
      return;
    }
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  });
}
