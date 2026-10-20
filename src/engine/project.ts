// Project data model. Everything that affects the rendered video lives here,
// so the same project always evaluates to the same scene in the preview and
// the export. Projects are saved as JSON, so this must stay plain data.

import { evaluate, type Keyframe, type Vec2, type Vec3 } from './animation';

export const PROJECT_FORMAT = 'looit-project';
export const PROJECT_VERSION = 1;

/** A value that is either static (`value`) or animated by keyframes. */
export interface Animated<T> {
  value: T;
  /** Sorted by time. When non-empty, keyframes override `value`. */
  keyframes: Keyframe<T>[];
}

export interface Transform {
  /** World units. A 16:9 website panel at scale 1 is 16 x 9 units. */
  position: Animated<Vec3>;
  /** Euler degrees, XYZ order. */
  rotation: Animated<Vec3>;
  scale: Animated<Vec3>;
  /** 0..1 */
  opacity: Animated<number>;
}

export interface Shadow {
  enabled: boolean;
  color: string;
  opacity: number;
  /** Softness in world units. */
  blur: number;
  /** How far the shadow drops below the panel, world units. 0 with a bright colour makes a glow. */
  offsetY: number;
}

/** Browser window drawn around a website panel. */
export type WindowFrame = 'none' | 'light' | 'dark';

export interface PanelBorder {
  /** Website CSS pixels (scales with the panel). */
  width: number;
  color: string;
}

interface ObjectBase {
  id: string;
  name: string;
  visible: boolean;
}

export interface WebsiteObject extends ObjectBase {
  kind: 'website';
  url: string;
  /** CSS pixel size of the website's browser viewport. */
  viewport: { width: number; height: number };
  /** Whether the user can click/scroll the live site in the viewport. */
  interactive: boolean;
  transform: Transform;
  shadow: Shadow;
  /** Browser window bar above the page (traffic lights and address bar). */
  frame: WindowFrame;
  /** Corner radius in website CSS pixels. */
  cornerRadius: number;
  border: PanelBorder;
}

/** Where a text overlay lives: in the 3D scene, or pinned to the video frame (HUD). */
export type TextSpace = 'world' | 'screen';

/** A rounded pill drawn behind text so it stays readable over any page. */
export interface TextBackground {
  color: string;
  opacity: number;
  /** Padding around the text, in text heights (0.3 = 30% of a line). */
  padding: number;
  /** Corner radius, in text heights. */
  radius: number;
}

export interface TextShadow {
  color: string;
  opacity: number;
  /** Offset in text heights. */
  offsetX: number;
  offsetY: number;
  /** Softness in text heights (0 = hard edge). */
  blur: number;
}

export interface TextObject extends ObjectBase {
  kind: 'text';
  text: string;
  /** Line height: world units in world space, a fraction of the frame height in screen space. */
  size: number;
  color: string;
  weight: 400 | 600 | 700;
  /** 'world' (default) puts the text in the scene; 'screen' pins it to the frame. */
  space?: TextSpace;
  /** Screen-space anchor in 0..1 of the frame (0,0 = top-left). Default: centre. */
  screen?: { x: number; y: number };
  /** Optional pill behind the text. */
  background?: TextBackground | null;
  /** Optional drop shadow. */
  shadow?: TextShadow | null;
  /** Used in world space; screen text only animates opacity. */
  transform: Transform;
}

export interface CursorClick {
  id: string;
  time: number;
}

export interface CursorScroll {
  id: string;
  time: number;
  /** CSS pixels; positive scrolls the page down. */
  deltaY: number;
}

/** Special keys the cursor can press (named as in KeyboardEvent.key). */
export const SPECIAL_KEYS = [
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
] as const;
export type SpecialKey = (typeof SPECIAL_KEYS)[number];

/**
 * Keyboard input at a time: typing `text` (one character every 1/cps s,
 * starting at `time`), or pressing a special `key`. Goes to whatever has
 * focus on the page, usually the field the cursor clicked.
 */
export type CursorKeys =
  | { id: string; time: number; kind: 'type'; text: string; cps: number }
  | { id: string; time: number; kind: 'press'; key: SpecialKey };

/** Default typing speed, characters per second (a brisk but readable typist). */
export const DEFAULT_TYPING_CPS = 12;

/** When the last character of a typing event is typed. */
export function keysEndTime(k: CursorKeys): number {
  return k.kind === 'type' ? k.time + Math.max(k.text.length - 1, 0) / k.cps : k.time;
}

export const CURSOR_STYLES = ['arrow', 'arrow-white', 'hand', 'ibeam', 'dot'] as const;
export type CursorStyle = (typeof CURSOR_STYLES)[number];

/** The virtual mouse pointer. It lives on a website panel and drives that site. */
export interface CursorObject extends ObjectBase {
  kind: 'cursor';
  targetId: string;
  /** Position on the target website, in website CSS pixels. */
  position: Animated<Vec2>;
  /** Pointer height in world units. */
  size: number;
  /** Keep the pointer the same on-screen size as the camera zooms (default false). */
  fixedScreenSize?: boolean;
  style: CursorStyle;
  /** Colour of the ring shown when the cursor clicks. */
  clickColor: string;
  clicks: CursorClick[];
  scrolls: CursorScroll[];
  keys: CursorKeys[];
}

/**
 * The (single) camera. Fixed unless animated: it looks from `position` at
 * `target`; `zoom` narrows the field of view (2 = everything twice as large).
 */
export interface CameraObject extends ObjectBase {
  kind: 'camera';
  position: Animated<Vec3>;
  target: Animated<Vec3>;
  zoom: Animated<number>;
}

/** Field of view (degrees) at zoom 1. */
export const CAMERA_FOV = 35;
export const DEFAULT_CAMERA_POSITION: Vec3 = [0, 0, 18];

export function newCamera(): CameraObject {
  return {
    id: newId('camera'),
    kind: 'camera',
    name: 'Camera',
    visible: true,
    position: staticValue<Vec3>([...DEFAULT_CAMERA_POSITION]),
    target: staticValue<Vec3>([0, 0, 0]),
    zoom: staticValue(1),
  };
}

export type SceneObject = WebsiteObject | TextObject | CursorObject | CameraObject;
export type TransformObject = WebsiteObject | TextObject;

export function hasTransform(o: SceneObject): o is TransformObject {
  return o.kind === 'website' || o.kind === 'text';
}

export interface Project {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  name: string;
  duration: number;
  output: {
    width: number;
    height: number;
    fps: number;
    /** Reuse the previous website frame when the page provably didn't change (faster). Default true. */
    skipUnchangedFrames?: boolean;
  };
  /** Background colour (also the first gradient colour). */
  background: string;
  /** Optional for files made before environments existed. */
  environment?: Environment;
  objects: SceneObject[];
}

export interface Environment {
  background: 'solid' | 'gradient' | 'image';
  /** Second gradient colour; the first is Project.background. */
  gradientTo: string;
  /** Gradient direction in degrees: 0 = left to right, 90 = top to bottom. */
  gradientAngle: number;
  /** Background image as a data: URL (PNG, JPEG or WebP), or null. */
  image: string | null;
  floor: 'none' | 'reflection' | 'grid';
  /** Floor height in world units (panels are 9 units tall at scale 1). */
  floorY: number;
  floorColor: string;
}

export const DEFAULT_ENVIRONMENT: Environment = {
  background: 'solid',
  gradientTo: '#3b1d6e',
  gradientAngle: 90,
  image: null,
  floor: 'none',
  floorY: -5.2,
  floorColor: '#262b3a',
};

export function environmentOf(p: Project): Environment {
  return p.environment ?? DEFAULT_ENVIRONMENT;
}

/** Largest background image kept in a project file (as a data URL). */
export const MAX_BACKGROUND_IMAGE_CHARS = 12_000_000;

/** Animatable properties, addressed by name for the timeline and inspector. */
export type TransformProp = 'position' | 'rotation' | 'scale' | 'opacity';
export type PropName = TransformProp | 'cursor' | 'target' | 'zoom';

export const TRANSFORM_PROPS: TransformProp[] = ['position', 'rotation', 'scale', 'opacity'];

export function getAnimated(obj: SceneObject, prop: PropName): Animated<number | number[]> | null {
  if (obj.kind === 'camera') {
    if (prop === 'position') return obj.position as Animated<number[]>;
    if (prop === 'target') return obj.target as Animated<number[]>;
    if (prop === 'zoom') return obj.zoom;
    return null;
  }
  if (prop === 'cursor') return obj.kind === 'cursor' ? (obj.position as Animated<number[]>) : null;
  if (prop === 'target' || prop === 'zoom') return null;
  return hasTransform(obj) ? (obj.transform[prop] as Animated<number | number[]>) : null;
}

export function sample<T extends number | readonly number[]>(a: Animated<T>, t: number): T {
  return a.keyframes.length === 0 ? a.value : evaluate(a, t, a.value);
}

// ---- Evaluation ---------------------------------------------------------------

export interface TransformState {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  opacity: number;
}

export function evaluateTransform(t: Transform, time: number): TransformState {
  return {
    position: sample(t.position, time),
    rotation: sample(t.rotation, time),
    scale: sample(t.scale, time),
    opacity: sample(t.opacity, time),
  };
}

export function cameraOf(p: Project): CameraObject {
  return (p.objects.find((o) => o.kind === 'camera') as CameraObject | undefined) ?? FALLBACK_CAMERA;
}

/** Used only if a project somehow has no camera (files are given one when opened). */
const FALLBACK_CAMERA: CameraObject = {
  id: 'camera-fallback',
  kind: 'camera',
  name: 'Camera',
  visible: true,
  position: { value: [0, 0, 18], keyframes: [] },
  target: { value: [0, 0, 0], keyframes: [] },
  zoom: { value: 1, keyframes: [] },
};

export function findObject<K extends SceneObject['kind']>(
  p: Project,
  kind: K,
): Extract<SceneObject, { kind: K }> | undefined {
  return p.objects.find((o) => o.kind === kind) as Extract<SceneObject, { kind: K }> | undefined;
}

/** Cursor events whose time falls in (from, to]. */
export function eventsBetween<E extends { time: number }>(events: E[], from: number, to: number): E[] {
  return events.filter((e) => e.time > from && e.time <= to);
}

// ---- Construction -------------------------------------------------------------

let idCounter = 0;
export function newId(prefix = 'id'): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function staticValue<T>(value: T): Animated<T> {
  return { value, keyframes: [] };
}

function keyed<T>(frames: [number, T, Keyframe<T>['easing']?][]): Animated<T> {
  return {
    value: frames[0][1],
    keyframes: frames.map(([time, value, easing]) => ({ id: newId('k'), time, value, ...(easing ? { easing } : {}) })),
  };
}

export function defaultTransform(): Transform {
  return {
    position: staticValue<Vec3>([0, 0, 0]),
    rotation: staticValue<Vec3>([0, 0, 0]),
    scale: staticValue<Vec3>([1, 1, 1]),
    opacity: staticValue(1),
  };
}

export function newTextObject(text = 'Your headline'): TextObject {
  return {
    id: newId('text'),
    kind: 'text',
    name: 'Text',
    visible: true,
    text,
    size: 1.2,
    color: '#ffffff',
    weight: 700,
    transform: { ...defaultTransform(), position: staticValue<Vec3>([0, 3, 3]) },
  };
}

/**
 * The starting point for a new video: one empty browser card facing the camera,
 * with a resting cursor and no animation. The user points the panel at a site
 * from its URL field; the demo project is the one that starts on electronjs.org.
 */
export function blankProject(): Project {
  const websiteId = newId('website');
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: 'Untitled project',
    duration: 10,
    output: { width: 1280, height: 720, fps: 30 },
    background: '#1b1f2a',
    objects: [
      newCamera(),
      {
        id: websiteId,
        kind: 'website',
        name: 'Website Panel',
        visible: true,
        url: '',
        viewport: { width: 1280, height: 720 },
        interactive: true,
        shadow: { enabled: true, color: '#000000', opacity: 0.5, blur: 1.2, offsetY: -0.35 },
        frame: 'light',
        cornerRadius: 14,
        border: { width: 0, color: '#ffffff' },
        transform: defaultTransform(),
      },
      {
        id: newId('cursor'),
        kind: 'cursor',
        name: 'Cursor',
        visible: true,
        targetId: websiteId,
        size: 0.55,
        style: 'arrow',
        clickColor: '#3b82f6',
        position: staticValue<Vec2>([640, 360]),
        clicks: [],
        scrolls: [],
        keys: [],
      },
    ],
  };
}

/** A new project with a website panel that flies in and a cursor that clicks. */
export function newProject(url = 'https://www.electronjs.org/'): Project {
  const websiteId = newId('website');
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: 'Untitled project',
    duration: 5,
    output: { width: 1280, height: 720, fps: 30 },
    background: '#1b1f2a',
    objects: [
      newCamera(),
      {
        id: websiteId,
        kind: 'website',
        name: 'Website Panel',
        visible: true,
        url,
        viewport: { width: 1280, height: 720 },
        interactive: true,
        shadow: { enabled: true, color: '#000000', opacity: 0.5, blur: 1.2, offsetY: -0.35 },
        frame: 'light',
        cornerRadius: 14,
        border: { width: 0, color: '#ffffff' },
        transform: {
          position: keyed<Vec3>([
            [0, [-3, -1.5, -10], 'easeInOut'],
            [2.5, [0, 0, 0], 'easeInOut'],
            [5, [0, 0, 1.5]],
          ]),
          rotation: keyed<Vec3>([
            [0, [12, 35, -6], 'easeInOut'],
            [2.5, [0, 0, 0]],
          ]),
          scale: keyed<Vec3>([
            [0, [0.6, 0.6, 0.6], 'easeOut'],
            [2.5, [1, 1, 1]],
          ]),
          opacity: staticValue(1),
        },
      },
      {
        id: newId('cursor'),
        kind: 'cursor',
        name: 'Cursor',
        visible: true,
        targetId: websiteId,
        size: 0.55,
        style: 'arrow',
        clickColor: '#3b82f6',
        position: keyed<Vec2>([
          [0, [1100, 650], 'easeInOut'],
          [3, [640, 300], 'easeInOut'],
          [4.2, [640, 300], 'easeInOut'],
          [5, [900, 500]],
        ]),
        clicks: [{ id: newId('click'), time: 3.4 }],
        scrolls: [],
        keys: [],
      },
    ],
  };
}

/** The cursor that drives a website panel (each panel has at most one). */
export function cursorFor(p: Project, websiteId: string): CursorObject | undefined {
  return p.objects.find((o): o is CursorObject => o.kind === 'cursor' && o.targetId === websiteId);
}

export function websites(p: Project): WebsiteObject[] {
  return p.objects.filter((o): o is WebsiteObject => o.kind === 'website');
}

/**
 * A new, static website panel with its own (resting) cursor, placed at
 * `position` and scaled down so it doesn't cover existing panels.
 */
export function newWebsiteWithCursor(url: string, name: string, position: Vec3): [WebsiteObject, CursorObject] {
  const id = newId('website');
  const website: WebsiteObject = {
    id,
    kind: 'website',
    name,
    visible: true,
    url,
    viewport: { width: 1280, height: 720 },
    interactive: true,
    shadow: { enabled: true, color: '#000000', opacity: 0.5, blur: 1.2, offsetY: -0.35 },
    frame: 'light',
    cornerRadius: 14,
    border: { width: 0, color: '#ffffff' },
    transform: {
      ...defaultTransform(),
      position: staticValue<Vec3>(position),
      scale: staticValue<Vec3>([0.6, 0.6, 0.6]),
    },
  };
  const cursor: CursorObject = {
    id: newId('cursor'),
    kind: 'cursor',
    name: `${name} cursor`,
    visible: false,
    targetId: id,
    size: 0.55,
    style: 'arrow',
    clickColor: '#3b82f6',
    position: staticValue<Vec2>([640, 360]),
    clicks: [],
    scrolls: [],
    keys: [],
  };
  return [website, cursor];
}
