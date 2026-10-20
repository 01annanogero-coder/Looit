// Requests from the main process to a window's renderer ("read the project",
// "load this project", "export"), answered over the ai:response channel.

import type { WebContents } from 'electron';
import type { AiRequest, AiResponse } from '../../shared/ipc';

export class RendererRpc {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private ready = false;
  private readyWaiters: (() => void)[] = [];

  constructor(private readonly target: () => WebContents | null) {}

  /** The renderer registered its request handler. */
  markReady(): void {
    this.ready = true;
    for (const w of this.readyWaiters.splice(0)) w();
  }

  /** The renderer went away (closed or reloaded). */
  reset(): void {
    this.ready = false;
    for (const p of this.pending.values()) p.reject(new Error('The window was closed or reloaded.'));
    this.pending.clear();
  }

  async request<T>(method: string, params: unknown = {}, timeoutMs = 60_000): Promise<T> {
    if (!this.ready) {
      await withTimeout(new Promise<void>((r) => this.readyWaiters.push(r)), 30_000, 'The window did not start.');
    }
    const wc = this.target();
    if (!wc || wc.isDestroyed()) throw new Error('The window is closed.');
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    wc.send('ai:request', { id, method, params } satisfies AiRequest);
    try {
      return (await withTimeout(result, timeoutMs, 'The window did not answer in time.')) as T;
    } finally {
      this.pending.delete(id);
    }
  }

  resolve(msg: AiResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
