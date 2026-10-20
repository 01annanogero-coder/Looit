// Bottom timeline: one track per object, expandable into property rows with
// draggable keyframe diamonds, a zoomable/scrollable time ruler and transport.
// Any length is supported; only the visible time range is drawn.

import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Expand,
  Globe,
  MousePointer2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Type,
  Video,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { snapTime, upsertKeyframe } from '../../engine/edit';
import {
  DEFAULT_TYPING_CPS,
  getAnimated,
  keysEndTime,
  newId,
  sample,
  type Project,
  type PropName,
  type SceneObject,
} from '../../engine/project';
import { MAX_DURATION } from '../../engine/schema';
import { jumpToKeyframe, moveKeys } from '../actions';
import { toggleTimeline } from '../layout';
import {
  edit,
  endGesture,
  getEditor,
  isCursorEventProp,
  selectKeys,
  setPlaying,
  setTime,
  useEditor,
  type KeyRef,
} from '../store';

const PAD = 14;
export const TIMELINE_HEADER_HEIGHT = 42;

type RowProp = KeyRef['prop'];

interface Marker {
  id: string;
  time: number;
  /** Events with a duration (typing) end here. */
  end?: number;
}

/** The visible time window: seconds at the left edge and seconds shown. */
interface View {
  start: number;
  span: number;
}

const TRANSFORM_ROWS: { prop: RowProp; label: string }[] = [
  { prop: 'position', label: 'Position' },
  { prop: 'rotation', label: 'Rotation' },
  { prop: 'scale', label: 'Scale' },
  { prop: 'opacity', label: 'Opacity' },
];

const PROP_ROWS: Record<SceneObject['kind'], { prop: RowProp; label: string }[]> = {
  website: TRANSFORM_ROWS,
  text: TRANSFORM_ROWS,
  camera: [
    { prop: 'position', label: 'Position' },
    { prop: 'target', label: 'Look at' },
    { prop: 'zoom', label: 'Zoom' },
  ],
  cursor: [
    { prop: 'cursor', label: 'Position' },
    { prop: 'clicks', label: 'Clicks' },
    { prop: 'scrolls', label: 'Scrolls' },
    { prop: 'keys', label: 'Typing' },
  ],
};

const OBJECT_ICONS: Record<SceneObject['kind'], ReactNode> = {
  camera: <Video size={14} />,
  website: <Globe size={14} />,
  text: <Type size={14} />,
  cursor: <MousePointer2 size={14} />,
};

function markersFor(obj: SceneObject, prop: RowProp): Marker[] {
  if (prop === 'clicks') return obj.kind === 'cursor' ? obj.clicks : [];
  if (prop === 'scrolls') return obj.kind === 'cursor' ? obj.scrolls : [];
  if (prop === 'keys')
    return obj.kind === 'cursor' ? obj.keys.map((k) => ({ id: k.id, time: k.time, end: keysEndTime(k) })) : [];
  const a = getAnimated(obj, prop);
  return a ? a.keyframes.map((k) => ({ id: k.id!, time: k.time })) : [];
}

function allMarkers(obj: SceneObject): { prop: RowProp; m: Marker }[] {
  return PROP_ROWS[obj.kind].flatMap(({ prop }) => markersFor(obj, prop).map((m) => ({ prop, m })));
}

function orderedObjects(p: Project): SceneObject[] {
  const out: SceneObject[] = p.objects.filter((o) => o.kind === 'camera');
  for (const w of p.objects.filter((o) => o.kind === 'website')) {
    out.push(w);
    out.push(...p.objects.filter((o) => o.kind === 'cursor' && o.targetId === w.id));
  }
  out.push(...p.objects.filter((o) => o.kind === 'text'));
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function timecode(t: number, fps: number): string {
  const totalFrames = Math.round(t * fps);
  const f = totalFrames % fps;
  const s = Math.floor(totalFrames / fps);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}:${pad2(f)}`;
}

/** "90", "1:30", "1:00:00" -> seconds. */
export function parseDuration(text: string): number | null {
  const parts = text
    .trim()
    .split(':')
    .map((p) => p.trim());
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

export function formatDuration(t: number): string {
  const s = Math.round(t * 100) / 100;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round((s % 60) * 100) / 100;
  const secText = Number.isInteger(sec) ? pad2(sec) : sec.toFixed(2).padStart(5, '0');
  return h > 0 ? `${h}:${pad2(m)}:${secText}` : `${m}:${secText}`;
}

function tickLabel(t: number, step: number, fps: number): string {
  const whole = Math.floor(t + 1e-6);
  const h = Math.floor(whole / 3600);
  const base =
    h > 0
      ? `${h}:${pad2(Math.floor(whole / 60) % 60)}:${pad2(whole % 60)}`
      : `${pad2(Math.floor(whole / 60))}:${pad2(whole % 60)}`;
  if (step >= 1) return base;
  const frame = Math.round((t - whole) * fps);
  return frame === 0 ? base : `${frame}f`;
}

/** Adds a keyframe/event on a row at time t (double-click on a lane). */
function addAt(objectId: string, prop: RowProp, t: number): void {
  edit((p) => {
    const o = p.objects.find((x) => x.id === objectId);
    if (!o) return;
    if (isCursorEventProp(prop)) {
      if (o.kind !== 'cursor') return;
      if (prop === 'clicks') o.clicks.push({ id: newId('click'), time: t });
      else if (prop === 'scrolls') o.scrolls.push({ id: newId('scroll'), time: t, deltaY: 400 });
      else o.keys.push({ id: newId('keys'), time: t, kind: 'type', text: 'Hello', cps: DEFAULT_TYPING_CPS });
      return;
    }
    const a = getAnimated(o as SceneObject, prop as PropName);
    if (a) upsertKeyframe(a, t, sample(a, t));
  });
}

function DurationField() {
  const duration = useEditor((s) => s.project.duration);
  const [text, setText] = useState(formatDuration(duration));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(formatDuration(duration));
  }, [duration, editing]);
  const commit = () => {
    setEditing(false);
    const v = parseDuration(text);
    if (v === null || v < 0.5 || v > MAX_DURATION) {
      setText(formatDuration(duration));
      return;
    }
    edit((p) => {
      p.duration = v;
    });
    if (getEditor().time > v) setTime(v);
  };
  return (
    <label className="duration-field" title="Video length: type seconds, m:ss or h:mm:ss (up to 4 hours)">
      <span className="muted">End</span>
      <input
        value={text}
        onFocus={(e) => {
          setEditing(true);
          const el = e.target;
          requestAnimationFrame(() => el.select());
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setEditing(false);
            setText(formatDuration(duration));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

function Transport() {
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const fps = useEditor((s) => s.project.output.fps);
  const duration = useEditor((s) => s.project.duration);
  return (
    <div className="transport">
      <button className="icon-btn ghost" title="Go to start (Shift+←)" onClick={() => setTime(0)}>
        <SkipBack size={15} />
      </button>
      <button className="icon-btn ghost" title="Previous keyframe (↓)" onClick={() => jumpToKeyframe(-1)}>
        <StepBack size={15} />
      </button>
      <button className="icon-btn play" title="Play / pause (Space)" onClick={() => setPlaying(!playing)}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <button className="icon-btn ghost" title="Next keyframe (↑)" onClick={() => jumpToKeyframe(1)}>
        <StepForward size={15} />
      </button>
      <button className="icon-btn ghost" title="Go to end (Shift+→)" onClick={() => setTime(duration)}>
        <SkipForward size={15} />
      </button>
      <span className="timecode">{timecode(time, fps)}</span>
    </div>
  );
}

function Playhead({ view, pps }: { view: View; pps: number }) {
  const time = useEditor((s) => s.time);
  if (time < view.start - 1e-6 || time > view.start + view.span + 1e-6) return null;
  return <div className="playhead" style={{ left: PAD + (time - view.start) * pps }} />;
}

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

function Ruler({ view, pps, fps }: { view: View; pps: number; fps: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const frameSteps = [1, 2, 5, 10].map((f) => f / fps);
  const step = [...frameSteps, ...TICK_STEPS].find((s) => s * pps >= 64) ?? 3600;
  const ticks: number[] = [];
  const first = Math.ceil((view.start - 1e-9) / step) * step;
  for (let t = first; t <= view.start + view.span + 1e-6 && ticks.length < 500; t += step) {
    ticks.push(Math.round(t * 1e6) / 1e6);
  }
  const seek = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    setTime(view.start + (clientX - r.left - PAD) / pps);
  };
  return (
    <div
      className="ruler"
      ref={ref}
      onPointerDown={(e) => {
        setPlaying(false);
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(e.clientX);
      }}
    >
      {ticks.map((t) => (
        <span key={t} className="tick" style={{ left: PAD + (t - view.start) * pps }}>
          {tickLabel(t, step, fps)}
        </span>
      ))}
    </div>
  );
}

function inView(t: number, view: View, pps: number): boolean {
  const margin = 12 / pps;
  return t >= view.start - margin && t <= view.start + view.span + margin;
}

interface LaneProps {
  obj: SceneObject;
  prop: RowProp;
  view: View;
  pps: number;
}

function Lane({ obj, prop, view, pps }: LaneProps) {
  const selectedKeys = useEditor((s) => s.selectedKeys);
  const markers = markersFor(obj, prop).filter((m) => inView(m.time, view, pps));
  const isEvent = isCursorEventProp(prop);

  const timeAt = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const { project } = getEditor();
    const t = view.start + (e.clientX - r.left - PAD) / pps;
    return Math.min(Math.max(snapTime(t, project.output.fps), 0), project.duration);
  };

  return (
    <div
      className="lane"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !e.shiftKey) selectKeys([]);
      }}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) addAt(obj.id, prop, timeAt(e));
      }}
      title="Double-click to add a keyframe here"
    >
      {markers.map(
        (m) =>
          m.end !== undefined &&
          m.end > m.time && (
            <span
              key={`${m.id}-span`}
              className={`event-span p-${prop}`}
              style={{ left: PAD + (m.time - view.start) * pps, width: (m.end - m.time) * pps }}
            />
          ),
      )}
      {markers.map((m) => {
        const ref: KeyRef = { objectId: obj.id, prop, keyId: m.id };
        const selected = selectedKeys.some((k) => k.objectId === obj.id && k.prop === prop && k.keyId === m.id);
        return (
          <KeyMarker
            key={m.id}
            refKey={ref}
            left={PAD + (m.time - view.start) * pps}
            time={m.time}
            pps={pps}
            selected={selected}
            className={`${isEvent ? 'event' : 'diamond'} p-${prop}`}
          />
        );
      })}
    </div>
  );
}

function KeyMarker({
  refKey,
  left,
  time,
  pps,
  selected,
  className,
}: {
  refKey: KeyRef;
  left: number;
  time: number;
  pps: number;
  selected: boolean;
  className: string;
}) {
  const drag = useRef<{ x: number; applied: number; keys: KeyRef[]; key: string } | null>(null);
  return (
    <span
      className={`marker ${className}${selected ? ' selected' : ''}`}
      style={{ left }}
      title={`${formatDuration(time)}: drag to move, Del to delete`}
      onPointerDown={(e) => {
        e.stopPropagation();
        setPlaying(false);
        const s = getEditor();
        let keys = s.selectedKeys;
        if (e.shiftKey) {
          selectKeys([refKey], true);
          return;
        }
        if (!selected) {
          keys = [refKey];
          selectKeys(keys);
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, applied: 0, keys, key: `drag-keys:${Date.now()}` };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const { fps } = getEditor().project.output;
        const total = Math.round(((e.clientX - d.x) / pps) * fps) / fps;
        const delta = total - d.applied;
        if (Math.abs(delta) > 1e-9) {
          moveKeys(d.keys, delta, d.key);
          d.applied = total;
        }
      }}
      onPointerUp={() => {
        drag.current = null;
        endGesture();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setTime(time);
      }}
    />
  );
}

function SummaryLane({ obj, view, pps }: { obj: SceneObject; view: View; pps: number }) {
  const marks = allMarkers(obj);
  if (marks.length === 0) return <div className="lane summary" />;
  const times = marks.map((x) => x.m.time);
  const min = Math.max(Math.min(...times), view.start - 1);
  const max = Math.min(Math.max(...times), view.start + view.span + 1);
  const unique = [...new Set(times.filter((t) => inView(t, view, pps)).map((t) => t.toFixed(4)))].map(Number);
  return (
    <div className="lane summary">
      {max > min && (
        <span
          className={`bar k-${obj.kind}`}
          style={{ left: PAD + (min - view.start) * pps, width: Math.max((max - min) * pps, 2) }}
        />
      )}
      {unique.map((t) => (
        <span
          key={t}
          className="marker diamond summary-dot"
          style={{ left: PAD + (t - view.start) * pps }}
          title="Select all keyframes at this time"
          onPointerDown={(e) => {
            e.stopPropagation();
            const keys = marks
              .filter((x) => Math.abs(x.m.time - t) < 1e-4)
              .map((x) => ({ objectId: obj.id, prop: x.prop, keyId: x.m.id }));
            selectKeys(keys, e.shiftKey);
          }}
        />
      ))}
    </div>
  );
}

/** Horizontal scrollbar shown while the timeline is zoomed in. */
function TimeScrollbar({ view, duration, onChange }: { view: View; duration: number; onChange(start: number): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; start: number; width: number } | null>(null);
  const zoomed = view.span < duration - 1e-6;
  return (
    <div
      className={`time-scroll${zoomed ? '' : ' idle'}`}
      ref={ref}
      onPointerDown={(e) => {
        if (!zoomed || e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        onChange(((e.clientX - r.left) / r.width) * duration - view.span / 2);
      }}
    >
      {zoomed && (
        <div
          className="time-scroll-thumb"
          style={{ left: `${(view.start / duration) * 100}%`, width: `${Math.max((view.span / duration) * 100, 2)}%` }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, start: view.start, width: ref.current?.clientWidth ?? 1 };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) onChange(d.start + ((e.clientX - d.x) / d.width) * duration);
          }}
          onPointerUp={() => (drag.current = null)}
        />
      )}
    </div>
  );
}

function isStillCamera(o: SceneObject): boolean {
  return o.kind === 'camera' && o.position.keyframes.length + o.target.keyframes.length + o.zoom.keyframes.length === 0;
}

export function Timeline({ collapsed: panelCollapsed }: { collapsed: boolean }) {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  // Rows the user opened or closed; otherwise only a still camera starts closed.
  const [folded, setFolded] = useState<Map<string, boolean>>(new Map());
  const lanesRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  // null = fit the whole video; otherwise the zoomed window.
  const [zoom, setZoom] = useState<View | null>(null);

  useLayoutEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [panelCollapsed]);

  const duration = project.duration;
  const fps = project.output.fps;
  const clampView = (v: View): View => {
    const span = Math.min(Math.max(v.span, 10 / fps), duration);
    return { span, start: Math.min(Math.max(v.start, 0), Math.max(duration - span, 0)) };
  };
  const view: View = zoom ? clampView(zoom) : { start: 0, span: duration };
  const laneWidth = Math.max(width - PAD * 2, 50);
  const pps = laneWidth / view.span;

  // Keep the playhead in view during playback by paging the window.
  useEffect(() => {
    if (!zoom) return;
    return useEditor.subscribe((s) => {
      if (s.playing && (s.time > zoom.start + zoom.span || s.time < zoom.start)) {
        setZoom(clampView({ start: s.time - zoom.span * 0.05, span: zoom.span }));
      }
    });
  });

  // Wheel zooms around the mouse (Blender style); Ctrl+wheel pans; Shift+wheel scrolls rows.
  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) {
        if (bodyRef.current) bodyRef.current.scrollTop += e.deltaY;
        return;
      }
      const current = zoom ? clampView(zoom) : { start: 0, span: duration };
      const curPps = laneWidth / current.span;
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = e.ctrlKey ? e.deltaY : e.deltaX;
        setZoom(clampView({ start: current.start + d / curPps, span: current.span }));
        return;
      }
      const offset = e.clientX - el.getBoundingClientRect().left - PAD;
      const mouseT = current.start + offset / curPps;
      const span = Math.min(Math.max(current.span * Math.exp(e.deltaY * 0.0015), 10 / fps), duration);
      const next = clampView({ start: mouseT - offset / (laneWidth / span), span });
      setZoom(next.span >= duration - 1e-6 ? null : next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const objects = orderedObjects(project);
  const collapsed = new Set(objects.filter((o) => folded.get(o.id) ?? isStillCamera(o)).map((o) => o.id));
  const toggle = (id: string) => setFolded(new Map(folded).set(id, !collapsed.has(id)));

  return (
    <div className="timeline">
      <div className="timeline-head" style={{ height: TIMELINE_HEADER_HEIGHT }}>
        <span className="panel-title">Timeline</span>
        <Transport />
        <DurationField />
        <button className="icon-btn ghost" title="Show the whole video" onClick={() => setZoom(null)} disabled={!zoom}>
          <Expand size={14} /> Fit
        </button>
        <span className="muted small grow">Wheel: zoom · Ctrl+wheel: pan · Double-click a row: add keyframe</span>
        <button
          className="icon-btn ghost"
          title={panelCollapsed ? 'Show timeline' : 'Minimize timeline'}
          onClick={toggleTimeline}
        >
          {panelCollapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>
      {!panelCollapsed && (
        <div className="timeline-body" ref={bodyRef}>
          <div className="tl-grid">
            <div className="tl-labels">
              <div className="tl-label ruler-spacer" />
              {objects.map((o) => (
                <div key={o.id}>
                  <div
                    className={`tl-label object${selectedId === o.id ? ' selected' : ''}`}
                    onClick={() => useEditor.setState({ selectedId: o.id })}
                  >
                    <button
                      className="icon-btn ghost tiny"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(o.id);
                      }}
                    >
                      {collapsed.has(o.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </button>
                    {OBJECT_ICONS[o.kind]}
                    <span>{o.name}</span>
                  </div>
                  {!collapsed.has(o.id) &&
                    PROP_ROWS[o.kind].map((r) => (
                      <div key={r.prop} className="tl-label prop">
                        <span className={`dot p-${r.prop}`} />
                        {r.label}
                      </div>
                    ))}
                </div>
              ))}
            </div>
            <div className="tl-lanes" ref={lanesRef}>
              <Ruler view={view} pps={pps} fps={fps} />
              {objects.map((o) => (
                <div key={o.id}>
                  <SummaryLane obj={o} view={view} pps={pps} />
                  {!collapsed.has(o.id) &&
                    PROP_ROWS[o.kind].map((r) => <Lane key={r.prop} obj={o} prop={r.prop} view={view} pps={pps} />)}
                </div>
              ))}
              <Playhead view={view} pps={pps} />
            </div>
          </div>
          <div className="tl-grid scroll-row">
            <div />
            <TimeScrollbar
              view={view}
              duration={duration}
              onChange={(start) => setZoom(clampView({ start, span: view.span }))}
            />
          </div>
        </div>
      )}
    </div>
  );
}
