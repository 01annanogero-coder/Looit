import { describe, expect, it } from 'vitest';
import { convertBgraTopDownToRgbaBottomUp } from './site-texture';

describe('convertBgraTopDownToRgbaBottomUp', () => {
  it('swaps blue/red and flips rows', () => {
    // 1x2 image: top pixel BGRA(1,2,3,255), bottom pixel BGRA(10,20,30,128).
    const src = new Uint8Array([1, 2, 3, 255, 10, 20, 30, 128]);
    const dst = new Uint8Array(8);
    convertBgraTopDownToRgbaBottomUp(src, dst, 1, 2);
    // Row 0 of the output is the bottom row of the image.
    expect([...dst]).toEqual([30, 20, 10, 128, 3, 2, 1, 255]);
  });

  it('handles unaligned input views', () => {
    const backing = new Uint8Array(9);
    backing.set([1, 2, 3, 4], 1);
    const dst = new Uint8Array(4);
    convertBgraTopDownToRgbaBottomUp(backing.subarray(1, 5), dst, 1, 1);
    expect([...dst]).toEqual([3, 2, 1, 4]);
  });
});
