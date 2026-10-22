// Keyboard shortcuts, following Blender's conventions where they exist.

import { useEffect } from 'react';
import {
  clearTransform,
  deleteKeysAtPlayhead,
  deleteSelection,
  duplicateSelection,
  hideSelection,
  insertKeyframes,
  jumpToKeyframe,
  newFile,
  openFile,
  saveFile,
  unhideAll,
} from './actions';
import { SPECIAL_KEYS, type SpecialKey } from '../engine/project';
import { toggleLeft, toggleMaximized, toggleRight } from './layout';
import { getEditor, redo, select, selectKeys, setEditor, setPlaying, setTime, undo } from './store';
import { isModalActive, modalKey, startModal } from './viewport/modal';
import { interactTarget } from './viewport/runtime';

/** Dispatched on window to open the shortcut sheet (F1). */
export const SHOW_SHORTCUTS_EVENT = 'looit:show-shortcuts';

/** Shown in Help → Keyboard shortcuts. */
export const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Transform (Blender style)',
    items: [
      ['G', 'Grab / move the selected object'],
      ['R', 'Rotate'],
      ['S', 'Scale'],
      ['then X / Y / Z', 'Lock to an axis (press again to unlock)'],
      ['then Shift+X / Y / Z', 'Lock to the other two axes'],
      ['then type a number', 'Exact distance, degrees or scale factor'],
      ['Enter / left-click', 'Confirm'],
      ['Esc / right-click', 'Cancel'],
      ['Alt+G / Alt+R / Alt+S', 'Reset position / rotation / scale'],
    ],
  },
  {
    group: 'Animation',
    items: [
      ['I', 'Insert keyframes at the playhead (position, rotation, scale; the cursor’s position; the camera)'],
      ['Alt+I', 'Delete the selected object’s keyframes at the playhead'],
      ['Space', 'Play / pause'],
      ['← / →', 'Previous / next frame'],
      ['↑ / ↓', 'Jump to next / previous keyframe'],
      ['Shift+← / Shift+→, Home / End', 'Jump to start / end'],
    ],
  },
  {
    group: 'Objects',
    items: [
      ['X / Delete', 'Delete the selected keyframes, or the selected text or website panel'],
      ['Shift+D', 'Duplicate text (then move it)'],
      ['H / Alt+H', 'Hide selected / show all'],
      ['Esc', 'Deselect'],
    ],
  },
  {
    group: 'Tools & layout',
    items: [
      ['Tab', 'Interact mode: use the live website yourself (click, scroll, type)'],
      ['Esc (in Interact mode)', 'Back to Select mode'],
      ['C', 'Cursor tool (drag the virtual cursor on the website)'],
      ['T / N', 'Show/hide the left panel / the properties panel'],
      ['Ctrl+Space', 'Maximize the viewport'],
      ['Wheel on timeline', 'Zoom the timeline (Ctrl+wheel: pan, Shift+wheel: scroll the rows)'],
    ],
  },
  {
    group: 'File',
    items: [
      ['Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y', 'Undo / redo'],
      ['Ctrl+S / Ctrl+Shift+S', 'Save / save as'],
      ['Ctrl+O / Ctrl+N', 'Open / new project'],
      ['F1', 'This list'],
    ],
  },
];

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function handle(e: KeyboardEvent): void {
  // A running G/R/S transform takes all keys.
  if (isModalActive() && modalKey(e)) return;

  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const s = getEditor();

  // The full-screen preview only listens for Esc (handled by the preview itself).
  if (s.previewFullscreen) return;

  if (ctrl && key === 's') return void (e.preventDefault(), saveFile(e.shiftKey));
  if (ctrl && key === 'o') return void (e.preventDefault(), openFile());
  if (ctrl && key === 'n') return void (e.preventDefault(), newFile());
  if (isTyping(e) || s.exporting) return;

  const done = () => e.preventDefault();

  // Interact mode: the keyboard types into the website; Esc leaves the mode.
  if (s.tool === 'interact' && !ctrl && !e.altKey) {
    const target = interactTarget();
    if (e.key === 'Escape') setEditor({ tool: 'select' });
    else if (!target) return;
    else if (e.key.length === 1) window.looit.site.input(target, [{ type: 'text', text: e.key }]);
    else if ((SPECIAL_KEYS as readonly string[]).includes(e.key)) {
      window.looit.site.input(target, [{ type: 'key', key: e.key as SpecialKey }]);
    } else return;
    return done();
  }

  if (ctrl) {
    if (key === 'z' && !e.shiftKey) undo();
    else if (key === 'y' || (key === 'z' && e.shiftKey)) redo();
    else if (e.key === ' ') toggleMaximized();
    else return;
    return done();
  }

  if (e.altKey) {
    if (key === 'g') clearTransform('position');
    else if (key === 'r') clearTransform('rotation');
    else if (key === 's') clearTransform('scale');
    else if (key === 'i') deleteKeysAtPlayhead();
    else if (key === 'h') unhideAll();
    else return;
    return done();
  }

  if (e.shiftKey && key === 'd') {
    if (duplicateSelection()) startModal('grab');
    return done();
  }

  switch (e.key) {
    case 'F1':
      window.dispatchEvent(new Event(SHOW_SHORTCUTS_EVENT));
      return done();
    case ' ':
      setPlaying(!s.playing);
      return done();
    case 'Delete':
    case 'Backspace':
      deleteSelection();
      return done();
    case 'Home':
      setTime(0);
      return done();
    case 'End':
      setTime(s.project.duration);
      return done();
    case 'ArrowLeft':
    case 'ArrowRight': {
      const right = e.key === 'ArrowRight';
      if (e.shiftKey) setTime(right ? s.project.duration : 0);
      else setTime(s.time + (right ? 1 : -1) / s.project.output.fps);
      return done();
    }
    case 'ArrowUp':
    case 'ArrowDown':
      jumpToKeyframe(e.key === 'ArrowUp' ? 1 : -1);
      return done();
    case 'Tab':
      setEditor({ tool: s.tool === 'interact' ? 'select' : 'interact' });
      return done();
    case 'Escape':
      if (s.selectedKeys.length) selectKeys([]);
      else select(null);
      return done();
  }

  switch (key) {
    case 'g':
      startModal('grab');
      break;
    case 'r':
      startModal('rotate');
      break;
    case 's':
      startModal('scale');
      break;
    case 'x':
      deleteSelection();
      break;
    case 'i':
      insertKeyframes();
      break;
    case 'h':
      hideSelection();
      break;
    case 'c':
      setEditor({ tool: 'cursor' });
      break;
    case 't':
      toggleLeft();
      break;
    case 'n':
      toggleRight();
      break;
    default:
      return;
  }
  done();
}

export function useShortcuts(): void {
  useEffect(() => {
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);
}
