import { describe, expect, it } from 'vitest';
import { cursorEvents, frameInputs } from './inputs';
import type { CursorObject } from './project';

const cursor: CursorObject = {
  id: 'c',
  kind: 'cursor',
  name: 'Cursor',
  visible: true,
  targetId: 'w',
  size: 0.5,
  style: 'arrow',
  clickColor: '#3b82f6',
  position: {
    value: [0, 0],
    keyframes: [
      { id: 'a', time: 0, value: [100, 100] },
      { id: 'b', time: 1, value: [100, 100] },
      { id: 'c', time: 2, value: [400, 100] },
    ],
  },
  clicks: [{ id: 'k', time: 0.5 }],
  scrolls: [{ id: 's', time: 1.5, deltaY: 300 }],
  keys: [],
};

describe('frameInputs', () => {
  it('always moves on frame 0', () => {
    expect(frameInputs(cursor, 30, 0)).toEqual([{ type: 'move', x: 100, y: 100 }]);
  });

  it('skips the move while the cursor rests', () => {
    expect(frameInputs(cursor, 30, 5)).toEqual([]);
  });

  it('forces a move when asked (start of a parallel chunk)', () => {
    expect(frameInputs(cursor, 30, 5, true)).toEqual([{ type: 'move', x: 100, y: 100 }]);
  });

  it('fires a click on the frame whose interval contains it', () => {
    // 0.5 s at 30 fps is exactly frame 15: interval (14/30, 15/30].
    expect(frameInputs(cursor, 30, 14)).toEqual([]);
    expect(frameInputs(cursor, 30, 15)).toEqual([{ type: 'click', x: 100, y: 100 }]);
    expect(frameInputs(cursor, 30, 16)).toEqual([]);
  });

  it('moves and scrolls while the cursor travels', () => {
    const inputs = frameInputs(cursor, 30, 45);
    expect(inputs[0]).toEqual({ type: 'move', x: 250, y: 100 });
    expect(inputs[1]).toEqual({ type: 'wheel', x: 250, y: 100, deltaY: 300 });
  });

  it('fires every event exactly once across all frames', () => {
    const all = Array.from({ length: 61 }, (_, n) => frameInputs(cursor, 30, n)).flat();
    expect(all.filter((i) => i.type === 'click')).toHaveLength(1);
    expect(all.filter((i) => i.type === 'wheel')).toHaveLength(1);
  });

  it('returns nothing without a cursor', () => {
    expect(frameInputs(undefined, 30, 3)).toEqual([]);
  });
});

describe('typing', () => {
  const typing: CursorObject = {
    ...cursor,
    clicks: [{ id: 'k', time: 1 }],
    scrolls: [],
    keys: [
      { id: 't', time: 1, kind: 'type', text: 'hi!', cps: 10 },
      { id: 'e', time: 2, kind: 'press', key: 'Enter' },
    ],
  };

  it('types one character every 1/cps seconds, each on the frame containing its time', () => {
    // Characters at 1.0, 1.1, 1.2 s; at 30 fps those are frames 30, 33, 36.
    const typed = Array.from({ length: 61 }, (_, n) => ({ n, inputs: frameInputs(typing, 30, n) }))
      .filter((f) => f.inputs.some((i) => i.type === 'text'))
      .map((f) => [
        f.n,
        f.inputs
          .filter((i) => i.type === 'text')
          .map((i) => (i as { text: string }).text)
          .join(''),
      ]);
    expect(typed).toEqual([
      [30, 'h'],
      [33, 'i'],
      [36, '!'],
    ]);
  });

  it('clicks before typing that starts at the same moment', () => {
    expect(
      frameInputs(typing, 30, 30)
        .filter((i) => i.type !== 'move')
        .map((i) => i.type),
    ).toEqual(['click', 'text']);
  });

  it('presses special keys at their time', () => {
    expect(frameInputs(typing, 30, 60).filter((i) => i.type === 'key')).toEqual([{ type: 'key', key: 'Enter' }]);
  });

  it('lists the same events for the preview, with exact times', () => {
    expect(cursorEvents(typing, 0, 5).map((e) => [Number(e.time.toFixed(3)), e.input.type])).toEqual([
      [1, 'click'],
      [1, 'text'],
      [1.1, 'text'],
      [1.2, 'text'],
      [2, 'key'],
    ]);
  });
});
