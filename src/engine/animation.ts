// Keyframe animation engine.
//
// Pure functions with no rendering or Electron dependencies, so the preview and
// the exporter evaluate exactly the same values for the same time.

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold';

export interface Keyframe<T> {
  /** Stable identity for selection and editing; unique within its track. */
  id?: string;
  /** Time in seconds. */
  time: number;
  value: T;
  /** Easing of the segment that starts at this keyframe. Defaults to linear. */
  easing?: Easing;
}

/** Keyframes must be sorted by time; use `sortKeyframes` after edits. */
export interface Track<T> {
  keyframes: Keyframe<T>[];
}

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export function ease(easing: Easing | undefined, p: number): number {
  switch (easing ?? 'linear') {
    case 'linear':
      return p;
    case 'easeIn':
      return p * p * p;
    case 'easeOut':
      return 1 - (1 - p) ** 3;
    case 'easeInOut':
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    case 'hold':
      return 0;
  }
}

export function sortKeyframes<T>(track: Track<T>): void {
  track.keyframes.sort((a, b) => a.time - b.time);
}

/** Index of the last keyframe with time <= t, or -1 if t is before the first. */
function segmentIndex<T>(keyframes: Keyframe<T>[], t: number): number {
  let lo = 0;
  let hi = keyframes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid].time <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Evaluates a numeric or numeric-tuple track at time `t`.
 * Values before the first / after the last keyframe are held. Tuples are
 * interpolated per component, so Euler rotations follow the exact numbers the
 * user typed (0 -> 360 is a full spin) instead of a shortest-path quaternion.
 */
export function evaluate<T extends number | readonly number[]>(track: Track<T>, t: number, fallback: T): T {
  const kfs = track.keyframes;
  if (kfs.length === 0) return fallback;
  const i = segmentIndex(kfs, t);
  if (i < 0) return kfs[0].value;
  if (i === kfs.length - 1) return kfs[i].value;
  const a = kfs[i];
  const b = kfs[i + 1];
  const span = b.time - a.time;
  const p = span > 0 ? ease(a.easing, (t - a.time) / span) : 1;
  return lerpValue(a.value, b.value, p);
}

function lerpValue<T extends number | readonly number[]>(a: T, b: T, p: number): T {
  if (typeof a === 'number') return (a + ((b as number) - a) * p) as T;
  const bv = b as readonly number[];
  return (a as readonly number[]).map((v, k) => v + (bv[k] - v) * p) as unknown as T;
}

/** Time of output frame `n` at `fps`. Computed from n, never accumulated. */
export function frameTime(n: number, fps: number): number {
  return n / fps;
}

export function frameCount(duration: number, fps: number): number {
  return Math.round(duration * fps);
}
