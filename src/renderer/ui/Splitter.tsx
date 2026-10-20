// A drag handle on a panel edge that resizes the panel.

import { useRef } from 'react';

interface SplitterProps {
  /** Which edge of the parent the handle sits on. */
  edge: 'left' | 'right' | 'top';
  /** Current size of the panel being resized. */
  size: number;
  onResize(size: number): void;
  onDoubleClick?(): void;
}

export function Splitter({ edge, size, onResize, onDoubleClick }: SplitterProps) {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const vertical = edge === 'top';
  return (
    <div
      className={`splitter splitter-${edge}`}
      title="Drag to resize · double-click to hide"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { pos: vertical ? e.clientY : e.clientX, size };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const delta = (vertical ? e.clientY : e.clientX) - s.pos;
        // Dragging a top or left edge outward grows the panel.
        onResize(edge === 'right' ? s.size + delta : s.size - delta);
      }}
      onPointerUp={() => (start.current = null)}
      onDoubleClick={onDoubleClick}
    />
  );
}
