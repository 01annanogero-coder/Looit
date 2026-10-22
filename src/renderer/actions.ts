// User-level commands shared by menus, buttons and keyboard shortcuts.

import { create } from 'zustand';
import {
  adjacentTime,
  keyframeAt,
  moveKeyframes,
  removeKeyframes,
  setValueAt,
  toggleKeyframe,
  upsertKeyframe,
} from '../engine/edit';
import {
  cursorFor,
  environmentOf,
  getAnimated,
  hasTransform,
  newId,
  newWebsiteWithCursor,
  websites,
  newTextObject,
  sample,
  TRANSFORM_PROPS,
  type Environment,
  type Project,
  type PropName,
  type SceneObject,
} from '../engine/project';
import { applyCameraPreset, applyObjectPreset, type CameraPreset, type ObjectPreset } from '../engine/presets';
import { ProjectFileError, parseProject, serializeProject } from '../engine/schema';
import { exportVideo } from './exporter';
import {
  edit,
  getEditor,
  isDirty,
  loadProject,
  markSaved,
  select,
  selectKeys,
  setEditor,
  setPlaying,
  setPreviewFullscreen,
  setStatus,
  setTime,
  setView,
  isCursorEventProp,
  type KeyRef,
} from './store';
import { currentRenderer, interactTarget, siteTexture, view } from './viewport/runtime';

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---- Preview --------------------------------------------------------------------

/**
 * Plays the project from the start with the 3D view filling the screen. The
 * animation loops until Esc (or leaving full screen). Fullscreen is
 * best-effort: without a user gesture the browser refuses it, and the viewport
 * still fills the window.
 */
export function openPreview(): void {
  if (getEditor().exporting) return;
  setPlaying(false);
  setTime(0);
  // Interact mode would let the page run on its own clock instead of the timeline.
  setEditor({ tool: 'select' });
  setPreviewFullscreen(true);
  setPlaying(true);
  void document.documentElement.requestFullscreen?.().catch(() => undefined);
}

/** Leaves the full-screen preview and stops playback. */
export function closePreview(): void {
  if (!getEditor().previewFullscreen) return;
  setPlaying(false);
  setPreviewFullscreen(false);
  if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
}

// ---- Files ----------------------------------------------------------------------

function confirmDiscard(): boolean {
  return !isDirty() || window.confirm('You have unsaved changes. Discard them?');
}

export function newFile(): void {
  // Projects start on the onboarding screen, where they are named and get a file.
  void goHome();
}

export async function openFile(): Promise<void> {
  if (!confirmDiscard()) return;
  try {
    const opened = await window.looit.project.open();
    if (!opened) return;
    loadProject(parseProject(opened.text), opened.path);
    setStatus({ text: `Opened ${opened.path}` });
  } catch (err) {
    const prefix = err instanceof ProjectFileError ? 'Could not open project — ' : 'Could not open project: ';
    setStatus({ text: prefix + errorText(err), error: true });
  }
}

export async function saveFile(saveAs = false): Promise<boolean> {
  const { project, filePath } = getEditor();
  try {
    const saved = await window.looit.project.save(serializeProject(project), saveAs ? null : filePath, project.name);
    if (!saved) return false;
    // Only mark saved if nothing changed while the dialog was open.
    if (getEditor().project === project) markSaved(saved);
    else setEditor({ filePath: saved });
    setStatus({ text: `Saved ${saved}` });
    return true;
  } catch (err) {
    setStatus({ text: `Could not save: ${errorText(err)}`, error: true });
    return false;
  }
}

/** Writes run one at a time so two quick edits can't race on disk. */
let saveChain: Promise<unknown> = Promise.resolve();

/**
 * Writes the open project to its file when it has one. Used by autosave after
 * every change and before leaving the editor; the Save dialog is not involved.
 */
export function savePending(): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const s = getEditor();
    if (!s.filePath || s.project === s.savedProject || s.exporting) return true;
    const project = s.project;
    try {
      const saved = await window.looit.project.save(serializeProject(project), s.filePath, project.name);
      if (!saved) return false;
      // Only mark saved if nothing changed while the write was in flight.
      if (getEditor().project === project) markSaved(saved);
      else setEditor({ filePath: saved });
      void window.looit.library.noteSaved(saved, project.name);
      return true;
    } catch (err) {
      setStatus({ text: `Could not save: ${errorText(err)}`, error: true });
      return false;
    }
  };
  const next = saveChain.then(run, run);
  saveChain = next.catch(() => undefined);
  return next;
}

/**
 * The window is closing with unsaved changes and the user chose "Save and close".
 * Resolves true only when nothing unsaved is left (a project without a file asks where to save).
 */
export async function saveBeforeClose(): Promise<boolean> {
  if (!getEditor().filePath) await saveFile(true);
  else await savePending();
  return !isDirty(getEditor());
}

/** Back to the project library, saving the open project first. */
export async function goHome(): Promise<void> {
  await savePending();
  setView('home');
}

/** Opens a project that came from the onboarding library. */
export function openLibraryProject(text: string, path: string | null): void {
  loadProject(parseProject(text), path);
}

/** Changes the scene environment (background and floor). */
export function setEnvironment(patch: Partial<Environment>, group?: string): void {
  edit((p) => {
    p.environment = { ...environmentOf(p), ...patch };
  }, group);
}

export async function pickBackgroundImage(): Promise<void> {
  try {
    const image = await window.looit.project.pickImage();
    if (image) setEnvironment({ background: 'image', image });
  } catch (err) {
    setStatus({ text: `Could not use that image: ${errorText(err)}`, error: true });
  }
}

/** Adds a preset animation to an object (or the camera), starting at the playhead. */
export function applyPreset(id: string, preset: ObjectPreset | CameraPreset, label: string, duration: number): void {
  const { project, time } = getEditor();
  const length = Math.min(duration, project.duration - time);
  if (length < 1 / project.output.fps) {
    setStatus({ text: 'Move the playhead earlier: a preset starts at the playhead.', error: true });
    return;
  }
  edit((p) => {
    const o = p.objects.find((x) => x.id === id);
    if (o?.kind === 'camera') applyCameraPreset(o, preset as CameraPreset, time, length);
    else if (o && hasTransform(o)) applyObjectPreset(o, preset as ObjectPreset, time, length);
  });
  setStatus({ text: `${label} added from ${time.toFixed(2)} s to ${(time + length).toFixed(2)} s` });
}

/**
 * Interact mode: adds a scroll at the playhead that takes the page to where the
 * user scrolled it, then returns to the timeline so the scroll is replayed.
 */
export async function scrollToHere(): Promise<void> {
  const websiteId = interactTarget();
  const { project, time } = getEditor();
  const cursor = websiteId ? cursorFor(project, websiteId) : undefined;
  if (getEditor().tool !== 'interact' || !websiteId || !cursor) return;
  let measured;
  try {
    measured = await window.looit.site.scrollSinceInteract(websiteId);
  } catch (err) {
    setStatus({ text: `Could not measure the scroll: ${errorText(err)}`, error: true });
    return;
  }
  if ('error' in measured) {
    setStatus({ text: measured.error, error: true });
    return;
  }
  if (measured.deltaY === 0) {
    setStatus({
      text: 'The page is where the timeline already has it. Scroll the page first, then press Scroll to here.',
    });
    return;
  }
  let total = 0;
  edit((p) => {
    const c = p.objects.find((o) => o.id === cursor.id);
    if (c?.kind !== 'cursor') return;
    // A scroll already at the playhead was measured as part of the start point: add to it.
    const existing = c.scrolls.find((k) => Math.abs(k.time - time) < 1e-4);
    if (existing) existing.deltaY = total = existing.deltaY + measured.deltaY;
    else c.scrolls.push({ id: newId('scroll'), time, deltaY: (total = measured.deltaY) });
  });
  setEditor({ tool: 'select' });
  select(cursor.id);
  setStatus({
    text: `Scroll of ${total} px at ${time.toFixed(2)} s. Play or move the playhead past it to see the page land.`,
  });
}

// ---- Objects --------------------------------------------------------------------

export function addText(): void {
  const text = newTextObject();
  edit((p) => {
    p.objects.push(text);
  });
  select(text.id);
}

/** Adds a website panel (with its own cursor) beside the existing ones. */
export function addWebsite(): void {
  const count = websites(getEditor().project).length;
  // Alternate right/left of the centre, a little in front, so panels don't overlap.
  const side = count % 2 === 1 ? 1 : -1;
  const x = side * 6 * Math.ceil(count / 2);
  const [website, cursor] = newWebsiteWithCursor('https://example.com/', `Website ${count + 1}`, [x, -1, 1]);
  edit((p) => {
    p.objects.push(website, cursor);
  });
  select(website.id);
  setStatus({ text: 'Website panel added: set its address in Properties → Website Panel' });
}

/**
 * Deletes selected keyframes if any, otherwise the selected object: text, or a
 * website panel together with its cursor (the last panel can't be deleted).
 */
export function deleteSelection(): void {
  const { selectedKeys, selectedId, project } = getEditor();
  if (selectedKeys.length > 0) {
    deleteKeys(selectedKeys);
    return;
  }
  const obj = project.objects.find((o) => o.id === selectedId);
  if (obj?.kind === 'text') {
    edit((p) => {
      p.objects = p.objects.filter((o) => o.id !== obj.id);
    });
    select(null);
  } else if (obj?.kind === 'website') {
    if (websites(project).length <= 1) {
      setStatus({ text: 'A project needs at least one website panel.', error: true });
      return;
    }
    edit((p) => {
      p.objects = p.objects.filter((o) => o.id !== obj.id && !(o.kind === 'cursor' && o.targetId === obj.id));
    });
    select(null);
  }
}

export function setVisible(id: string, visible: boolean): void {
  edit((p) => {
    const o = p.objects.find((x) => x.id === id);
    if (o) o.visible = visible;
  });
}

export function hideSelection(): void {
  const { selectedId } = getEditor();
  if (selectedId) setVisible(selectedId, false);
}

export function unhideAll(): void {
  edit((p) => {
    for (const o of p.objects) o.visible = true;
  });
}

/** Duplicates the selected text object (Shift+D). Returns true if something was duplicated. */
export function duplicateSelection(): boolean {
  const { project, selectedId } = getEditor();
  const obj = project.objects.find((o) => o.id === selectedId);
  if (obj?.kind !== 'text') return false;
  const copy = structuredClone(obj);
  copy.id = newId('text');
  copy.name = `${obj.name} copy`;
  for (const prop of TRANSFORM_PROPS) for (const k of copy.transform[prop].keyframes) k.id = newId('k');
  edit((p) => {
    p.objects.push(copy);
  });
  select(copy.id);
  return true;
}

/** Alt+G / Alt+R / Alt+S: reset position, rotation or scale at the playhead. */
export function clearTransform(prop: 'position' | 'rotation' | 'scale'): void {
  const { selectedId, time } = getEditor();
  edit((p) => {
    const o = p.objects.find((x) => x.id === selectedId);
    if (!o || (o.kind !== 'website' && o.kind !== 'text')) return;
    setValueAt(o.transform[prop], time, prop === 'scale' ? [1, 1, 1] : [0, 0, 0]);
  });
}

/** The keyframable properties of an object (what I / Alt+I act on). */
function keyableProps(o: SceneObject): PropName[] {
  if (o.kind === 'cursor') return ['cursor'];
  if (o.kind === 'camera') return CAMERA_PROPS;
  return ['position', 'rotation', 'scale'];
}

const CAMERA_PROPS: PropName[] = ['position', 'target', 'zoom'];

/** I: keyframe position, rotation and scale (or the cursor position, or the camera) at the playhead. */
export function insertKeyframes(): void {
  const { selectedId, time } = getEditor();
  let label = '';
  edit((p) => {
    const o = p.objects.find((x) => x.id === selectedId) as SceneObject | undefined;
    if (!o) return;
    const props = keyableProps(o);
    for (const prop of props) {
      const a = getAnimated(o, prop);
      if (a) upsertKeyframe(a, time, sample(a, time));
    }
    label = o.name;
  });
  if (label) setStatus({ text: `Inserted keyframe on ${label} at ${time.toFixed(2)} s` });
}

/** Alt+I: delete the selected object's keyframes at the playhead. */
export function deleteKeysAtPlayhead(): void {
  const { selectedId, time } = getEditor();
  edit((p) => {
    const o = p.objects.find((x) => x.id === selectedId) as SceneObject | undefined;
    if (!o) return;
    const props: PropName[] = o.kind === 'camera' || o.kind === 'cursor' ? keyableProps(o) : TRANSFORM_PROPS;
    for (const prop of props) {
      const a = getAnimated(o, prop);
      const k = a && keyframeAt(a, time);
      if (a && k) removeKeyframes(a, new Set([k.id!]));
    }
  });
}

/** Up/Down: jump the playhead to the next/previous keyframe of any object. */
export function jumpToKeyframe(direction: 1 | -1): void {
  const { project, time } = getEditor();
  const times: number[] = [];
  for (const o of project.objects) {
    if (o.kind === 'cursor') {
      times.push(...o.clicks.map((c) => c.time), ...o.scrolls.map((c) => c.time), ...o.keys.map((k) => k.time));
    }
    for (const prop of [...TRANSFORM_PROPS, 'cursor', 'target', 'zoom'] as PropName[]) {
      const a = getAnimated(o, prop);
      if (a) times.push(...a.keyframes.map((k) => k.time));
    }
  }
  const t = adjacentTime(times, time, direction);
  if (t !== undefined) setTime(t);
}

// ---- Keyframes ------------------------------------------------------------------

function groupKeys(keys: KeyRef[]): Map<string, { objectId: string; prop: KeyRef['prop']; ids: Set<string> }> {
  const groups = new Map<string, { objectId: string; prop: KeyRef['prop']; ids: Set<string> }>();
  for (const k of keys) {
    const g = groups.get(`${k.objectId}|${k.prop}`) ?? { objectId: k.objectId, prop: k.prop, ids: new Set() };
    g.ids.add(k.keyId);
    groups.set(`${k.objectId}|${k.prop}`, g);
  }
  return groups;
}

export function deleteKeys(keys: KeyRef[]): void {
  edit((p) => {
    for (const g of groupKeys(keys).values()) {
      const o = p.objects.find((x) => x.id === g.objectId);
      if (!o) continue;
      if (isCursorEventProp(g.prop)) {
        if (o.kind === 'cursor') {
          if (g.prop === 'clicks') o.clicks = o.clicks.filter((c) => !g.ids.has(c.id));
          else if (g.prop === 'scrolls') o.scrolls = o.scrolls.filter((c) => !g.ids.has(c.id));
          else o.keys = o.keys.filter((c) => !g.ids.has(c.id));
        }
        continue;
      }
      const a = getAnimated(o as SceneObject, g.prop);
      if (a) removeKeyframes(a, g.ids);
    }
  });
  selectKeys([]);
}

/** Moves keyframes and cursor events by dt seconds (one undo step per drag). */
export function moveKeys(keys: KeyRef[], dt: number, mergeKey: string): void {
  edit((p) => {
    for (const g of groupKeys(keys).values()) {
      const o = p.objects.find((x) => x.id === g.objectId);
      if (!o) continue;
      if (isCursorEventProp(g.prop)) {
        if (o.kind !== 'cursor') continue;
        const list: { id: string; time: number }[] = o[g.prop];
        for (const ev of list) {
          if (g.ids.has(ev.id))
            ev.time = Math.min(Math.max(Math.round((ev.time + dt) * p.output.fps) / p.output.fps, 0), p.duration);
        }
        continue;
      }
      const a = getAnimated(o as SceneObject, g.prop);
      if (a) moveKeyframes(a, g.ids, dt, p.duration, p.output.fps);
    }
  }, mergeKey);
}

export function toggleKey(objectId: string, prop: PropName): void {
  const { time } = getEditor();
  edit((p) => {
    const o = p.objects.find((x) => x.id === objectId);
    const a = o && getAnimated(o as SceneObject, prop);
    if (a) toggleKeyframe(a, time);
  });
}

// ---- Export ---------------------------------------------------------------------

interface ExportProgress {
  active: boolean;
  done: number;
  total: number;
  label: string;
  abort: AbortController | null;
}

export const useExportProgress = create<ExportProgress>(() => ({
  active: false,
  done: 0,
  total: 0,
  label: '',
  abort: null,
}));

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export async function runExport(): Promise<void> {
  const renderer = currentRenderer();
  if (!renderer || getEditor().exporting) return;
  setPlaying(false);
  const project: Project = getEditor().project;
  const name = project.name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'video';
  let file: { id: number; path: string } | null;
  try {
    file = await window.looit.exporter.createFile(name);
  } catch (err) {
    setStatus({ text: `Could not create the video file: ${errorText(err)}`, error: true });
    return;
  }
  if (!file) return;
  const abort = new AbortController();
  setEditor({ exporting: true });
  useExportProgress.setState({ active: true, done: 0, total: 0, label: 'Loading website…', abort });
  let ok = false;
  const started = performance.now();
  try {
    await exportVideo({
      project,
      fileId: file.id,
      view,
      renderer,
      siteTexture,
      signal: abort.signal,
      onProgress: (done, total) => {
        const elapsed = (performance.now() - started) / 1000;
        const left = done > 10 ? ` · about ${formatDuration((elapsed / done) * (total - done))} left` : '';
        useExportProgress.setState({ done, total, label: `Rendering frame ${done} of ${total}${left}` });
      },
    });
    ok = true;
    setStatus({ text: `Exported to ${file.path} in ${formatDuration((performance.now() - started) / 1000)}` });
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      setStatus({ text: `Export failed: ${errorText(err)}`, error: true });
    } else setStatus({ text: 'Export cancelled.' });
  } finally {
    await window.looit.exporter.closeFile(file.id, ok).catch(() => {});
    setEditor({ exporting: false });
    useExportProgress.setState({ active: false, abort: null });
    window.looit.site.refresh();
  }
}

export function cancelExport(): void {
  useExportProgress.getState().abort?.abort();
}
