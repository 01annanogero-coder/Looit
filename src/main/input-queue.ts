// Live input forwarding. Chromium takes 25-65 ms to acknowledge each injected
// event while the mouse produces one every few milliseconds, so events must be
// merged while one is in flight or the page falls seconds behind the user.

import type { PageInput } from '../shared/ipc';

/**
 * Adds `ev` to `queue`, merging it with waiting events where that doesn't
 * change the result: consecutive moves keep only the latest position, and
 * consecutive wheel events add up (a wheel also carries the pointer position,
 * so moves just before it are dropped). Presses and releases are never merged.
 */
export function coalesce(queue: PageInput[], ev: PageInput): void {
  if (ev.type === 'wheel') {
    while (queue.at(-1)?.type === 'move') queue.pop();
    const last = queue.at(-1);
    if (last?.type === 'wheel') {
      queue[queue.length - 1] = { ...ev, deltaY: last.deltaY + ev.deltaY };
      return;
    }
  } else if (ev.type === 'move' && queue.at(-1)?.type === 'move') {
    queue[queue.length - 1] = ev;
    return;
  }
  queue.push(ev);
}

/** Sends input one batch at a time, merging whatever arrives in the meantime. */
export class InputQueue {
  private waiting: PageInput[] = [];
  private draining = false;

  constructor(private readonly dispatch: (events: PageInput[]) => Promise<void>) {}

  push(events: PageInput[]): void {
    for (const ev of events) coalesce(this.waiting, ev);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.waiting.length > 0) {
        const batch = this.waiting;
        this.waiting = [];
        await this.dispatch(batch).catch(() => {});
      }
    } finally {
      this.draining = false;
    }
  }
}
