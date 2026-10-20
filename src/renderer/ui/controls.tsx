// Small reusable inspector controls.

import { ChevronDown, ChevronRight, Diamond } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { endGesture } from '../store';

function format(v: number, precision: number): string {
  return Number(v.toFixed(precision)).toString();
}

interface NumberFieldProps {
  value: number;
  /** `gesture` is true while dragging, so the drag can be one undo step. */
  onChange(value: number, gesture: boolean): void;
  label?: string;
  step?: number;
  precision?: number;
  min?: number;
  max?: number;
  suffix?: string;
  title?: string;
}

/** A number input whose label can be dragged left/right to scrub the value. */
export function NumberField({
  value,
  onChange,
  label,
  step = 0.01,
  precision = 2,
  min = -Infinity,
  max = Infinity,
  suffix,
  title,
}: NumberFieldProps) {
  const [text, setText] = useState(format(value, precision));
  const [editing, setEditing] = useState(false);
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);

  useEffect(() => {
    if (!editing) setText(format(value, precision));
  }, [value, precision, editing]);

  const clamp = (v: number) => Math.min(Math.max(v, min), max);

  const commit = () => {
    setEditing(false);
    const v = Number(text);
    if (Number.isFinite(v)) onChange(clamp(v), false);
    else setText(format(value, precision));
  };

  return (
    <label className="num" title={title}>
      {label && (
        <span
          className="num-label"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, start: value, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            if (Math.abs(dx) > 2) d.moved = true;
            const fine = e.shiftKey ? 0.1 : 1;
            if (d.moved) onChange(clamp(Number((d.start + dx * step * fine).toFixed(precision))), true);
          }}
          onPointerUp={() => {
            drag.current = null;
            endGesture();
          }}
        >
          {label}
        </span>
      )}
      <input
        type="text"
        inputMode="decimal"
        value={editing ? text : format(value, precision) + (suffix ?? '')}
        onFocus={(e) => {
          setEditing(true);
          setText(format(value, precision));
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(format(value, precision));
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const v = clamp(
              Number((value + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1)).toFixed(precision)),
            );
            onChange(v, true);
            setText(format(v, precision));
          }
        }}
      />
    </label>
  );
}

export type KeyState = 'static' | 'animated' | 'keyed';

/** The keyframe diamond: hollow = static, outlined = animated, filled = key at playhead. */
export function KeyButton({ state, onClick, title }: { state: KeyState; onClick(): void; title?: string }) {
  return (
    <button
      className={`key-btn key-${state}`}
      onClick={onClick}
      title={
        title ??
        (state === 'keyed'
          ? 'Remove keyframe at playhead'
          : state === 'animated'
            ? 'Add keyframe at playhead'
            : 'Animate: add first keyframe')
      }
    >
      <Diamond size={12} />
    </button>
  );
}

interface VecRowProps {
  label: string;
  value: readonly number[];
  axes?: string[];
  onChange(value: number[], gesture: boolean): void;
  step?: number;
  precision?: number;
  suffix?: string;
  keyState?: KeyState;
  onToggleKey?(): void;
}

export function VecRow({
  label,
  value,
  axes = ['X', 'Y', 'Z'],
  onChange,
  step,
  precision,
  suffix,
  keyState,
  onToggleKey,
}: VecRowProps) {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <div className="vec" style={{ gridTemplateColumns: `repeat(${value.length}, 1fr)` }}>
        {value.map((v, i) => (
          <NumberField
            key={i}
            label={axes[i]}
            value={v}
            step={step}
            precision={precision}
            suffix={suffix}
            onChange={(nv, g) =>
              onChange(
                value.map((x, j) => (j === i ? nv : x)),
                g,
              )
            }
          />
        ))}
      </div>
      {keyState && onToggleKey ? <KeyButton state={keyState} onClick={onToggleKey} /> : <span className="key-spacer" />}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <div className="prop-value">{children}</div>
      <span className="key-spacer" />
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function ColorField({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <div className="color-field">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <input
        type="text"
        value={value}
        spellCheck={false}
        onChange={(e) => {
          if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value.toLowerCase());
        }}
      />
    </div>
  );
}

export function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="section">
      <button className="section-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

/** Text input that commits on Enter or blur. */
export function TextField({
  value,
  onCommit,
  placeholder,
  multiline,
}: {
  value: string;
  onCommit(v: string): void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return multiline ? (
    <textarea
      className="text-input"
      rows={2}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
    />
  ) : (
    <input
      className="text-input"
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setText(value);
      }}
    />
  );
}
