// The 3D viewport: renders the scene, runs playback, and handles selection,
// gizmo transforms and direct interaction with the live website.

import { ArrowDownToLine, Crosshair, Hand, MousePointer2, Move3d, Rotate3d, Scale3d } from 'lucide-react';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Vec3 } from '../../engine/animation';
import { setValueAt } from '../../engine/edit';
import { cursorFor, newId, sample, type WebsiteObject } from '../../engine/project';
import { closestEuler } from '../../engine/rotation';
import type { MouseInput } from '../../shared/ipc';
import {
  edit,
  endGesture,
  getEditor,
  select,
  setEditor,
  setPlaying,
  setStatus,
  useEditor,
  type GizmoMode,
  type Tool,
} from '../store';
import { scrollToHere } from '../actions';
import { useModal } from '../viewport/modal';
import { getRenderer, playbackTick, setActiveWebsite, startLiveWebsite, view } from '../viewport/runtime';

const RAD = 180 / Math.PI;

function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** `readOnly`: the AI Studio shows the scene without tools or mouse input. */
export function Viewport({ readOnly = false }: { readOnly?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tool = useEditor((s) => s.tool);
  const gizmo = useEditor((s) => s.gizmo);
  const aspect = useEditor((s) => s.project.output.width / s.project.output.height);
  const modal = useModal();

  useEffect(() => {
    const host = hostRef.current!;
    const canvas = canvasRef.current!;
    const renderer = getRenderer(canvas);
    const controls = new TransformControls(view.camera, canvas);
    controls.setSize(1.1);
    const helper = controls.getHelper();
    view.scene.add(helper);

    // ---- Layout: keep the stage at the output aspect ratio ----
    const layout = () => {
      const s = getEditor();
      if (s.exporting) return;
      const a = s.project.output.width / s.project.output.height;
      const box = host.getBoundingClientRect();
      const w = Math.max(1, Math.floor(Math.min(box.width, box.height * a)));
      const h = Math.max(1, Math.floor(w / a));
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w, h);
      view.setAspect(a);
    };
    const ro = new ResizeObserver(layout);
    ro.observe(host);
    const unsubAspect = useEditor.subscribe((s, p) => {
      if (s.project.output !== p.project.output || s.exporting !== p.exporting) layout();
      // The render loop pauses during export; the gizmo must not stay attached
      // to a panel the export may rebuild (it would be orphaned).
      if (s.exporting && !p.exporting) controls.detach();
    });

    // ---- Gizmo -> project ----
    let dragging = false;
    controls.addEventListener('dragging-changed', (e) => {
      dragging = e.value as boolean;
      if (!dragging) endGesture();
    });
    controls.addEventListener('objectChange', () => {
      const s = getEditor();
      const id = s.selectedId;
      const obj = s.project.objects.find((o) => o.id === id);
      const target = controls.object;
      if (!obj || (obj.kind !== 'website' && obj.kind !== 'text') || !target) return;
      const mode = controls.getMode();
      edit((p) => {
        const o = p.objects.find((x) => x.id === id);
        if (!o || (o.kind !== 'website' && o.kind !== 'text')) return;
        if (mode === 'translate') {
          setValueAt(o.transform.position, s.time, [
            round(target.position.x),
            round(target.position.y),
            round(target.position.z),
          ]);
        } else if (mode === 'rotate') {
          const prev = sample(obj.transform.rotation, s.time);
          const deg: Vec3 = [target.rotation.x * RAD, target.rotation.y * RAD, target.rotation.z * RAD];
          setValueAt(o.transform.rotation, s.time, closestEuler(deg, prev));
        } else {
          setValueAt(o.transform.scale, s.time, [round(target.scale.x), round(target.scale.y), round(target.scale.z)]);
        }
      }, `gizmo:${id}:${mode}`);
    });

    // ---- Pointer: select or interact ----
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pick = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, view.camera);
      const items = view.pickables();
      const hits = raycaster.intersectObjects(
        items.map((i) => i.mesh),
        false,
      );
      const hit = hits[0];
      if (!hit) return null;
      const item = items.find((i) => i.mesh === hit.object)!;
      return { id: item.id, uv: hit.uv, page: !!item.page };
    };

    /** The website page under the pointer (in Interact mode) and the pixel on it. */
    const websitePixel = (e: PointerEvent | WheelEvent): { id: string; px: [number, number] } | null => {
      const s = getEditor();
      if (s.tool !== 'interact' || s.playing || s.exporting) return null;
      const h = pick(e);
      const w = s.project.objects.find((o): o is WebsiteObject => o.id === h?.id && o.kind === 'website');
      if (!h?.uv || !h.page || !w || !w.interactive) return null;
      return { id: w.id, px: view.uvToPixel(w, h.uv) };
    };
    const forward = (e: PointerEvent | WheelEvent, make: (x: number, y: number) => MouseInput) => {
      const p = websitePixel(e);
      if (!p) return;
      if (e.type === 'pointerdown') setActiveWebsite(p.id);
      window.looit.site.input(p.id, [make(p.px[0], p.px[1])]);
    };

    // ---- Cursor tool: place the virtual cursor on the page at the playhead ----
    let cursorDrag: { key: string; websiteId: string } | null = null;
    /** The cursor of the panel under the pointer (or of `websiteId` while dragging) and the pixel on it. */
    const cursorTarget = (e: PointerEvent | WheelEvent | MouseEvent, websiteId?: string) => {
      const s = getEditor();
      const id =
        websiteId ??
        (() => {
          const h = pick(e as PointerEvent);
          return h?.page ? h.id : undefined;
        })();
      const website = s.project.objects.find((o): o is WebsiteObject => o.id === id && o.kind === 'website');
      const cursor = website ? cursorFor(s.project, website.id) : undefined;
      if (!cursor || !website) return null;
      const r = canvas.getBoundingClientRect();
      const uv = view.raycastWebsite(
        website.id,
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      if (!uv) return null;
      const [x, y] = view.uvToPixel(website, uv);
      return { cursor, px: [Math.round(x), Math.round(y)] as [number, number] };
    };
    const placeCursor = (e: PointerEvent | MouseEvent, mergeKey: string, websiteId: string) => {
      const hit = cursorTarget(e, websiteId);
      if (!hit) return;
      const { time } = getEditor();
      edit((p) => {
        const c = p.objects.find((o) => o.id === hit.cursor.id);
        if (c?.kind === 'cursor') setValueAt(c.position, time, hit.px);
      }, mergeKey);
      setStatus({ text: `Cursor at ${hit.px[0]}, ${hit.px[1]} px at ${time.toFixed(2)} s` });
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const s = getEditor();
      if (s.tool === 'interact') {
        forward(e, (x, y) => ({ type: 'down', x, y }));
        return;
      }
      if (s.tool === 'cursor') {
        setPlaying(false);
        const hit = cursorTarget(e);
        if (!hit) return;
        select(hit.cursor.id);
        cursorDrag = { key: `cursor-drag:${Date.now()}`, websiteId: hit.cursor.targetId };
        canvas.setPointerCapture(e.pointerId);
        placeCursor(e, cursorDrag.key, cursorDrag.websiteId);
        return;
      }
      // Gizmo handles take priority over selection.
      if (controls.axis !== null || dragging) return;
      select(pick(e)?.id ?? null);
    };
    const onMove = (e: PointerEvent) => {
      if (cursorDrag) placeCursor(e, cursorDrag.key, cursorDrag.websiteId);
      else forward(e, (x, y) => ({ type: 'move', x, y }));
    };
    const onUp = (e: PointerEvent) => {
      if (cursorDrag) {
        cursorDrag = null;
        endGesture();
        return;
      }
      if (e.button === 0) forward(e, (x, y) => ({ type: 'up', x, y }));
    };
    const onDblClick = (e: MouseEvent) => {
      if (getEditor().tool !== 'cursor') return;
      const hit = cursorTarget(e);
      if (!hit) return;
      const { time } = getEditor();
      edit((p) => {
        const c = p.objects.find((o) => o.id === hit.cursor.id);
        if (c?.kind !== 'cursor') return;
        setValueAt(c.position, time, hit.px);
        if (!c.clicks.some((k) => Math.abs(k.time - time) < 1e-4)) c.clicks.push({ id: newId('click'), time });
      });
      setStatus({ text: `Click added at ${time.toFixed(2)} s` });
    };
    const onWheel = (e: WheelEvent) => {
      const s = getEditor();
      if (s.tool === 'interact') {
        e.preventDefault();
        forward(e, (x, y) => ({ type: 'wheel', x, y, deltaY: e.deltaY }));
      } else if (s.tool === 'cursor') {
        e.preventDefault();
        const hit = cursorTarget(e);
        if (!hit) return;
        // Wheel notches at the same playhead add up into one scroll event.
        let total = 0;
        edit((p) => {
          const c = p.objects.find((o) => o.id === hit.cursor.id);
          if (c?.kind !== 'cursor') return;
          const existing = c.scrolls.find((k) => Math.abs(k.time - s.time) < 1e-4);
          if (existing) existing.deltaY = total = Math.round(existing.deltaY + e.deltaY);
          else c.scrolls.push({ id: newId('scroll'), time: s.time, deltaY: (total = Math.round(e.deltaY)) });
        }, `cursor-scroll:${s.time}`);
        setStatus({ text: `Scroll of ${total} px at ${s.time.toFixed(2)} s` });
      }
    };
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // ---- Frame loop ----
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = (now - last) / 1000;
      last = now;
      const s = getEditor();
      if (s.exporting) {
        helper.visible = false;
        return;
      }
      if (s.playing) {
        const prev = s.time;
        const next = Math.min(prev + dt, s.project.duration);
        setEditor({ time: next });
        // Advance the preview website's clock with the playhead (cursor clicks/scrolls included).
        playbackTick(s.project, prev, next);
        if (next >= s.project.duration) setPlaying(false);
      }
      const cur = getEditor();
      view.sync(cur.project, cur.time, { selectedId: cur.selectedId, showHelpers: true });

      // Attach the gizmo to the selected object (not while dragging, so its
      // reference transform stays stable).
      const target =
        cur.tool === 'select' && !cur.playing && cur.selectedId && !useModal.getState().kind
          ? view.object3D(cur.selectedId)
          : null;
      if (!dragging && controls.object !== (target ?? undefined)) {
        if (target) controls.attach(target);
        else controls.detach();
      }
      controls.setMode(cur.gizmo);
      helper.visible = !!target;
      renderer.render(view.scene, view.camera);
    };
    raf = requestAnimationFrame(frame);
    startLiveWebsite();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubAspect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      controls.detach();
      view.scene.remove(helper);
      controls.dispose();
    };
  }, []);

  const setTool = (t: Tool) => setEditor({ tool: t });
  const setGizmo = (g: GizmoMode) => setEditor({ gizmo: g, tool: 'select' });

  return (
    <div className="viewport">
      {!readOnly && (
        <div className="viewport-toolbar">
          <span className="panel-title">3D Viewport</span>
          <div className="tool-group">
            <button
              className={tool === 'select' ? 'active' : ''}
              title="Select: click objects, move them with the handles or G / R / S"
              onClick={() => setTool('select')}
            >
              <MousePointer2 size={15} />
            </button>
            <button
              className={tool === 'cursor' ? 'active' : ''}
              title="Cursor (C): drag on the page to place the virtual cursor at the playhead, double-click to make it click, wheel to scroll"
              onClick={() => setTool('cursor')}
            >
              <Crosshair size={15} />
            </button>
            <button
              className={tool === 'interact' ? 'active' : ''}
              title="Interact (Tab): click, scroll and type on the live website yourself (Esc to leave)"
              onClick={() => setTool('interact')}
            >
              <Hand size={15} />
            </button>
          </div>
          <div className="tool-group">
            <button
              className={tool === 'select' && gizmo === 'translate' ? 'active' : ''}
              title="Move handles (or press G)"
              onClick={() => setGizmo('translate')}
            >
              <Move3d size={15} />
            </button>
            <button
              className={tool === 'select' && gizmo === 'rotate' ? 'active' : ''}
              title="Rotate handles (or press R)"
              onClick={() => setGizmo('rotate')}
            >
              <Rotate3d size={15} />
            </button>
            <button
              className={tool === 'select' && gizmo === 'scale' ? 'active' : ''}
              title="Scale handles (or press S)"
              onClick={() => setGizmo('scale')}
            >
              <Scale3d size={15} />
            </button>
          </div>
          {modal.kind ? (
            <span className="modal-hint">
              <strong>{MODAL_NAMES[modal.kind]}</strong>
              <span>{modal.readout || 'move the mouse'}</span>
              <span className="muted small">
                <kbd>X</kbd> <kbd>Y</kbd> <kbd>Z</kbd> axis · type a number · <kbd>Enter</kbd> confirm · <kbd>Esc</kbd>{' '}
                cancel
              </span>
            </span>
          ) : (
            <span className="muted small">{TOOL_HINTS[tool]}</span>
          )}
          {tool === 'interact' && !modal.kind && (
            <button
              className="scroll-here"
              title="Adds a scroll at the playhead that brings the page to where you scrolled it"
              onClick={() => void scrollToHere()}
            >
              <ArrowDownToLine size={14} /> Scroll to here
            </button>
          )}
        </div>
      )}
      <div className="viewport-stage" ref={hostRef}>
        <canvas
          ref={canvasRef}
          className={`tool-${tool}`}
          style={{ aspectRatio: String(aspect), ...(readOnly ? { pointerEvents: 'none' } : {}) }}
        />
      </div>
    </div>
  );
}

const MODAL_NAMES = { grab: 'Grab', rotate: 'Rotate', scale: 'Scale' } as const;

const TOOL_HINTS: Record<Tool, string> = {
  select: 'Click to select · G move · R rotate · S scale · I keyframe',
  cursor: 'Drag on the page to place the cursor at the playhead · double-click = click · wheel = scroll',
  interact: 'You are using the live website (not recorded) · scroll to a spot, then Scroll to here · Esc to go back',
};
