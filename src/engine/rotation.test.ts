import { describe, expect, it } from 'vitest';
import { closestEuler } from './rotation';

describe('closestEuler', () => {
  it('keeps angles that are already close', () => {
    expect(closestEuler([10, 20, 30], [9, 19, 29])).toEqual([10, 20, 30]);
  });

  it('continues past 180 instead of jumping to -180', () => {
    expect(closestEuler([-170, 0, 0], [175, 0, 0])).toEqual([190, 0, 0]);
  });

  it('keeps multi-turn values', () => {
    expect(closestEuler([5, 0, 0], [720, 0, 0])).toEqual([725, 0, 0]);
  });

  it('picks the equivalent Euler set nearest the previous one', () => {
    // (180, 80, 180) is the same orientation as (0, 100, 0).
    expect(closestEuler([180, 80, 180], [0, 95, 0])).toEqual([0, 100, 0]);
  });
});
