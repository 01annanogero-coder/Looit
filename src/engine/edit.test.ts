import { describe, expect, it } from 'vitest';
import type { Vec3 } from './animation';
import {
  adjacentTime,
  keyframeAt,
  moveKeyframes,
  removeKeyframes,
  setValueAt,
  snapTime,
  toggleKeyframe,
  upsertKeyframe,
} from './edit';
import { sample, staticValue, type Animated } from './project';

function animated(...frames: [number, number][]): Animated<number> {
  return { value: 0, keyframes: frames.map(([time, value], i) => ({ id: `k${i}`, time, value })) };
}

describe('setValueAt', () => {
  it('changes the static value when not animated', () => {
    const a = staticValue(1);
    setValueAt(a, 2, 5);
    expect(a).toEqual({ value: 5, keyframes: [] });
  });

  it('adds a keyframe at the playhead when animated', () => {
    const a = animated([0, 0], [2, 10]);
    setValueAt(a, 1, 99);
    expect(a.keyframes.map((k) => [k.time, k.value])).toEqual([
      [0, 0],
      [1, 99],
      [2, 10],
    ]);
  });

  it('replaces a keyframe at the same time', () => {
    const a = animated([0, 0], [2, 10]);
    setValueAt(a, 2, 7);
    expect(a.keyframes).toHaveLength(2);
    expect(keyframeAt(a, 2)?.value).toBe(7);
  });
});

describe('toggleKeyframe', () => {
  it('starts animating with the current value', () => {
    const a = staticValue<Vec3>([1, 2, 3]);
    toggleKeyframe(a, 1.5);
    expect(a.keyframes).toHaveLength(1);
    expect(a.keyframes[0]).toMatchObject({ time: 1.5, value: [1, 2, 3] });
  });

  it('adds a keyframe holding the interpolated value', () => {
    const a = animated([0, 0], [2, 10]);
    toggleKeyframe(a, 1);
    expect(keyframeAt(a, 1)?.value).toBe(5);
    expect(sample(a, 1)).toBe(5);
  });

  it('removes an existing keyframe; the last one becomes the static value', () => {
    const a = animated([1, 42]);
    toggleKeyframe(a, 1);
    expect(a).toEqual({ value: 42, keyframes: [] });
  });
});

describe('removeKeyframes', () => {
  it('removes only the given ids', () => {
    const a = animated([0, 0], [1, 1], [2, 2]);
    removeKeyframes(a, new Set(['k1']));
    expect(a.keyframes.map((k) => k.id)).toEqual(['k0', 'k2']);
  });
});

describe('moveKeyframes', () => {
  it('moves, snaps to frames and keeps order', () => {
    const a = animated([0, 0], [1, 1], [2, 2]);
    moveKeyframes(a, new Set(['k0']), 1.51, 5, 30);
    expect(a.keyframes.map((k) => [k.id, Number(k.time.toFixed(4))])).toEqual([
      ['k1', 1],
      ['k0', 1.5],
      ['k2', 2],
    ]);
  });

  it('clamps to the project duration', () => {
    const a = animated([4, 0]);
    moveKeyframes(a, new Set(['k0']), 10, 5, 30);
    expect(a.keyframes[0].time).toBe(5);
    moveKeyframes(a, new Set(['k0']), -10, 5, 30);
    expect(a.keyframes[0].time).toBe(0);
  });

  it('a moved keyframe replaces one it lands on', () => {
    const a = animated([0, 0], [1, 1]);
    moveKeyframes(a, new Set(['k0']), 1, 5, 30);
    expect(a.keyframes.map((k) => [k.id, k.time, k.value])).toEqual([['k0', 1, 0]]);
  });
});

describe('helpers', () => {
  it('snaps to the nearest frame', () => {
    expect(snapTime(0.51, 30)).toBeCloseTo(15 / 30);
    expect(snapTime(1.004, 60)).toBeCloseTo(1);
  });

  it('upsert assigns ids', () => {
    const a = staticValue(0);
    expect(upsertKeyframe(a, 1, 3).id).toBeTruthy();
  });

  it('finds adjacent keyframe times', () => {
    expect(adjacentTime([0, 1, 2, 2], 1, 1)).toBe(2);
    expect(adjacentTime([0, 1, 2], 1, -1)).toBe(0);
    expect(adjacentTime([0, 1, 2], 2, 1)).toBeUndefined();
  });
});
