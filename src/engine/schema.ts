// Validation for project files read from disk. Files can be hand-edited,
// truncated or from a newer version, so everything is checked before use.

import type { Keyframe } from './animation';
import {
  PROJECT_FORMAT,
  PROJECT_VERSION,
  type Animated,
  CURSOR_STYLES,
  SPECIAL_KEYS,
  MAX_BACKGROUND_IMAGE_CHARS,
  newCamera,
  type Environment,
  type CameraObject,
  type CursorKeys,
  type CursorStyle,
  type PanelBorder,
  type WindowFrame,
  type CursorObject,
  type SpecialKey,
  type Project,
  type SceneObject,
  type Shadow,
  type TextObject,
  type Transform,
  type WebsiteObject,
} from './project';

/** Longest supported video: 4 hours. */
export const MAX_DURATION = 4 * 3600;

export class ProjectFileError extends Error {}

type Path = string;

function fail(path: Path, msg: string): never {
  throw new ProjectFileError(`${path}: ${msg}`);
}

function obj(v: unknown, path: Path): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'expected an object');
  return v as Record<string, unknown>;
}

function num(v: unknown, path: Path, min = -1e6, max = 1e6): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    fail(path, `expected a number between ${min} and ${max}`);
  return v;
}

function str(v: unknown, path: Path, maxLength = 10_000): string {
  if (typeof v !== 'string' || v.length > maxLength) fail(path, 'expected text');
  return v;
}

function bool(v: unknown, path: Path): boolean {
  if (typeof v !== 'boolean') fail(path, 'expected true or false');
  return v;
}

function color(v: unknown, path: Path): string {
  const s = str(v, path, 16);
  if (!/^#[0-9a-f]{6}$/i.test(s)) fail(path, 'expected a color like #1a2b3c');
  return s;
}

function arr(v: unknown, path: Path, max = 10_000): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail(path, 'expected a list');
  return v;
}

function tuple(v: unknown, path: Path, n: number): number[] {
  const a = arr(v, path, n);
  if (a.length !== n) fail(path, `expected ${n} numbers`);
  return a.map((x, i) => num(x, `${path}[${i}]`));
}

const EASINGS = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']);

function animated<T>(v: unknown, path: Path, parseValue: (v: unknown, p: Path) => T): Animated<T> {
  const o = obj(v, path);
  const keyframes = arr(o.keyframes, `${path}.keyframes`).map((k, i): Keyframe<T> => {
    const kp = `${path}.keyframes[${i}]`;
    const ko = obj(k, kp);
    if (ko.easing !== undefined && !EASINGS.has(ko.easing as string)) fail(`${kp}.easing`, 'unknown easing');
    return {
      id: str(ko.id, `${kp}.id`, 100),
      time: num(ko.time, `${kp}.time`, 0, MAX_DURATION),
      value: parseValue(ko.value, `${kp}.value`),
      ...(ko.easing ? { easing: ko.easing as Keyframe<T>['easing'] } : {}),
    };
  });
  keyframes.sort((a, b) => a.time - b.time);
  return { value: parseValue(o.value, `${path}.value`), keyframes };
}

const vec3 = (v: unknown, p: Path) => tuple(v, p, 3) as [number, number, number];
const vec2 = (v: unknown, p: Path) => tuple(v, p, 2) as [number, number];

function transform(v: unknown, path: Path): Transform {
  const o = obj(v, path);
  return {
    position: animated(o.position, `${path}.position`, vec3),
    rotation: animated(o.rotation, `${path}.rotation`, vec3),
    scale: animated(o.scale, `${path}.scale`, vec3),
    opacity: animated(o.opacity, `${path}.opacity`, (x, p) => num(x, p, 0, 1)),
  };
}

function shadow(v: unknown, path: Path): Shadow {
  const o = obj(v, path);
  return {
    enabled: bool(o.enabled, `${path}.enabled`),
    color: color(o.color, `${path}.color`),
    opacity: num(o.opacity, `${path}.opacity`, 0, 1),
    blur: num(o.blur, `${path}.blur`, 0, 10),
    // Added later: older files keep the original drop.
    offsetY: o.offsetY === undefined ? -0.35 : num(o.offsetY, `${path}.offsetY`, -10, 10),
  };
}

function windowFrame(v: unknown, path: Path): WindowFrame {
  if (v === undefined) return 'none';
  if (v !== 'none' && v !== 'light' && v !== 'dark') fail(path, 'expected none, light or dark');
  return v;
}

function panelBorder(v: unknown, path: Path): PanelBorder {
  if (v === undefined) return { width: 0, color: '#ffffff' };
  const o = obj(v, path);
  return { width: num(o.width, `${path}.width`, 0, 200), color: color(o.color, `${path}.color`) };
}

function websiteUrl(v: unknown, path: Path, allowFile: boolean): string {
  const s = str(v, path, 4096);
  try {
    const { protocol } = new URL(s);
    if (protocol !== 'http:' && protocol !== 'https:' && !(allowFile && protocol === 'file:'))
      fail(path, 'only http and https addresses are allowed');
  } catch (e) {
    if (e instanceof ProjectFileError) throw e;
    fail(path, 'not a valid web address');
  }
  return s;
}

function cursorKeys(v: unknown, path: Path): CursorKeys {
  const o = obj(v, path);
  const id = str(o.id, `${path}.id`, 100);
  const time = num(o.time, `${path}.time`, 0, MAX_DURATION);
  if (o.kind === 'type') {
    return { id, time, kind: 'type', text: str(o.text, `${path}.text`, 5000), cps: num(o.cps, `${path}.cps`, 1, 100) };
  }
  if (o.kind === 'press') {
    if (!(SPECIAL_KEYS as readonly unknown[]).includes(o.key)) fail(`${path}.key`, 'unknown key');
    return { id, time, kind: 'press', key: o.key as SpecialKey };
  }
  return fail(`${path}.kind`, 'expected "type" or "press"');
}

function environment(v: unknown, path: Path): Environment {
  const o = obj(v, path);
  const oneOf = <T extends string>(x: unknown, p: Path, options: readonly T[]): T => {
    if (!options.includes(x as T)) fail(p, `expected one of ${options.join(', ')}`);
    return x as T;
  };
  let image: string | null = null;
  if (o.image !== null && o.image !== undefined) {
    image = str(o.image, `${path}.image`, MAX_BACKGROUND_IMAGE_CHARS);
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
      fail(`${path}.image`, 'expected an embedded PNG, JPEG or WebP image');
    }
  }
  return {
    background: oneOf(o.background, `${path}.background`, ['solid', 'gradient', 'image'] as const),
    gradientTo: color(o.gradientTo, `${path}.gradientTo`),
    gradientAngle: num(o.gradientAngle, `${path}.gradientAngle`, -360, 360),
    image,
    floor: oneOf(o.floor, `${path}.floor`, ['none', 'reflection', 'grid'] as const),
    floorY: num(o.floorY, `${path}.floorY`, -100, 100),
    floorColor: color(o.floorColor, `${path}.floorColor`),
  };
}

function sceneObject(v: unknown, path: Path, allowFile: boolean): SceneObject {
  const o = obj(v, path);
  const base = {
    id: str(o.id, `${path}.id`, 100),
    name: str(o.name, `${path}.name`, 200),
    visible: bool(o.visible, `${path}.visible`),
  };
  switch (o.kind) {
    case 'website': {
      const vp = obj(o.viewport, `${path}.viewport`);
      const w: WebsiteObject = {
        ...base,
        kind: 'website',
        url: websiteUrl(o.url, `${path}.url`, allowFile),
        viewport: {
          width: Math.round(num(vp.width, `${path}.viewport.width`, 320, 3840)),
          height: Math.round(num(vp.height, `${path}.viewport.height`, 240, 2160)),
        },
        interactive: bool(o.interactive, `${path}.interactive`),
        transform: transform(o.transform, `${path}.transform`),
        shadow: shadow(o.shadow, `${path}.shadow`),
        frame: windowFrame(o.frame, `${path}.frame`),
        cornerRadius: o.cornerRadius === undefined ? 0 : num(o.cornerRadius, `${path}.cornerRadius`, 0, 400),
        border: panelBorder(o.border, `${path}.border`),
      };
      return w;
    }
    case 'text': {
      if (![400, 600, 700].includes(o.weight as number)) fail(`${path}.weight`, 'expected 400, 600 or 700');
      const t: TextObject = {
        ...base,
        kind: 'text',
        text: str(o.text, `${path}.text`, 2000),
        size: num(o.size, `${path}.size`, 0.05, 20),
        color: color(o.color, `${path}.color`),
        weight: o.weight as TextObject['weight'],
        transform: transform(o.transform, `${path}.transform`),
      };
      return t;
    }
    case 'cursor': {
      const c: CursorObject = {
        ...base,
        kind: 'cursor',
        targetId: str(o.targetId, `${path}.targetId`, 100),
        position: animated(o.position, `${path}.position`, vec2),
        size: num(o.size, `${path}.size`, 0.05, 5),
        style:
          o.style === undefined
            ? 'arrow'
            : (CURSOR_STYLES as readonly unknown[]).includes(o.style)
              ? (o.style as CursorStyle)
              : fail(`${path}.style`, 'unknown cursor style'),
        clickColor: o.clickColor === undefined ? '#3b82f6' : color(o.clickColor, `${path}.clickColor`),
        clicks: arr(o.clicks, `${path}.clicks`).map((c, i) => {
          const co = obj(c, `${path}.clicks[${i}]`);
          return {
            id: str(co.id, `${path}.clicks[${i}].id`, 100),
            time: num(co.time, `${path}.clicks[${i}].time`, 0, MAX_DURATION),
          };
        }),
        scrolls: arr(o.scrolls, `${path}.scrolls`).map((s, i) => {
          const so = obj(s, `${path}.scrolls[${i}]`);
          return {
            id: str(so.id, `${path}.scrolls[${i}].id`, 100),
            time: num(so.time, `${path}.scrolls[${i}].time`, 0, MAX_DURATION),
            deltaY: num(so.deltaY, `${path}.scrolls[${i}].deltaY`, -100_000, 100_000),
          };
        }),
        // Optional: files from before typing existed have none.
        keys:
          o.keys === undefined ? [] : arr(o.keys, `${path}.keys`).map((k, i) => cursorKeys(k, `${path}.keys[${i}]`)),
      };
      return c;
    }
    case 'camera': {
      const cam: CameraObject = {
        ...base,
        kind: 'camera',
        position: animated(o.position, `${path}.position`, vec3),
        target: animated(o.target, `${path}.target`, vec3),
        zoom: animated(o.zoom, `${path}.zoom`, (x, p) => num(x, p, 0.1, 20)),
      };
      return cam;
    }
    default:
      return fail(`${path}.kind`, 'unknown object type');
  }
}

/** Parses and validates a project file. Throws ProjectFileError with a readable location. */
export interface ParseOptions {
  /** Allow file:// website addresses (development self-test only). */
  allowFileUrls?: boolean;
}

export function parseProject(text: string, options: ParseOptions = {}): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProjectFileError('This file is not a Looit project (it is not valid JSON).');
  }
  const o = obj(data, 'project');
  if (o.format !== PROJECT_FORMAT) throw new ProjectFileError('This file is not a Looit project.');
  if (typeof o.version !== 'number' || o.version > PROJECT_VERSION)
    throw new ProjectFileError('This project was made with a newer version of Looit. Please update the app.');
  const out = obj(o.output, 'project.output');
  const fps = num(out.fps, 'project.output.fps');
  if (fps !== 30 && fps !== 60) fail('project.output.fps', 'expected 30 or 60');
  const objects = arr(o.objects, 'project.objects', 200).map((x, i) =>
    sceneObject(x, `project.objects[${i}]`, !!options.allowFileUrls),
  );
  const ids = new Set<string>();
  for (const ob of objects) {
    if (ids.has(ob.id)) fail('project.objects', `duplicate object id ${ob.id}`);
    ids.add(ob.id);
  }
  // Projects from before the camera could move get the same fixed camera they had.
  const cameras = objects.filter((ob) => ob.kind === 'camera').length;
  if (cameras > 1) fail('project.objects', 'only one camera is allowed');
  if (cameras === 0) objects.unshift(newCamera());
  for (const ob of objects) {
    if (ob.kind === 'cursor' && !objects.some((t) => t.id === ob.targetId && t.kind === 'website'))
      fail(`cursor ${ob.name}`, 'its website panel is missing');
  }
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: str(o.name, 'project.name', 200),
    duration: num(o.duration, 'project.duration', 0.5, MAX_DURATION),
    output: {
      width: Math.round(num(out.width, 'project.output.width', 320, 3840)),
      height: Math.round(num(out.height, 'project.output.height', 240, 2160)),
      fps,
      ...(out.skipUnchangedFrames !== undefined
        ? { skipUnchangedFrames: bool(out.skipUnchangedFrames, 'project.output.skipUnchangedFrames') }
        : {}),
    },
    background: color(o.background, 'project.background'),
    ...(o.environment !== undefined ? { environment: environment(o.environment, 'project.environment') } : {}),
    objects,
  };
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2);
}
