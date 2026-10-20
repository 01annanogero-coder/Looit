// Blender-style modal transforms: G (grab), R (rotate), S (scale).
// While active: X/Y/Z constrain to an axis (press again to clear),
// Shift+X/Y/Z exclude that axis, type a number for an exact value,
// Enter or left-click confirms, Esc or right-click cancels.

import * as THREE from 'three';
import { create } from 'zustand';
import type { Vec2, Vec3 } from '../../engine/animation';
import { setValueAt } from '../../engine/edit';
import { sample, type SceneObject, type WebsiteObject } from '../../engine/project';
import { edit, endGesture, getEditor, setPlaying, undo } from '../store';
import { currentRenderer, view } from './runtime';

export type ModalKind = 'grab' | 'rotate' | 'scale';
export type Axis = 0 | 1 | 2;

interface ModalState {
  kind: ModalKind | null;
  axis: Axis | null;
  /** Shift+axis: move/scale on the other two axes. */
  exclude: boolean;
  numeric: string;
  /** Live readout for the header, e.g. "D: 1.25". */
  readout: string;
}

export const useModal = create<ModalState>(() => ({
  kind: null,
  axis: null,
  exclude: false,
  numeric: '',
  readout: '',
}));

const AXIS_NAMES = ['X', 'Y', 'Z'];
const RAD = 180 / Math.PI;

/** Last pointer position over the window, in client pixels. */
const pointer = { x: 0, y: 0 };
window.addEventListener('pointermove', (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
});

interface Session {
  id: number;
  objectId: string;
  kind: ModalKind;
  time: number;
  mouse0: { x: number; y: number };
  /** Object centre on screen (client px) at the start. */
  center: { x: number; y: number };
  startPos: Vec3;
  startRot: Vec3;
  startScale: Vec3;
  startCursor: Vec2;
  isCursor: boolean;
  /** Accumulated rotation in degrees (allows multiple turns). */
  angle: number;
  lastAngle: number;
  changed: boolean;
}

let session: Session | null = null;
let sessionCounter = 0;

function canvasRect(): DOMRect | null {
  return currentRenderer()?.domElement.getBoundingClientRect() ?? null;
}

function toScreen(p: Vec3, rect: DOMRect): { x: number; y: number; ndcZ: number } {
  const v = new THREE.Vector3(...p).project(view.camera);
  return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, ndcZ: v.z };
}

function fromScreen(x: number, y: number, ndcZ: number, rect: DOMRect): THREE.Vector3 {
  return new THREE.Vector3(
    ((x - rect.left) / rect.width) * 2 - 1,
    -((y - rect.top) / rect.height) * 2 + 1,
    ndcZ,
  ).unproject(view.camera);
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Starts a modal transform on the selected object. Returns false if nothing to transform. */
export function startModal(kind: ModalKind): boolean {
  const s = getEditor();
  const obj = s.project.objects.find((o) => o.id === s.selectedId);
  const rect = canvasRect();
  if (!obj || !rect || s.exporting) return false;
  if (obj.kind === 'camera') return false;
  if (obj.kind === 'cursor' && kind !== 'grab') return false;
  if (session) cancelModal();
  if (s.playing) setPlaying(false);

  const over = pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom;
  const mouse0 = over ? { ...pointer } : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  if (!over) {
    pointer.x = mouse0.x;
    pointer.y = mouse0.y;
  }
  const t = s.time;
  const base = {
    startPos: [0, 0, 0] as Vec3,
    startRot: [0, 0, 0] as Vec3,
    startScale: [1, 1, 1] as Vec3,
    startCursor: [0, 0] as Vec2,
  };
  let center = mouse0;
  if (obj.kind === 'cursor') {
    base.startCursor = sample(obj.position, t);
  } else {
    base.startPos = sample(obj.transform.position, t);
    base.startRot = sample(obj.transform.rotation, t);
    base.startScale = sample(obj.transform.scale, t);
    const c = toScreen(base.startPos, rect);
    center = { x: c.x, y: c.y };
  }
  const a0 = Math.atan2(-(mouse0.y - center.y), mouse0.x - center.x) * RAD;
  session = {
    id: ++sessionCounter,
    objectId: obj.id,
    kind,
    time: t,
    mouse0,
    center,
    ...base,
    isCursor: obj.kind === 'cursor',
    angle: 0,
    lastAngle: a0,
    changed: false,
  };
  useModal.setState({ kind, axis: null, exclude: false, numeric: '', readout: '' });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  return true;
}

export function isModalActive(): boolean {
  return session !== null;
}

function finish(): void {
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('contextmenu', onContextMenu, true);
  session = null;
  endGesture();
  view.setGuide(null, null);
  useModal.setState({ kind: null, axis: null, exclude: false, numeric: '', readout: '' });
}

export function confirmModal(): void {
  if (session) finish();
}

export function cancelModal(): void {
  const s = session;
  if (!s) return;
  finish();
  if (s.changed) undo();
}

function onMove(): void {
  apply();
}

function onPointerDown(e: PointerEvent): void {
  // Any click during a modal transform confirms (left) or cancels (right).
  e.preventDefault();
  e.stopPropagation();
  if (e.button === 2) cancelModal();
  else confirmModal();
}

function onContextMenu(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

/** Keyboard input while a modal transform is active. Returns true if handled. */
export function modalKey(e: KeyboardEvent): boolean {
  if (!session) return false;
  const k = e.key;
  const lower = k.toLowerCase();
  if (k === 'Escape') cancelModal();
  else if (k === 'Enter' || k === ' ') confirmModal();
  else if (lower === 'x' || lower === 'y' || lower === 'z') {
    const axis = 'xyz'.indexOf(lower) as Axis;
    const st = useModal.getState();
    const same = st.axis === axis && st.exclude === e.shiftKey;
    useModal.setState(same ? { axis: null, exclude: false } : { axis, exclude: e.shiftKey });
    apply();
  } else if (/^[0-9.]$/.test(k)) {
    useModal.setState((st) => ({ numeric: st.numeric + k }));
    apply();
  } else if (k === '-') {
    useModal.setState((st) => ({ numeric: st.numeric.startsWith('-') ? st.numeric.slice(1) : `-${st.numeric}` }));
    apply();
  } else if (k === 'Backspace') {
    useModal.setState((st) => ({ numeric: st.numeric.slice(0, -1) }));
    apply();
  } else if (lower === 'g' || lower === 'r' || lower === 's') {
    // Switch transform type mid-way, like Blender.
    const kind: ModalKind = lower === 'g' ? 'grab' : lower === 'r' ? 'rotate' : 'scale';
    if (kind !== session.kind) {
      cancelModal();
      startModal(kind);
    }
  }
  e.preventDefault();
  return true;
}

/** Which axes a change applies to. */
function activeAxes(): boolean[] {
  const { axis, exclude } = useModal.getState();
  if (axis === null) return [true, true, true];
  return [0, 1, 2].map((i) => (exclude ? i !== axis : i === axis));
}

function apply(): void {
  const s = session;
  const rect = canvasRect();
  if (!s || !rect) return;
  const { numeric, axis, exclude } = useModal.getState();
  const typed = numeric !== '' && numeric !== '-' && numeric !== '.' ? Number(numeric) : null;
  const axes = activeAxes();
  const axisLabel = axis === null ? '' : `${exclude ? 'not ' : ''}${AXIS_NAMES[axis]} · `;
  const mouse = { ...pointer };

  if (s.isCursor) {
    applyCursor(s, mouse, rect, typed, axes);
    return;
  }

  let readout = '';
  edit((p) => {
    const o = p.objects.find((x) => x.id === s.objectId);
    if (!o || (o.kind !== 'website' && o.kind !== 'text')) return;
    if (s.kind === 'grab') {
      let next: Vec3;
      if (typed !== null) {
        // A typed distance moves along the constrained axis (X if none).
        const ax = axis ?? 0;
        next = [...s.startPos] as Vec3;
        if (exclude) {
          for (let i = 0; i < 3; i++) if (i !== ax) next[i] += typed;
        } else next[ax] += typed;
      } else {
        const c0 = toScreen(s.startPos, rect);
        const moved = fromScreen(c0.x + mouse.x - s.mouse0.x, c0.y + mouse.y - s.mouse0.y, c0.ndcZ, rect);
        // Depth (Z) has no screen direction with a front camera: use vertical mouse movement.
        const depthPerPx =
          (2 *
            Math.tan(view.camera.fov / 2 / RAD) *
            view.camera.position.distanceTo(new THREE.Vector3(...s.startPos))) /
          rect.height;
        const dz = (mouse.y - s.mouse0.y) * depthPerPx;
        const free: Vec3 = [moved.x, moved.y, axis === 2 && !exclude ? s.startPos[2] + dz : s.startPos[2]];
        next = s.startPos.map((v, i) => (axes[i] ? free[i] : v)) as Vec3;
      }
      next = next.map(round) as Vec3;
      const d = next.map((v, i) => v - s.startPos[i]);
      readout = `${axisLabel}D: ${d.map((v) => v.toFixed(2)).join(', ')}`;
      setValueAt(o.transform.position, s.time, next);
    } else if (s.kind === 'rotate') {
      const a = Math.atan2(-(mouse.y - s.center.y), mouse.x - s.center.x) * RAD;
      let delta = a - s.lastAngle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      s.angle += delta;
      s.lastAngle = a;
      const angle = typed ?? Math.round(s.angle * 10) / 10;
      // Free rotation turns around the view axis (Z for the fixed front camera).
      const ax = axis ?? 2;
      const next = [...s.startRot] as Vec3;
      if (exclude) {
        for (let i = 0; i < 3; i++) if (i !== ax) next[i] += angle;
      } else next[ax] += angle;
      readout = `${axisLabel || `${AXIS_NAMES[ax]} · `}${angle.toFixed(1)}°`;
      setValueAt(o.transform.rotation, s.time, next.map(round) as Vec3);
    } else {
      const d0 = Math.hypot(s.mouse0.x - s.center.x, s.mouse0.y - s.center.y) || 1;
      const d1 = Math.hypot(mouse.x - s.center.x, mouse.y - s.center.y);
      const factor = typed ?? Math.round((d1 / d0) * 1000) / 1000;
      const next = s.startScale.map((v, i) => (axes[i] ? v * factor : v)) as Vec3;
      readout = `${axisLabel}Scale: ${factor.toFixed(3)}`;
      setValueAt(o.transform.scale, s.time, next.map(round) as Vec3);
    }
  }, `modal:${s.id}`);
  s.changed = true;
  if (numeric) readout += `  [${numeric}]`;
  useModal.setState({ readout });
  view.setGuide(axis === null ? null : s.startPos, axis === null ? null : { axis, exclude });
}

/** Grab on the cursor: it slides over its website panel. */
function applyCursor(
  s: Session,
  mouse: { x: number; y: number },
  rect: DOMRect,
  typed: number | null,
  axes: boolean[],
): void {
  const { project } = getEditor();
  const cursor = project.objects.find((o) => o.id === s.objectId);
  const website = project.objects.find(
    (o): o is WebsiteObject => cursor?.kind === 'cursor' && o.id === cursor.targetId && o.kind === 'website',
  );
  if (!website) return;
  let next: Vec2;
  if (typed !== null) {
    const ax = useModal.getState().axis === 1 ? 1 : 0;
    next = [...s.startCursor] as Vec2;
    next[ax] += typed;
  } else {
    const hit = view.raycastWebsite(
      website.id,
      ((mouse.x - rect.left) / rect.width) * 2 - 1,
      -((mouse.y - rect.top) / rect.height) * 2 + 1,
    );
    if (!hit) return;
    const px = view.uvToPixel(website, hit);
    next = [axes[0] ? px[0] : s.startCursor[0], axes[1] ? px[1] : s.startCursor[1]];
  }
  next = [
    Math.round(Math.min(Math.max(next[0], 0), website.viewport.width)),
    Math.round(Math.min(Math.max(next[1], 0), website.viewport.height)),
  ];
  edit((p) => {
    const o = p.objects.find((x) => x.id === s.objectId) as SceneObject | undefined;
    if (o?.kind === 'cursor') setValueAt(o.position, s.time, next);
  }, `modal:${s.id}`);
  s.changed = true;
  useModal.setState({ readout: `Cursor: ${next[0]}, ${next[1]} px` });
}
