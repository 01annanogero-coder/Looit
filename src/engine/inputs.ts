// Which inputs the virtual cursor sends to the website on each video frame.
// Shared by the exporter (main process) and the preview, so every path
// replays exactly the same input sequence.

import { frameTime } from './animation';
import { eventsBetween, sample, type CursorObject, type SpecialKey } from './project';

/** One input to a website page: mouse (in page CSS pixels) or keyboard. */
export type PageInput =
  | { type: 'move' | 'down' | 'up' | 'click'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; deltaY: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: SpecialKey };

/** Order of simultaneous events: a click lands before typing that starts at the same time. */
const ORDER = { click: 0, wheel: 1, text: 2, key: 2 } as const;

/**
 * Inputs dispatched just before the page clock advances to frame `n`: a hover
 * move when the cursor moved since the previous frame (always on frame 0, or
 * when `forceMove`), then clicks, scrolls, typed characters and key presses
 * whose time falls in (t(n-1), t(n)], in time order. Mouse events happen at
 * the cursor's position at t(n).
 */
export function frameInputs(cursor: CursorObject | undefined, fps: number, n: number, forceMove = false): PageInput[] {
  if (!cursor) return [];
  const t = frameTime(n, fps);
  const prevT = n === 0 ? -Infinity : frameTime(n - 1, fps);
  const [x, y] = sample(cursor.position, t);
  const out: PageInput[] = [];
  let moved = forceMove || n === 0;
  if (!moved) {
    const [px, py] = sample(cursor.position, prevT);
    moved = Math.abs(px - x) >= 0.5 || Math.abs(py - y) >= 0.5;
  }
  if (moved) out.push({ type: 'move', x, y });

  const events: { time: number; order: number; input: PageInput }[] = [];
  for (const c of eventsBetween(cursor.clicks, prevT, t))
    events.push({ time: c.time, order: ORDER.click, input: { type: 'click', x, y } });
  for (const s of eventsBetween(cursor.scrolls, prevT, t)) {
    events.push({ time: s.time, order: ORDER.wheel, input: { type: 'wheel', x, y, deltaY: s.deltaY } });
  }
  for (const k of cursor.keys ?? []) {
    if (k.kind === 'press') {
      if (k.time > prevT && k.time <= t)
        events.push({ time: k.time, order: ORDER.key, input: { type: 'key', key: k.key } });
      continue;
    }
    // Character i is typed at time + i / cps.
    const chars = [...k.text];
    for (let i = 0; i < chars.length; i++) {
      const ct = k.time + i / k.cps;
      if (ct > t) break;
      if (ct > prevT) events.push({ time: ct, order: ORDER.text, input: { type: 'text', text: chars[i] } });
    }
  }
  events.sort((a, b) => a.time - b.time || a.order - b.order);
  for (const e of events) out.push(e.input);
  return out;
}

/**
 * Every page event of the cursor (clicks, scrolls, typed characters, key
 * presses) with time in (from, to], at its exact time, sorted. Mouse events
 * carry the cursor position at their own time (the live preview's view).
 */
export function cursorEvents(
  cursor: CursorObject | undefined,
  from: number,
  to: number,
): { time: number; input: PageInput }[] {
  if (!cursor) return [];
  const events: { time: number; order: number; input: PageInput }[] = [];
  const at = (t: number) => sample(cursor.position, t);
  for (const c of eventsBetween(cursor.clicks, from, to)) {
    const [x, y] = at(c.time);
    events.push({ time: c.time, order: ORDER.click, input: { type: 'click', x, y } });
  }
  for (const s of eventsBetween(cursor.scrolls, from, to)) {
    const [x, y] = at(s.time);
    events.push({ time: s.time, order: ORDER.wheel, input: { type: 'wheel', x, y, deltaY: s.deltaY } });
  }
  for (const k of cursor.keys ?? []) {
    if (k.kind === 'press') {
      if (k.time > from && k.time <= to)
        events.push({ time: k.time, order: ORDER.key, input: { type: 'key', key: k.key } });
      continue;
    }
    const chars = [...k.text];
    for (let i = 0; i < chars.length; i++) {
      const ct = k.time + i / k.cps;
      if (ct > to) break;
      if (ct > from) events.push({ time: ct, order: ORDER.text, input: { type: 'text', text: chars[i] } });
    }
  }
  events.sort((a, b) => a.time - b.time || a.order - b.order);
  return events.map(({ time, input }) => ({ time, input }));
}
