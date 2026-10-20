// The AI Studio window's side of the AI connection: it holds the AI's project
// (in this window's own store, separate from the user's editor) and carries
// out the main process's requests: load, seek, play, screenshot, export.

import { create } from 'zustand';
import { websites } from '../../engine/project';
import { parseProject, serializeProject } from '../../engine/schema';
import type { StudioStatus } from '../../shared/ipc';
import { exportVideo } from '../exporter';
import { getEditor, loadProject, setEditor, setPlaying, setStatus } from '../store';
import { currentRenderer, flushPreviewSync, nextWebsiteFrame, siteTexture, view } from '../viewport/runtime';

interface StudioState {
  export: StudioStatus['export'];
  /** The finished video, played in the window until the project changes. */
  videoUrl: string | null;
  /** What the AI did last, shown in the window's header. */
  activity: string;
}

export const useStudio = create<StudioState>(() => ({
  export: { phase: 'idle', done: 0, total: 0 },
  videoUrl: null,
  activity: 'Waiting for the AI to start a project…',
}));

/** Longest edge of scene screenshots sent to the AI. */
const SCREENSHOT_WIDTH = 1280;

function clampTime(t: unknown): number {
  const d = getEditor().project.duration;
  const n = typeof t === 'number' && Number.isFinite(t) ? t : 0;
  return Math.min(Math.max(n, 0), d);
}

function seek(time: number): void {
  setPlaying(false);
  setEditor({ time });
  flushPreviewSync();
}

function status(): StudioStatus {
  const s = getEditor();
  return {
    projectName: s.project.name,
    duration: s.project.duration,
    time: s.time,
    playing: s.playing,
    export: useStudio.getState().export,
  };
}

/** Renders the scene at `time` once every website has reached it; returns a JPEG data URL. */
async function screenshot(time: number): Promise<string> {
  const renderer = currentRenderer();
  if (!renderer) throw new Error('The studio is still starting.');
  seek(time);
  const { project } = getEditor();
  await window.looit.studio.settle();
  await Promise.all(websites(project).map((w) => nextWebsiteFrame(w.id, 1500)));
  await view.prepare(project);

  const canvas = renderer.domElement;
  const prevRatio = renderer.getPixelRatio();
  const prevSize = { w: canvas.width, h: canvas.height };
  const prevAspect = view.camera.aspect;
  const w = Math.min(project.output.width, SCREENSHOT_WIDTH);
  const h = Math.round((w * project.output.height) / project.output.width);
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    view.setAspect(w / h);
    view.sync(project, time, { selectedId: null, showHelpers: false });
    renderer.render(view.scene, view.camera);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    renderer.setPixelRatio(prevRatio);
    renderer.setSize(prevSize.w / prevRatio, prevSize.h / prevRatio, false);
    view.setAspect(prevAspect);
  }
}

async function runExport(fileName: string): Promise<void> {
  const renderer = currentRenderer();
  const set = (e: Partial<StudioStatus['export']>) => useStudio.setState((s) => ({ export: { ...s.export, ...e } }));
  if (!renderer) {
    set({ phase: 'failed', error: 'The studio is still starting.' });
    return;
  }
  setPlaying(false);
  useStudio.setState({
    videoUrl: null,
    export: { phase: 'choosing', done: 0, total: 0 },
    activity: 'Choose where to save the video',
  });
  let file: { id: number; path: string } | null;
  try {
    file = await window.looit.exporter.createFile(fileName);
  } catch (err) {
    set({ phase: 'failed', error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!file) {
    set({ phase: 'cancelled' });
    useStudio.setState({ activity: 'Export cancelled' });
    return;
  }
  setEditor({ exporting: true });
  set({ phase: 'exporting', path: file.path });
  useStudio.setState({ activity: 'Rendering the video…' });
  const started = performance.now();
  let ok = false;
  let error: string | undefined;
  try {
    await exportVideo({
      project: getEditor().project,
      fileId: file.id,
      view,
      renderer,
      siteTexture,
      onProgress: (done, total) => set({ done, total }),
    });
    ok = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const url = await window.looit.exporter.closeFile(file.id, ok).catch(() => null);
  setEditor({ exporting: false });
  window.looit.site.refresh();
  if (ok) {
    set({ phase: 'done', seconds: Math.round((performance.now() - started) / 100) / 10 });
    useStudio.setState({ videoUrl: url, activity: `Video saved to ${file.path}` });
  } else {
    set({ phase: 'failed', error });
    useStudio.setState({ activity: `Export failed: ${error}` });
  }
}

export function registerStudioCommands(): void {
  window.looit.ai.onRequest(async (method, raw) => {
    const params = (raw ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'load': {
        if (getEditor().exporting) throw new Error('An export is running.');
        const project = parseProject(String(params.project));
        loadProject(project, null);
        setEditor({ selectedId: null, time: clampTime(params.time) });
        useStudio.setState({ videoUrl: null, activity: 'The AI updated the project' });
        setStatus(null);
        flushPreviewSync();
        return true;
      }
      case 'get':
        return serializeProject(getEditor().project);
      case 'status':
        return status();
      case 'seek':
        if (params.show === true) useStudio.setState({ videoUrl: null });
        seek(clampTime(params.time));
        return true;
      case 'play':
        useStudio.setState({ videoUrl: null, activity: 'Playing the preview' });
        seek(clampTime(params.time));
        setPlaying(true);
        return true;
      case 'screenshot':
        return screenshot(clampTime(params.time));
      case 'export': {
        const phase = useStudio.getState().export.phase;
        if (phase === 'choosing' || phase === 'exporting') throw new Error('An export is already running.');
        void runExport(typeof params.fileName === 'string' ? params.fileName : 'video');
        return true;
      }
      default:
        throw new Error(`Unknown studio request ${method}.`);
    }
  });
}
