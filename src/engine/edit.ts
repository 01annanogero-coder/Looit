// Editing operations on animated values. They mutate in place so they work on
// both plain objects (tests) and Immer drafts (the editor store).

import type { Keyframe } from './animation';
import { newId, sample, type Animated } from './project';

/** Keyframes closer than this (seconds) are considered the same time. */
const TIME_EPSILON = 1e-4;

export function snapTime(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

export function keyframeAt<T>(a: Animated<T>, time: number): Keyframe<T> | undefined {
  return a.keyframes.find((k) => Math.abs(k.time - time) < TIME_EPSILON);
}

function sortKeys<T>(a: Animated<T>): void {
  a.keyframes.sort((x, y) => x.time - y.time);
}

/** Adds or replaces the keyframe at `time`. */
export function upsertKeyframe<T>(a: Animated<T>, time: number, value: T): Keyframe<T> {
  const existing = keyframeAt(a, time);
  if (existing) {
    existing.value = value;
    return existing;
  }
  const easing = a.keyframes.length > 0 ? 'easeInOut' : undefined;
  const k: Keyframe<T> = { id: newId('k'), time, value, ...(easing ? { easing } : {}) };
  a.keyframes.push(k);
  sortKeys(a);
  return k;
}

/**
 * Sets the value the user typed or dragged. Animated properties get a keyframe
 * at the playhead (like After Effects with the stopwatch on); static
 * properties just change their value.
 */
export function setValueAt<T>(a: Animated<T>, time: number, value: T): void {
  if (a.keyframes.length > 0) upsertKeyframe(a, time, value);
  else a.value = value;
}

/** The inspector's diamond button: adds a keyframe at `time`, or removes the one there. */
export function toggleKeyframe<T extends number | readonly number[]>(a: Animated<T>, time: number): void {
  const existing = keyframeAt(a, time);
  if (existing) removeKeyframes(a, new Set([existing.id!]));
  else upsertKeyframe(a, time, sample(a, time));
}

/** Removes keyframes by id. Removing the last one keeps its value as the static value. */
export function removeKeyframes<T>(a: Animated<T>, ids: ReadonlySet<string>): void {
  const removed = a.keyframes.filter((k) => ids.has(k.id!));
  if (removed.length === 0) return;
  a.keyframes = a.keyframes.filter((k) => !ids.has(k.id!));
  if (a.keyframes.length === 0) a.value = removed[removed.length - 1].value;
}

/**
 * Moves keyframes by `dt` seconds, clamped to [0, duration] and snapped to
 * frames. A moved keyframe replaces a stationary one landing on the same time.
 */
export function moveKeyframes<T>(
  a: Animated<T>,
  ids: ReadonlySet<string>,
  dt: number,
  duration: number,
  fps: number,
): void {
  const moved = a.keyframes.filter((k) => ids.has(k.id!));
  if (moved.length === 0) return;
  for (const k of moved) k.time = Math.min(Math.max(snapTime(k.time + dt, fps), 0), duration);
  const movedTimes = moved.map((k) => k.time);
  a.keyframes = a.keyframes.filter(
    (k) => ids.has(k.id!) || !movedTimes.some((t) => Math.abs(t - k.time) < TIME_EPSILON),
  );
  // Two moved keyframes on one time: keep the last.
  const seen = new Map<number, Keyframe<T>>();
  for (const k of a.keyframes) seen.set(Math.round(k.time / TIME_EPSILON), k);
  a.keyframes = [...seen.values()];
  sortKeys(a);
}

/** Times of all keyframes, for "jump to previous/next keyframe". */
export function adjacentTime(times: number[], current: number, direction: 1 | -1): number | undefined {
  const sorted = [...new Set(times)].sort((x, y) => x - y);
  return direction > 0
    ? sorted.find((t) => t > current + TIME_EPSILON)
    : [...sorted].reverse().find((t) => t < current - TIME_EPSILON);
}
