import { Cloud, CloudOff, Film, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { addText, deleteSelection, newFile, openFile, runExport, saveFile } from '../actions';
import { SHORTCUTS, SHOW_SHORTCUTS_EVENT } from '../shortcuts';
import { isDirty, redo, setPlaying, setTime, undo, useEditor } from '../store';
import { AiConnectDialog } from './AiConnect';

interface MenuItem {
  label: string;
  shortcut?: string;
  action(): void;
  disabled?: boolean;
}

function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className={`menu-btn${open ? ' open' : ''}`} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className="menu-list">
          {items.map((it) => (
            <button
              key={it.label}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.action();
              }}
            >
              <span>{it.label}</span>
              {it.shortcut && <span className="muted">{it.shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ShortcutSheet({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="overlay-card shortcut-sheet">
        <strong>Keyboard shortcuts</strong>
        {SHORTCUTS.map((g) => (
          <div key={g.group}>
            <h4>{g.group}</h4>
            {g.items.map(([keys, what]) => (
              <div className="row" key={keys}>
                <kbd>{keys}</kbd>
                <span>{what}</span>
              </div>
            ))}
          </div>
        ))}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export function TopBar() {
  const [showKeys, setShowKeys] = useState(false);
  const [showAi, setShowAi] = useState(false);
  useEffect(() => {
    const open = () => setShowKeys(true);
    window.addEventListener(SHOW_SHORTCUTS_EVENT, open);
    return () => window.removeEventListener(SHOW_SHORTCUTS_EVENT, open);
  }, []);
  const name = useEditor((s) => s.project.name);
  const dirty = useEditor((s) => isDirty(s));
  const hasFile = useEditor((s) => s.filePath !== null);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const playing = useEditor((s) => s.playing);
  const exporting = useEditor((s) => s.exporting);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">L</span>
        Looit
      </div>
      <nav className="menus">
        <Menu
          label="File"
          items={[
            { label: 'New project', shortcut: 'Ctrl+N', action: newFile },
            { label: 'Open…', shortcut: 'Ctrl+O', action: () => void openFile() },
            { label: 'Save', shortcut: 'Ctrl+S', action: () => void saveFile() },
            { label: 'Save as…', shortcut: 'Ctrl+Shift+S', action: () => void saveFile(true) },
            { label: 'Export video…', action: () => void runExport(), disabled: exporting },
          ]}
        />
        <Menu
          label="Edit"
          items={[
            { label: 'Undo', shortcut: 'Ctrl+Z', action: undo, disabled: !canUndo },
            { label: 'Redo', shortcut: 'Ctrl+Y', action: redo, disabled: !canRedo },
            { label: 'Delete', shortcut: 'Del', action: deleteSelection },
            { label: 'Add text', action: addText },
          ]}
        />
        <Menu
          label="Help"
          items={[
            { label: 'Keyboard shortcuts', shortcut: 'F1', action: () => setShowKeys(true) },
            { label: 'Connect an AI app…', action: () => setShowAi(true) },
          ]}
        />
      </nav>
      <div className="project-name" title={hasFile ? undefined : 'Not saved yet'}>
        {name}
        <span className={`save-state${dirty ? ' dirty' : ''}`}>
          {dirty ? <CloudOff size={14} /> : <Cloud size={14} />}
          {dirty ? 'Unsaved' : 'Saved'}
        </span>
      </div>
      <div className="topbar-actions">
        <button
          onClick={() => {
            if (playing) setPlaying(false);
            else {
              setTime(0);
              setPlaying(true);
            }
          }}
          disabled={exporting}
        >
          {playing ? <Square size={14} /> : <Play size={14} />} {playing ? 'Stop' : 'Preview'}
        </button>
        <button className="primary" onClick={() => void runExport()} disabled={exporting}>
          <Film size={14} /> Export Video
        </button>
      </div>
      {showKeys && <ShortcutSheet onClose={() => setShowKeys(false)} />}
      {showAi && <AiConnectDialog onClose={() => setShowAi(false)} />}
    </header>
  );
}
