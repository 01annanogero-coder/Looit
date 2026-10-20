// Shared rendering runtime: one WebGL renderer, one scene and a live texture
// per website panel, used by the viewport for preview and by the exporter for
// output. Also keeps each panel's preview website in sync with the timeline.

import * as THREE from 'three';
import { cursorEvents } from '../../engine/inputs';
import { cursorFor, sample, websites, type CursorObject, type Project } from '../../engine/project';
import type { TimedInput } from '../../shared/ipc';
import { SiteTexture } from '../site-texture';
import { getEditor, setStatus, useEditor } from '../store';
import { SceneView } from './scene-view';

export const view = new SceneView();
let renderer: THREE.WebGLRenderer | null = null;

/** Live (and export) textures, one per website panel. */
const siteTextures = new Map<string, SiteTexture>();

export function siteTexture(websiteId: string): SiteTexture {
  let t = siteTextures.get(websiteId);
  if (!t) {
    t = new SiteTexture();
    siteTextures.set(websiteId, t);
  }
  return t;
}

export function getRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  return renderer;
}

export function currentRenderer(): THREE.WebGLRenderer | null {
  return renderer;
}

// ---- Live website frames ----------------------------------------------------------

const frameWaiters: { websiteId: string; resolve(): void }[] = [];

window.looit.site.onFrame((frame) => {
  if (!getEditor().exporting) {
    const t = siteTexture(frame.websiteId);
    if (t.update(frame)) view.setWebsiteTexture(frame.websiteId, t.texture);
    for (let i = frameWaiters.length - 1; i >= 0; i--) {
      if (frameWaiters[i].websiteId === frame.websiteId) frameWaiters.splice(i, 1)[0].resolve();
    }
  }
  window.looit.site.ackFrame(frame.websiteId);
});

/** Resolves when the next frame of a website arrives (or after `timeoutMs`). */
export function nextWebsiteFrame(websiteId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const waiter = { websiteId, resolve };
    frameWaiters.push(waiter);
    setTimeout(() => {
      const i = frameWaiters.indexOf(waiter);
      if (i >= 0) frameWaiters.splice(i, 1);
      resolve();
    }, timeoutMs);
  });
}

window.looit.site.onStatus((s) => {
  if (s.url && !s.url.startsWith('about:')) view.pageUrls.set(s.websiteId, s.url);
  setStatus(s.error ? { text: s.error, error: true } : { text: s.loading ? `Loading ${s.url}…` : s.title || s.url });
});

// ---- Timeline-synced preview --------------------------------------------------------

/** Hover moves replayed before each click/scroll, so hover menus are open as they would be. */
const HOVER_LEAD = [0.3, 0.2, 0.1];

/** Every page interaction of a cursor (clicks, scrolls, typing, keys) at its exact time. */
export function previewEvents(cursor: CursorObject | undefined): TimedInput[] {
  if (!cursor) return [];
  const out: TimedInput[] = [];
  for (const e of cursorEvents(cursor, -Infinity, Infinity)) {
    // Hover the pointer there first, so hover menus are open as they would be.
    if (e.input.type === 'click' || e.input.type === 'wheel') {
      for (const lead of HOVER_LEAD) {
        if (e.time - lead >= 0) {
          const [x, y] = sample(cursor.position, e.time - lead);
          out.push({ time: e.time - lead, input: { type: 'move', x, y } });
        }
      }
    }
    out.push(e);
  }
  // Stable sort keeps hover moves before the event at the same time.
  return out.sort((x, y) => x.time - y.time);
}

function syncPreview(reload = false): void {
  const s = getEditor();
  if (s.exporting || s.tool === 'interact') return;
  const panels = websites(s.project);
  const live = panels.filter((w) => w.url !== '');
  window.looit.site.keep(live.map((w) => w.id));
  for (const website of panels) {
    if (!website.url) {
      // A blank browser card: no page to load, and no frame left over from a
      // website that used to be on this panel.
      const stale = siteTextures.get(website.id);
      if (stale) {
        stale.texture?.dispose();
        siteTextures.delete(website.id);
      }
      view.setWebsiteTexture(website.id, null);
      view.pageUrls.delete(website.id);
      continue;
    }
    const cursor = cursorFor(s.project, website.id);
    const hover = cursor ? sample(cursor.position, s.time) : null;
    window.looit.site.sync({
      websiteId: website.id,
      url: website.url,
      viewport: website.viewport,
      time: s.time,
      events: previewEvents(cursor),
      hover: hover ? { x: hover[0], y: hover[1] } : null,
      reload,
    });
  }
  // Forget textures of deleted panels.
  for (const id of siteTextures.keys()) {
    if (!panels.some((w) => w.id === id)) {
      siteTextures.get(id)?.texture?.dispose();
      siteTextures.delete(id);
      view.setWebsiteTexture(id, null);
    }
  }
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSync(delayMs: number): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncPreview();
  }, delayMs);
}

/** Sends the playhead to the preview websites now (no debounce). */
export function flushPreviewSync(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  syncPreview();
}

/** Reloads the preview websites from scratch (Reload button). */
export function reloadWebsite(): void {
  syncPreview(true);
}

// Playback ticks are throttled to ~30 per second; page events in between are kept.
const pendingInputs = new Map<string, TimedInput[]>();
let lastTickSent = 0;
export function playbackTick(project: Project, prev: number, next: number): void {
  const panels = websites(project);
  for (const w of panels) {
    const cursor = cursorFor(project, w.id);
    if (!cursor) continue;
    const list = pendingInputs.get(w.id) ?? [];
    list.push(...cursorEvents(cursor, prev, next));
    pendingInputs.set(w.id, list);
  }
  const now = performance.now();
  if (now - lastTickSent < 30) return;
  lastTickSent = now;
  for (const w of panels) {
    const cursor = cursorFor(project, w.id);
    const inputs = pendingInputs.get(w.id) ?? [];
    if (cursor) {
      const [x, y] = sample(cursor.position, next);
      inputs.push({ time: next, input: { type: 'move', x, y } });
    }
    pendingInputs.set(w.id, []);
    window.looit.site.advance({ websiteId: w.id, time: next, inputs });
  }
}

useEditor.subscribe((s, prev) => {
  if (s.tool !== prev.tool) window.looit.site.setInteractive(s.tool === 'interact');
  if (s.exporting || s.tool === 'interact') return;
  const resumed = (prev.playing && !s.playing) || (prev.exporting && !s.exporting) || prev.tool === 'interact';
  if (s.playing) {
    // Jumping during playback (e.g. back to start) needs a resync.
    if (!prev.playing || s.time < prev.time) syncPreview();
    return;
  }
  if (resumed) syncPreview();
  else if (s.project !== prev.project) scheduleSync(150);
  else if (s.time !== prev.time) scheduleSync(40);
});

export function startLiveWebsite(): void {
  window.looit.site.setInteractive(getEditor().tool === 'interact');
  syncPreview();
}

// ---- Interact mode ----------------------------------------------------------------

let activeWebsite: string | null = null;

/** The website panel the user last clicked in Interact mode (keyboard input goes there). */
export function setActiveWebsite(id: string): void {
  activeWebsite = id;
}

export function interactTarget(): string | null {
  const ids = websites(getEditor().project).map((w) => w.id);
  return activeWebsite && ids.includes(activeWebsite) ? activeWebsite : (ids[0] ?? null);
}
