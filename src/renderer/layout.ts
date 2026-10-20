// Panel sizes and visibility. Remembered per user in localStorage (a
// convenience only: the app works the same if storage is unavailable).

import { create } from 'zustand';

export interface Layout {
  leftOpen: boolean;
  rightOpen: boolean;
  timelineOpen: boolean;
  /** Ctrl+Space: viewport fills the window (panels hidden, sizes kept). */
  maximized: boolean;
  leftWidth: number;
  rightWidth: number;
  timelineHeight: number;
}

const KEY = 'looit.layout.v1';

const DEFAULTS: Layout = {
  leftOpen: true,
  rightOpen: true,
  timelineOpen: true,
  maximized: false,
  leftWidth: 250,
  rightWidth: 330,
  timelineHeight: 300,
};

export const LIMITS = {
  leftWidth: [180, 480],
  rightWidth: [260, 560],
  timelineHeight: [120, 900],
} as const;

function load(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Layout> | null;
    if (!saved || typeof saved !== 'object') return DEFAULTS;
    const num = (k: keyof typeof LIMITS) => {
      const v = saved[k];
      const [min, max] = LIMITS[k];
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : DEFAULTS[k];
    };
    const bool = (k: 'leftOpen' | 'rightOpen' | 'timelineOpen') =>
      typeof saved[k] === 'boolean' ? saved[k] : DEFAULTS[k];
    return {
      leftOpen: bool('leftOpen'),
      rightOpen: bool('rightOpen'),
      timelineOpen: bool('timelineOpen'),
      maximized: false,
      leftWidth: num('leftWidth'),
      rightWidth: num('rightWidth'),
      timelineHeight: num('timelineHeight'),
    };
  } catch {
    return DEFAULTS;
  }
}

export const useLayout = create<Layout>(load);

useLayout.subscribe((s) => {
  try {
    const { maximized: _, ...rest } = s;
    localStorage.setItem(KEY, JSON.stringify(rest));
  } catch {
    // Storage unavailable; layout just won't be remembered.
  }
});

export function toggleLeft(): void {
  useLayout.setState((s) => ({ leftOpen: !s.leftOpen || s.maximized, maximized: false }));
}

export function toggleRight(): void {
  useLayout.setState((s) => ({ rightOpen: !s.rightOpen || s.maximized, maximized: false }));
}

export function toggleTimeline(): void {
  useLayout.setState((s) => ({ timelineOpen: !s.timelineOpen || s.maximized, maximized: false }));
}

export function toggleMaximized(): void {
  useLayout.setState((s) => ({ maximized: !s.maximized }));
}

export function resize(key: keyof typeof LIMITS, value: number): void {
  const [min, max] = LIMITS[key];
  useLayout.setState({ [key]: Math.min(Math.max(value, min), max) } as Partial<Layout>);
}
