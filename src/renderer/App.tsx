import { Layers, MousePointer2, PanelLeft, PanelRight, Type } from 'lucide-react';
import { useEffect } from 'react';
import { cursorFor } from '../engine/project';
import { addText, cancelExport, closePreview, saveBeforeClose, useExportProgress } from './actions';
import { useAutosave } from './autosave';
import { resize, toggleLeft, toggleRight, toggleTimeline, useLayout } from './layout';
import { useShortcuts } from './shortcuts';
import { getEditor, isDirty, select, setEditor, useEditor } from './store';
import { ExportPanel } from './ui/ExportPanel';
import { Hierarchy } from './ui/Hierarchy';
import { Home } from './ui/Home';
import { Inspector } from './ui/Inspector';
import { Splitter } from './ui/Splitter';
import { Timeline, TIMELINE_HEADER_HEIGHT } from './ui/Timeline';
import { TopBar } from './ui/TopBar';
import { Viewport } from './ui/Viewport';

/** Keeps the main process informed so closing with unsaved changes can warn. */
function useDirtySync(): void {
  // When the user closes the window and chooses "Save and close", the main process asks us to save.
  useEffect(() => {
    window.looit.project.onSaveRequest(saveBeforeClose);
  }, []);
  useEffect(() => {
    let last = false;
    return useEditor.subscribe((s) => {
      const dirty = isDirty(s);
      if (dirty !== last) {
        last = dirty;
        window.looit.project.setDirty(dirty);
      }
    });
  }, []);
}

/** Esc leaves the preview; so does the browser dropping out of full screen. */
function usePreviewKeys(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closePreview();
    };
    // Chromium exits full screen on its own (Esc, F11); follow it.
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) closePreview();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [active]);
}

function LeftRail() {
  const leftOpen = useLayout((s) => s.leftOpen && !s.maximized);
  const rightOpen = useLayout((s) => s.rightOpen && !s.maximized);
  const cursorTool = useEditor((s) => s.tool === 'cursor');
  return (
    <nav className="rail">
      <button
        className={`rail-btn${leftOpen ? ' active' : ''}`}
        title="Show/hide the scene panel (T)"
        onClick={toggleLeft}
      >
        <Layers size={18} />
        <span>Scene</span>
      </button>
      <button className="rail-btn" title="Add a text object" onClick={addText}>
        <Type size={18} />
        <span>Text</span>
      </button>
      <button
        className={`rail-btn${cursorTool ? ' active' : ''}`}
        title="Cursor tool: drag the virtual cursor on the website (C)"
        onClick={() => {
          // The cursor of the selected panel (or of the cursor's own panel), else the first one.
          const { project, selectedId } = getEditor();
          const selected = project.objects.find((o) => o.id === selectedId);
          const cursor =
            (selected?.kind === 'cursor' && selected) ||
            (selected?.kind === 'website' && cursorFor(project, selected.id)) ||
            project.objects.find((o) => o.kind === 'cursor');
          select(cursor ? cursor.id : null);
          setEditor({ tool: 'cursor' });
        }}
      >
        <MousePointer2 size={18} />
        <span>Cursor</span>
      </button>
      <div className="rail-spacer" />
      <button
        className={`rail-btn${rightOpen ? ' active' : ''}`}
        title="Show/hide properties (N)"
        onClick={toggleRight}
      >
        <PanelRight size={18} />
        <span>Props</span>
      </button>
      <button className="rail-btn" title="Show/hide the timeline" onClick={toggleTimeline}>
        <PanelLeft size={18} style={{ transform: 'rotate(-90deg)' }} />
        <span>Timeline</span>
      </button>
    </nav>
  );
}

function ExportOverlay() {
  const { active, done, total, label } = useExportProgress();
  if (!active) return null;
  return (
    <div className="overlay">
      <div className="overlay-card">
        <strong>Exporting video</strong>
        <div className="muted">{label}</div>
        <progress max={1} value={total ? done / total : 0} />
        <button onClick={cancelExport}>Cancel</button>
      </div>
    </div>
  );
}

function StatusBar() {
  const status = useEditor((s) => s.status);
  return <footer className={`statusbar${status?.error ? ' error' : ''}`}>{status?.text ?? 'Ready'}</footer>;
}

export function App() {
  useShortcuts();
  useDirtySync();
  useAutosave();
  const layout = useLayout();
  const view = useEditor((s) => s.view);
  const preview = useEditor((s) => s.previewFullscreen);
  usePreviewKeys(preview);
  const left = layout.leftOpen && !layout.maximized;
  const right = layout.rightOpen && !layout.maximized;
  const timeline = layout.timelineOpen && !layout.maximized;

  if (view === 'home') return <Home />;

  return (
    <div
      className={`app${preview ? ' preview-mode' : ''}`}
      style={{
        gridTemplateColumns: preview
          ? '1fr'
          : `64px ${left ? layout.leftWidth : 0}px minmax(300px, 1fr) ${right ? layout.rightWidth : 0}px`,
        gridTemplateRows: preview
          ? '1fr'
          : `48px minmax(160px, 1fr) ${timeline ? layout.timelineHeight : TIMELINE_HEADER_HEIGHT}px 24px`,
      }}
    >
      <TopBar />
      <LeftRail />
      {left ? (
        <div className="area-tree">
          <Hierarchy />
          <Splitter
            edge="right"
            size={layout.leftWidth}
            onResize={(v) => resize('leftWidth', v)}
            onDoubleClick={toggleLeft}
          />
        </div>
      ) : (
        <div className="area-tree collapsed" />
      )}
      <Viewport readOnly={preview} />
      {preview && (
        <div className="preview-hint">
          <span>Preview · looping</span>
          <kbd>Esc</kbd> to exit
        </div>
      )}
      {right ? (
        <aside className="right">
          <Splitter
            edge="left"
            size={layout.rightWidth}
            onResize={(v) => resize('rightWidth', v)}
            onDoubleClick={toggleRight}
          />
          <Inspector />
          <ExportPanel />
        </aside>
      ) : (
        <div className="right collapsed" />
      )}
      <div className="area-time">
        {timeline && (
          <Splitter
            edge="top"
            size={layout.timelineHeight}
            onResize={(v) => resize('timelineHeight', v)}
            onDoubleClick={toggleTimeline}
          />
        )}
        <Timeline collapsed={!timeline} />
      </div>
      <StatusBar />
      <ExportOverlay />
    </div>
  );
}
