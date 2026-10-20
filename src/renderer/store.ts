// Editor state. The project is immutable data: every change goes through
// `edit`, which produces a new project (Immer) and records undo history.

import { produce, type Draft } from 'immer';
import { create } from 'zustand';
import { snapTime } from '../engine/edit';
import { newProject, type Project, type PropName } from '../engine/project';

/** Timed cursor events (not keyframes) shown in the timeline. */
export type CursorEventProp = 'clicks' | 'scrolls' | 'keys';
export const CURSOR_EVENT_PROPS: readonly CursorEventProp[] = ['clicks', 'scrolls', 'keys'];

export function isCursorEventProp(p: string): p is CursorEventProp {
  return (CURSOR_EVENT_PROPS as readonly string[]).includes(p);
}

export type Tool = 'select' | 'interact' | 'cursor';
export type GizmoMode = 'translate' | 'rotate' | 'scale';

/** A keyframe (or cursor event, prop 'clicks'/'scrolls') selected in the timeline. */
export interface KeyRef {
  objectId: string;
  prop: PropName | CursorEventProp;
  keyId: string;
}

export interface Status {
  text: string;
  error?: boolean;
}

interface EditorState {
  project: Project;
  /** The project as last saved/opened, for the unsaved-changes indicator. */
  savedProject: Project;
  filePath: string | null;
  selectedId: string | null;
  selectedKeys: KeyRef[];
  time: number;
  playing: boolean;
  tool: Tool;
  gizmo: GizmoMode;
  exporting: boolean;
  status: Status | null;
  past: Project[];
  future: Project[];
  lastMerge: { key: string; at: number } | null;
}

const HISTORY_LIMIT = 200;
/** Edits with the same merge key within this window form one undo step. */
const MERGE_WINDOW_MS = 1000;

const initial = newProject();

export const useEditor = create<EditorState>(() => ({
  project: initial,
  savedProject: initial,
  filePath: null,
  selectedId: initial.objects.find((o) => o.kind === 'website')?.id ?? null,
  selectedKeys: [],
  time: 0,
  playing: false,
  tool: 'select',
  gizmo: 'translate',
  exporting: false,
  status: null,
  past: [],
  future: [],
  lastMerge: null,
}));

const set = useEditor.setState;
const get = useEditor.getState;

/**
 * Changes the project. Continuous gestures (dragging a gizmo or a number)
 * pass a `mergeKey` so the whole drag is a single undo step.
 */
export function edit(recipe: (draft: Draft<Project>) => void, mergeKey?: string): void {
  const s = get();
  if (s.exporting) return;
  const next = produce(s.project, recipe);
  if (next === s.project) return;
  const now = Date.now();
  const merge = !!mergeKey && s.lastMerge?.key === mergeKey && now - s.lastMerge.at < MERGE_WINDOW_MS;
  set({
    project: next,
    past: merge ? s.past : [...s.past, s.project].slice(-HISTORY_LIMIT),
    future: [],
    lastMerge: mergeKey ? { key: mergeKey, at: now } : null,
  });
}

/** Ends a continuous gesture so the next edit starts a new undo step. */
export function endGesture(): void {
  set({ lastMerge: null });
}

export function undo(): void {
  const s = get();
  const prev = s.past.at(-1);
  if (!prev || s.exporting) return;
  set({ project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future], lastMerge: null });
  pruneSelection();
}

export function redo(): void {
  const s = get();
  const next = s.future[0];
  if (!next || s.exporting) return;
  set({ project: next, past: [...s.past, s.project], future: s.future.slice(1), lastMerge: null });
  pruneSelection();
}

/** Drops selections that no longer exist (after undo, delete, open). */
function pruneSelection(): void {
  const { project, selectedId, selectedKeys } = get();
  const ids = new Set(project.objects.map((o) => o.id));
  set({
    selectedId: selectedId && ids.has(selectedId) ? selectedId : null,
    selectedKeys: selectedKeys.filter((k) => ids.has(k.objectId)),
  });
}

/** Selects an object. Keyframe selection is cleared so Delete acts on the object. */
export function select(id: string | null): void {
  set({ selectedId: id, selectedKeys: [] });
}

export function selectKeys(keys: KeyRef[], additive = false): void {
  const s = get();
  if (!additive) {
    set({ selectedKeys: keys });
    return;
  }
  const same = (a: KeyRef, b: KeyRef) => a.objectId === b.objectId && a.prop === b.prop && a.keyId === b.keyId;
  const toggled = s.selectedKeys.filter((k) => !keys.some((n) => same(n, k)));
  const added = keys.filter((n) => !s.selectedKeys.some((k) => same(n, k)));
  set({ selectedKeys: [...toggled, ...added] });
}

export function setTime(t: number, snap = true): void {
  const { project } = get();
  const clamped = Math.min(Math.max(t, 0), project.duration);
  set({ time: snap ? snapTime(clamped, project.output.fps) : clamped });
}

export function setPlaying(playing: boolean): void {
  const s = get();
  if (playing && s.time >= s.project.duration) set({ time: 0 });
  set({ playing });
}

export function setStatus(status: Status | null): void {
  set({ status });
}

export function loadProject(project: Project, filePath: string | null): void {
  set({
    project,
    savedProject: project,
    filePath,
    selectedId: project.objects.find((o) => o.kind === 'website')?.id ?? null,
    selectedKeys: [],
    time: 0,
    playing: false,
    past: [],
    future: [],
    lastMerge: null,
  });
}

export function markSaved(filePath: string): void {
  set({ savedProject: get().project, filePath });
}

export function isDirty(s: EditorState = get()): boolean {
  return s.project !== s.savedProject;
}

export { get as getEditor, set as setEditor };
