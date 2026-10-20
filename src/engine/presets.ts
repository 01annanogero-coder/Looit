// One-click animations. A preset writes keyframes over [start, start + duration]
// and replaces any keyframes already in that window for the properties it
// animates. "Rest" values are the object's values at the playhead, so an
// entrance ends exactly where the object already is.

import type { Easing, Keyframe, Vec3 } from './animation';
import { newId, sample, type Animated, type CameraObject, type TransformObject } from './project';

export type ObjectPreset = 'fadeIn' | 'fadeOut' | 'flyIn' | 'slideIn' | 'pop' | 'popOut';
export type CameraPreset = 'zoomIn' | 'zoomOut' | 'pushIn' | 'pullOut' | 'panLeft' | 'panRight' | 'rise';

export const OBJECT_PRESETS: { value: ObjectPreset; label: string }[] = [
  { value: 'fadeIn', label: 'Fade in' },
  { value: 'fadeOut', label: 'Fade out' },
  { value: 'flyIn', label: 'Fly in' },
  { value: 'slideIn', label: 'Slide in' },
  { value: 'pop', label: 'Pop in' },
  { value: 'popOut', label: 'Pop out' },
];

export const CAMERA_PRESETS: { value: CameraPreset; label: string }[] = [
  { value: 'zoomIn', label: 'Zoom in' },
  { value: 'zoomOut', label: 'Zoom out' },
  { value: 'pushIn', label: 'Push in' },
  { value: 'pullOut', label: 'Pull out' },
  { value: 'panLeft', label: 'Pan left' },
  { value: 'panRight', label: 'Pan right' },
  { value: 'rise', label: 'Rise' },
];

/** Keys as (fraction of the window, value, easing of the segment that starts there). */
type Track<T> = [number, T, Easing?][];

const TIME_EPSILON = 1e-4;

function write<T>(a: Animated<T>, start: number, duration: number, track: Track<T>): void {
  const end = start + duration;
  a.keyframes = a.keyframes.filter((k) => k.time < start - TIME_EPSILON || k.time > end + TIME_EPSILON);
  for (const [f, value, easing] of track) {
    const k: Keyframe<T> = { id: newId('k'), time: start + f * duration, value };
    if (easing && easing !== 'linear') k.easing = easing;
    a.keyframes.push(k);
  }
  a.keyframes.sort((x, y) => x.time - y.time);
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scaled = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export function applyObjectPreset(o: TransformObject, preset: ObjectPreset, start: number, duration: number): void {
  const t = o.transform;
  const pos = sample(t.position, start);
  const scale = sample(t.scale, start);
  const sampled = sample(t.opacity, start);
  // Fading in something already invisible should end fully visible.
  const opacity = sampled < 0.01 ? 1 : sampled;
  switch (preset) {
    case 'fadeIn':
      write(t.opacity, start, duration, [
        [0, 0, 'easeInOut'],
        [1, opacity],
      ]);
      break;
    case 'fadeOut':
      write(t.opacity, start, duration, [
        [0, opacity, 'easeInOut'],
        [1, 0],
      ]);
      break;
    case 'flyIn':
      write(t.position, start, duration, [
        [0, add(pos, [0, -6, 4]), 'easeOut'],
        [1, pos],
      ]);
      write(t.opacity, start, duration, [
        [0, 0, 'easeOut'],
        [0.5, opacity],
        [1, opacity],
      ]);
      break;
    case 'slideIn':
      write(t.position, start, duration, [
        [0, add(pos, [-24, 0, 0]), 'easeOut'],
        [1, pos],
      ]);
      break;
    case 'pop':
      write(t.scale, start, duration, [
        [0, scaled(scale, 0.6), 'easeOut'],
        [0.7, scaled(scale, 1.06), 'easeInOut'],
        [1, scale],
      ]);
      write(t.opacity, start, duration, [
        [0, 0, 'easeOut'],
        [0.4, opacity],
        [1, opacity],
      ]);
      break;
    case 'popOut':
      write(t.scale, start, duration, [
        [0, scale, 'easeInOut'],
        [0.3, scaled(scale, 1.06), 'easeIn'],
        [1, scaled(scale, 0.6)],
      ]);
      write(t.opacity, start, duration, [
        [0, opacity],
        [0.6, opacity, 'easeIn'],
        [1, 0],
      ]);
      break;
  }
}

export function applyCameraPreset(c: CameraObject, preset: CameraPreset, start: number, duration: number): void {
  const pos = sample(c.position, start);
  const target = sample(c.target, start);
  const zoom = sample(c.zoom, start);
  const move = (to: Vec3, toTarget: Vec3) => {
    write(c.position, start, duration, [
      [0, pos, 'easeInOut'],
      [1, to],
    ]);
    write(c.target, start, duration, [
      [0, target, 'easeInOut'],
      [1, toTarget],
    ]);
  };
  switch (preset) {
    case 'zoomIn':
      write(c.zoom, start, duration, [
        [0, zoom, 'easeInOut'],
        [1, Math.min(zoom * 1.5, 20)],
      ]);
      break;
    case 'zoomOut':
      write(c.zoom, start, duration, [
        [0, zoom, 'easeInOut'],
        [1, Math.max(zoom / 1.5, 0.1)],
      ]);
      break;
    case 'pushIn':
      write(c.position, start, duration, [
        [0, pos, 'easeInOut'],
        [1, lerp3(pos, target, 0.35)],
      ]);
      break;
    case 'pullOut':
      write(c.position, start, duration, [
        [0, pos, 'easeInOut'],
        [1, lerp3(pos, target, -0.35)],
      ]);
      break;
    case 'panLeft':
      move(add(pos, [-4, 0, 0]), add(target, [-4, 0, 0]));
      break;
    case 'panRight':
      move(add(pos, [4, 0, 0]), add(target, [4, 0, 0]));
      break;
    case 'rise':
      write(c.position, start, duration, [
        [0, pos, 'easeInOut'],
        [1, add(pos, [0, 4, 0])],
      ]);
      break;
  }
}
