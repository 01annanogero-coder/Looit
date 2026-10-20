import { describe, expect, it } from 'vitest';
import { ease, evaluate, frameCount, frameTime, type Track, type Vec3 } from './animation';

describe('evaluate', () => {
  const track: Track<Vec3> = {
    keyframes: [
      { time: 1, value: [0, 0, 0] },
      { time: 3, value: [10, -20, 360] },
    ],
  };

  it('returns the fallback when there are no keyframes', () => {
    expect(evaluate({ keyframes: [] }, 2, 7)).toBe(7);
  });

  it('holds the first value before the first keyframe', () => {
    expect(evaluate(track, 0, [9, 9, 9])).toEqual([0, 0, 0]);
  });

  it('holds the last value after the last keyframe', () => {
    expect(evaluate(track, 99, [9, 9, 9])).toEqual([10, -20, 360]);
  });

  it('hits keyframe values exactly', () => {
    expect(evaluate(track, 1, [9, 9, 9])).toEqual([0, 0, 0]);
    expect(evaluate(track, 3, [9, 9, 9])).toEqual([10, -20, 360]);
  });

  it('interpolates linearly per component (full 360 spin preserved)', () => {
    expect(evaluate(track, 2, [9, 9, 9])).toEqual([5, -10, 180]);
  });

  it('applies the easing of the segment start keyframe', () => {
    const t: Track<number> = {
      keyframes: [
        { time: 0, value: 0, easing: 'easeIn' },
        { time: 1, value: 100 },
      ],
    };
    expect(evaluate(t, 0.5, 0)).toBeCloseTo(12.5);
  });

  it('hold easing keeps the value until the next keyframe', () => {
    const t: Track<number> = {
      keyframes: [
        { time: 0, value: 1, easing: 'hold' },
        { time: 1, value: 2 },
      ],
    };
    expect(evaluate(t, 0.999, 0)).toBe(1);
    expect(evaluate(t, 1, 0)).toBe(2);
  });

  it('handles many keyframes', () => {
    const t: Track<number> = {
      keyframes: Array.from({ length: 100 }, (_, i) => ({ time: i, value: i * 2 })),
    };
    expect(evaluate(t, 42.5, 0)).toBe(85);
  });
});

describe('ease', () => {
  it('starts at 0 and ends at 1 for all curves', () => {
    for (const e of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      expect(ease(e, 0)).toBeCloseTo(0);
      expect(ease(e, 1)).toBeCloseTo(1);
    }
  });
});

describe('frame timing', () => {
  it('computes frame times without drift', () => {
    expect(frameTime(150, 30)).toBe(5);
    expect(frameTime(299, 30)).toBeCloseTo(9.9666667);
    expect(frameCount(10, 30)).toBe(300);
  });
});
