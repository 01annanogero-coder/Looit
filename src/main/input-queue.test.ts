import { describe, expect, it } from 'vitest';
import type { PageInput } from '../shared/ipc';
import { InputQueue, coalesce } from './input-queue';

function run(events: PageInput[]): PageInput[] {
  const q: PageInput[] = [];
  for (const e of events) coalesce(q, e);
  return q;
}

describe('coalesce', () => {
  it('keeps only the latest of consecutive moves', () => {
    expect(
      run([
        { type: 'move', x: 1, y: 1 },
        { type: 'move', x: 2, y: 2 },
        { type: 'move', x: 3, y: 3 },
      ]),
    ).toEqual([{ type: 'move', x: 3, y: 3 }]);
  });

  it('sums wheel deltas across interleaved moves', () => {
    expect(
      run([
        { type: 'move', x: 1, y: 1 },
        { type: 'wheel', x: 1, y: 1, deltaY: 100 },
        { type: 'move', x: 2, y: 2 },
        { type: 'wheel', x: 2, y: 2, deltaY: 100 },
        { type: 'wheel', x: 3, y: 3, deltaY: -50 },
      ]),
    ).toEqual([{ type: 'wheel', x: 3, y: 3, deltaY: 150 }]);
  });

  it('never merges across presses and releases', () => {
    expect(
      run([
        { type: 'move', x: 1, y: 1 },
        { type: 'down', x: 1, y: 1 },
        { type: 'move', x: 2, y: 2 },
        { type: 'move', x: 3, y: 3 },
        { type: 'up', x: 3, y: 3 },
        { type: 'wheel', x: 3, y: 3, deltaY: 100 },
      ]),
    ).toEqual([
      { type: 'move', x: 1, y: 1 },
      { type: 'down', x: 1, y: 1 },
      { type: 'move', x: 3, y: 3 },
      { type: 'up', x: 3, y: 3 },
      { type: 'wheel', x: 3, y: 3, deltaY: 100 },
    ]);
  });
});

describe('InputQueue', () => {
  it('merges events that arrive while a batch is in flight', async () => {
    const batches: PageInput[][] = [];
    let release!: () => void;
    const q = new InputQueue(async (b) => {
      batches.push(b);
      if (batches.length === 1) await new Promise<void>((r) => (release = r));
    });
    q.push([{ type: 'wheel', x: 0, y: 0, deltaY: 100 }]);
    for (let i = 0; i < 50; i++) q.push([{ type: 'wheel', x: 0, y: 0, deltaY: 100 }]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(batches).toEqual([
      [{ type: 'wheel', x: 0, y: 0, deltaY: 100 }],
      [{ type: 'wheel', x: 0, y: 0, deltaY: 5000 }],
    ]);
  });
});
