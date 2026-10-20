// Structured edits to a project: the AI can change part of it instead of
// resending the whole JSON. Every patch is applied to a copy and the result is
// validated by the same parser that reads project files, so a bad patch leaves
// the project untouched and names the field that is wrong.

import { newId, getAnimated, type Project, type SceneObject } from './project';
import { parseProject, ProjectFileError } from './schema';

export interface SetOp {
  op: 'set';
  /** JSON Pointer into the project, e.g. "/objects/1/viewport/width". */
  path: string;
  value: unknown;
}

export interface RemoveOp {
  op: 'remove';
  path: string;
}

export interface AddObjectOp {
  op: 'add_object';
  object: unknown;
}

export interface RemoveObjectOp {
  op: 'remove_object';
  id: string;
}

export interface AddKeyframeOp {
  op: 'add_keyframe';
  object_id: string;
  /** position, rotation, scale, opacity, zoom, target or cursor. */
  property: string;
  time: number;
  value: number | number[];
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold';
}

export interface RemoveKeyframeOp {
  op: 'remove_keyframe';
  object_id: string;
  property: string;
  /** Removes the keyframe nearest this time (within one frame). */
  time: number;
}

export interface AddEventOp {
  op: 'add_event';
  /** The cursor object's id. */
  object_id: string;
  kind: 'click' | 'scroll' | 'type' | 'press';
  time: number;
  /** Scroll distance in CSS pixels (scroll). */
  deltaY?: number;
  /** Key name for press, e.g. Enter. */
  key?: string;
  /** Text for type. */
  text?: string;
  /** Characters per second for type. */
  cps?: number;
}

export interface RemoveEventOp {
  op: 'remove_event';
  object_id: string;
  id: string;
}

export type PatchOp =
  | SetOp
  | RemoveOp
  | AddObjectOp
  | RemoveObjectOp
  | AddKeyframeOp
  | RemoveKeyframeOp
  | AddEventOp
  | RemoveEventOp;

const EASINGS = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']);

function fail(message: string): never {
  throw new ProjectFileError(message);
}

/** Splits a JSON Pointer ("/objects/1/url") into its unescaped parts. */
export function pointerParts(path: string): string[] {
  if (typeof path !== 'string' || !path.startsWith('/')) fail('path: expected a JSON Pointer like "/objects/0"');
  if (path === '/') return [];
  return path
    .slice(1)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function at(obj: unknown, parts: string[], path: string): { parent: any; key: string } {
  if (parts.length === 0) fail('path: cannot replace the whole project');
  let parent: any = obj;
  for (const part of parts.slice(0, -1)) {
    const next = Array.isArray(parent) ? parent[Number(part)] : parent?.[part];
    if (next === undefined) fail(`path ${path}: ${part} does not exist`);
    parent = next;
  }
  return { parent, key: parts[parts.length - 1] };
}

function setPointer(root: unknown, path: string, value: unknown): void {
  const { parent, key } = at(root, pointerParts(path), path);
  if (Array.isArray(parent)) {
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i >= parent.length) fail(`path ${path}: bad list index`);
    parent[i] = value;
  } else if (parent && typeof parent === 'object') {
    parent[key] = value;
  } else {
    fail(`path ${path}: ${key} does not exist`);
  }
}

function removePointer(root: unknown, path: string): void {
  const { parent, key } = at(root, pointerParts(path), path);
  if (Array.isArray(parent)) {
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i >= parent.length) fail(`path ${path}: bad list index`);
    parent.splice(i, 1);
  } else if (parent && typeof parent === 'object' && key in parent) {
    delete parent[key];
  } else {
    fail(`path ${path}: ${key} does not exist`);
  }
}

function findObject(project: Project, id: unknown): SceneObject {
  const obj = project.objects.find((o) => o.id === id);
  if (!obj) fail(`No object with id ${String(id)}.`);
  return obj;
}

function animatedFor(obj: SceneObject, property: unknown) {
  const animated = getAnimated(obj, String(property) as Parameters<typeof getAnimated>[1]);
  if (!animated) fail(`${obj.name}: ${String(property)} is not an animatable property of a ${obj.kind}`);
  return animated;
}

/**
 * Applies operations to a copy of `project` and returns the validated result.
 * Throws ProjectFileError, leaving the caller's project alone.
 */
export function applyPatch(project: Project, ops: PatchOp[]): Project {
  if (!Array.isArray(ops) || ops.length === 0) fail('patch: expected a non-empty list of operations');
  const draft = structuredClone(project) as Project;
  ops.forEach((raw, index) => {
    const op = raw as Partial<PatchOp> & { op?: string };
    try {
      switch (op.op) {
        case 'set':
          setPointer(draft, String((op as SetOp).path), (op as SetOp).value);
          break;
        case 'remove':
          removePointer(draft, String((op as RemoveOp).path));
          break;
        case 'add_object':
          draft.objects.push((op as AddObjectOp).object as SceneObject);
          break;
        case 'remove_object': {
          const id = (op as RemoveObjectOp).id;
          const before = draft.objects.length;
          draft.objects = draft.objects.filter((o) => o.id !== id && !(o.kind === 'cursor' && o.targetId === id));
          if (draft.objects.length === before) fail(`No object with id ${String(id)}.`);
          break;
        }
        case 'add_keyframe': {
          const k = op as AddKeyframeOp;
          const animated = animatedFor(findObject(draft, k.object_id), k.property);
          if (k.easing && !EASINGS.has(k.easing)) fail('easing: expected linear, easeIn, easeOut, easeInOut or hold');
          animated.keyframes.push({
            id: newId('k'),
            time: k.time,
            value: k.value as never,
            ...(k.easing ? { easing: k.easing } : {}),
          });
          break;
        }
        case 'remove_keyframe': {
          const k = op as RemoveKeyframeOp;
          const animated = animatedFor(findObject(draft, k.object_id), k.property);
          let nearest: number | null = null;
          animated.keyframes.forEach((frame, i) => {
            if (nearest === null) nearest = i;
            else if (Math.abs(frame.time - k.time) < Math.abs(animated.keyframes[nearest].time - k.time)) nearest = i;
          });
          if (nearest === null) fail('That property has no keyframes.');
          animated.keyframes.splice(nearest, 1);
          break;
        }
        case 'add_event': {
          const k = op as AddEventOp;
          const cursor = findObject(draft, k.object_id);
          if (cursor.kind !== 'cursor') fail(`${cursor.name} is a ${cursor.kind}, not a cursor`);
          if (k.kind === 'click') cursor.clicks.push({ id: newId('click'), time: k.time });
          else if (k.kind === 'scroll')
            cursor.scrolls.push({ id: newId('scroll'), time: k.time, deltaY: k.deltaY ?? 0 });
          else if (k.kind === 'type')
            cursor.keys.push({
              id: newId('type'),
              time: k.time,
              kind: 'type',
              text: String(k.text ?? ''),
              cps: k.cps ?? 12,
            });
          else if (k.kind === 'press')
            cursor.keys.push({ id: newId('key'), time: k.time, kind: 'press', key: (k.key ?? 'Enter') as never });
          else fail('kind: expected click, scroll, type or press');
          break;
        }
        case 'remove_event': {
          const k = op as RemoveEventOp;
          const cursor = findObject(draft, k.object_id);
          if (cursor.kind !== 'cursor') fail(`${cursor.name} is a ${cursor.kind}, not a cursor`);
          const lists = [cursor.clicks, cursor.scrolls, cursor.keys];
          if (!lists.some((l) => l.some((e) => e.id === k.id))) fail(`No event with id ${String(k.id)}.`);
          cursor.clicks = cursor.clicks.filter((e) => e.id !== k.id);
          cursor.scrolls = cursor.scrolls.filter((e) => e.id !== k.id);
          cursor.keys = cursor.keys.filter((e) => e.id !== k.id);
          break;
        }
        default:
          fail(`patch[${index}]: unknown operation ${String(op.op)}`);
      }
    } catch (err) {
      if (err instanceof ProjectFileError) throw new ProjectFileError(`patch[${index}] ${err.message}`);
      throw err;
    }
  });
  // The same parser used for project files: sorts keyframes and checks everything.
  return parseProject(JSON.stringify(draft));
}
