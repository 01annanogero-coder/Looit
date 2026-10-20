// Hosts the user's website in isolated, offscreen Chromium pages.
//
// Live page: every paint is forwarded to the editor as a bitmap for preview.
// Export page: a fresh page per export whose clock is driven by Chromium's
// virtual time and advanced exactly one video frame at a time. CSS/Web
// Animations are frozen and stepped by the same amount, so the page's timers,
// requestAnimationFrame, CSS animations and transitions all line up with the
// exported frames regardless of how fast the machine renders.

import { BrowserWindow, nativeImage, session, type Debugger, type NativeImage, type WebContents } from 'electron';
import type {
  EncodedFrame,
  ExportBeginResult,
  ExportStepResult,
  PageInput,
  PreviewAdvance,
  PreviewTarget,
  ScrollSinceInteract,
  SiteFrame,
  SiteStatus,
} from '../shared/ipc';
import { websites, type Project, type SpecialKey } from '../engine/project';
import { ExportSession } from './export-session';
import { InputQueue } from './input-queue';
import { PREVIEW_FPS, PreviewController } from './preview';
import { withTimeout } from './util';

const PARTITION = 'persist:websites';
/**
 * Runs in every page before its own scripts. Under the frozen (virtual) page
 * clock, Chromium passes requestAnimationFrame callbacks a timestamp that
 * doesn't advance, so code that animates by elapsed frame time (smooth-scroll
 * libraries such as Lenis, many JS animations) never moves. Callbacks get the
 * page clock instead: one timestamp per frame, shared by all its callbacks,
 * as the standard requires. The time is performance.now() snapped to 1/240 s:
 * every frame time (30/60 fps, after the 1 s settle) lies on that grid, and
 * snapping removes performance.now()'s random sub-millisecond jitter, which
 * would otherwise move eased motion by a pixel between exports.
 */
const RAF_CLOCK_SCRIPT = `(() => {
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const STEP = 1000 / 240;
  let queue = new Map();
  let nextId = 1;
  let scheduled = false;
  const run = () => {
    scheduled = false;
    const now = Math.round(performance.now() / STEP) * STEP;
    const callbacks = queue;
    queue = new Map();
    for (const callback of callbacks.values()) {
      try {
        callback(now);
      } catch (err) {
        reportError(err);
      }
    }
  };
  window.requestAnimationFrame = function requestAnimationFrame(callback) {
    if (typeof callback !== 'function') return nativeRequest(callback);
    const id = nextId++;
    queue.set(id, callback);
    if (!scheduled) {
      scheduled = true;
      nativeRequest(run);
    }
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    queue.delete(id);
  };
})();`;

/** Real-time limit for one virtual-time step (pages with endless fetches). */
const STEP_TIMEOUT_MS = 15_000;
const CAPTURE_TIMEOUT_MS = 10_000;
/**
 * Website copies rendering an export in parallel. Parallel output is verified
 * identical (scripts/determinism-test.mjs), but inside the app the copies
 * compete with the editor's rendering and encoding: measured on an 8-core PC,
 * 3 copies were ~10% faster on a light page and up to 2x slower on a page that
 * redraws every frame. So the default is 1; LOOIT_EXPORT_WORKERS overrides.
 */
export function exportWorkerCount(): number {
  const forced = Number(process.env.LOOIT_EXPORT_WORKERS);
  if (Number.isInteger(forced) && forced >= 1 && forced <= 8) return forced;
  return 1;
}

/**
 * Export pages render at this frame rate: Page.captureScreenshot waits for a
 * fresh frame, which takes ~50 ms at 240 Hz versus ~90-135 ms at 60 Hz.
 * (Copying the latest frame after waiting for animation frames was faster but
 * occasionally returned the previous frame under load, so it is not used.)
 */
const FAST_CAPTURE_FPS = Number(process.env.LOOIT_EXPORT_PAGE_FPS) || 240;

/**
 * Advances every running animation in the page by `dt` ms (their timeline is frozen).
 * Style is flushed first: CSS transitions only start at a style update, and
 * without the flush a transition triggered by a click or timer in this step
 * would be stepped or not depending on whether Chromium happened to update
 * style yet, making frames differ between runs.
 */
const STEP_ANIMATIONS = (dt: number) => `(() => {
  void document.documentElement.getBoundingClientRect();
  for (const a of document.getAnimations()) {
    if (a.playState === 'running') a.currentTime = (a.currentTime ?? 0) + ${dt} * a.playbackRate;
  }
})()`;

/** DevTools network events that mean the page may be about to change. */
const NETWORK_ACTIVITY = new Set([
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.dataReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Network.webSocketFrameReceived',
  'Network.eventSourceMessageReceived',
]);

/**
 * Installs the change watcher (runs in an isolated world): counts scroll
 * events and resource loads. DOM changes are detected through Chromium's
 * style-recalculation and layout counters instead of a MutationObserver: any
 * DOM change that alters pixels triggers one of them (text and element changes
 * cause layout), except image swaps, which the load listener catches. A
 * MutationObserver, even switched on only for checked frames, nearly doubled
 * export time on pages that change the DOM on every animation frame.
 */
const WATCH_INSTALL = `(() => {
  const w = (window.__looitWatch = { scrolls: 0, loads: 0, x: scrollX, y: scrollY });
  document.addEventListener('scroll', () => { w.scrolls++; }, { capture: true, passive: true });
  // An image (re)loading, e.g. a src swap served from cache, repaints without layout.
  document.addEventListener('load', () => { w.loads++; }, { capture: true, passive: true });
  return true;
})()`;

/** Content that can change pixels without DOM, style, layout or animation signals. */
const DYNAMIC_SELECTOR =
  'canvas, video, iframe, frame, embed, object, marquee, animate, animateMotion, animateTransform, set, ' +
  'img[src*=".gif" i], img[src*=".apng" i], img[srcset*=".gif" i]';

/**
 * Reads and resets the watcher's counters. `rescan`: also look for dynamic
 * content, including inside shadow roots (only needed after a change).
 */
const WATCH_READ = (
  rescan: boolean,
) => `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => Promise.resolve().then(() => {
  const w = window.__looitWatch;
  const quiet = !!w && w.scrolls === 0 && w.loads === 0 && w.x === scrollX && w.y === scrollY &&
    !document.getAnimations().some((a) => a.playState === 'running' || a.pending);
  if (w) { w.scrolls = 0; w.loads = 0; w.x = scrollX; w.y = scrollY; }
  let dynamic = false;
  if (${rescan}) {
    const roots = [document];
    for (let i = 0; i < roots.length && !dynamic; i++) {
      if (roots[i].querySelector(${JSON.stringify(DYNAMIC_SELECTOR)})) dynamic = true;
      for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  resolve({ quiet, dynamic });
}))))`;

/** Windows virtual key codes (and typed text) for the special keys the cursor can press. */
const KEY_CODES: Record<SpecialKey, { vk: number; text?: string }> = {
  Enter: { vk: 13, text: '\r' },
  Tab: { vk: 9 },
  Backspace: { vk: 8 },
  Delete: { vk: 46 },
  Escape: { vk: 27 },
  ArrowUp: { vk: 38 },
  ArrowDown: { vk: 40 },
  ArrowLeft: { vk: 37 },
  ArrowRight: { vk: 39 },
  Home: { vk: 36 },
  End: { vk: 35 },
  PageUp: { vk: 33 },
  PageDown: { vk: 34 },
};

export function isAllowedSiteUrl(url: string, allowFile: boolean): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' || (allowFile && protocol === 'file:');
  } catch {
    return false;
  }
}

function lockDownSession(): void {
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
}

/** A website frame before it is tagged with its panel. */
export type RawFrame = Omit<SiteFrame, 'websiteId'>;

function toFrame(image: NativeImage): RawFrame {
  const { width, height } = image.getSize();
  return { width, height, data: image.toBitmap() };
}

/** One sandboxed offscreen page with an exact viewport, driven over the DevTools protocol. */
export class SitePage {
  readonly win: BrowserWindow;
  readonly wc: WebContents;
  private readonly dbg: Debugger;
  private budgetWaiter: (() => void) | null = null;
  private viewport = { width: 1280, height: 720 };
  private scale = 1;

  constructor(private readonly allowFile: boolean) {
    this.win = new BrowserWindow({
      show: false,
      frame: false,
      width: 1280,
      height: 720,
      webPreferences: {
        offscreen: true,
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    this.wc = this.win.webContents;
    this.dbg = this.wc.debugger;
    this.wc.setAudioMuted(true);
    this.dbg.attach('1.3');
    this.dbg.on('message', (_event, method) => {
      if (method === 'Emulation.virtualTimeBudgetExpired') {
        const w = this.budgetWaiter;
        this.budgetWaiter = null;
        w?.();
      } else if (NETWORK_ACTIVITY.has(method)) {
        this.networkEvents++;
      }
    });

    this.wc.setWindowOpenHandler(({ url }) => {
      // Popups open in the same panel instead of a new window.
      if (isAllowedSiteUrl(url, this.allowFile)) void this.wc.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    this.wc.on('will-navigate', (event, url) => {
      if (!isAllowedSiteUrl(url, this.allowFile)) event.preventDefault();
    });
    // The window is limited to the screen's work area, so the exact viewport is
    // set by emulation. It can only be applied once a page exists.
    this.wc.on('did-navigate', () => {
      // A new document: its watcher is gone and everything counts as changed.
      this.watchContextId = null;
      this.navigated = true;
      void this.applyViewport();
    });
    this.wc.on('did-navigate-in-page', () => {
      this.navigated = true;
    });
  }

  /**
   * Loads `url` with the page clock frozen from the very first moment, so the
   * page's timers, animations and Date.now() start from the same state on every
   * load (two loads produce identical frames). `epochMs` is the page's
   * Date.now() at time 0. Advance the clock afterwards to let it load and settle.
   */
  async loadFrozen(
    url: string,
    viewport: { width: number; height: number },
    scale: number,
    epochMs: number,
  ): Promise<void> {
    if (!isAllowedSiteUrl(url, this.allowFile)) throw new Error('Only http and https addresses are supported.');
    this.viewport = viewport;
    this.scale = scale;
    this.win.setContentSize(viewport.width, viewport.height);
    // Freeze on a blank page first; navigating there with the DevTools command
    // (not loadURL, which fails under a paused clock) keeps the clock frozen
    // across the navigation.
    await this.wc.loadURL('about:blank');
    await this.applyViewport();
    await this.send('Animation.enable');
    await this.send('Animation.setPlaybackRate', { playbackRate: 0 });
    // Offscreen pages aren't focused; emulate focus so typed text goes into fields.
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (!this.rafClockInstalled) {
      await this.send('Page.enable');
      await this.send('Page.addScriptToEvaluateOnNewDocument', { source: RAF_CLOCK_SCRIPT });
      this.rafClockInstalled = true;
    }
    await this.send('Emulation.setVirtualTimePolicy', { policy: 'pause', initialVirtualTime: epochMs / 1000 });
    const nav = (await this.send('Page.navigate', { url })) as { errorText?: string };
    if (nav.errorText) throw new Error(`Could not load the website (${nav.errorText}).`);
  }

  private async applyViewport(): Promise<void> {
    if (this.wc.isDestroyed() || !this.dbg.isAttached()) return;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: this.scale,
      mobile: false,
    }).catch(() => {});
  }

  async input(events: PageInput[]): Promise<void> {
    for (const ev of events) {
      if (ev.type === 'text') {
        for (const ch of ev.text) await this.typeCharacter(ch);
        continue;
      }
      if (ev.type === 'key') {
        await this.pressKey(ev.key);
        continue;
      }
      const pos = { x: ev.x, y: ev.y };
      const press = { ...pos, button: 'left', clickCount: 1 };
      switch (ev.type) {
        case 'move':
          await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pos });
          break;
        case 'down':
          await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...press });
          break;
        case 'up':
          await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...press });
          break;
        case 'click':
          await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...press });
          await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...press });
          break;
        case 'wheel':
          await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...pos, deltaX: 0, deltaY: ev.deltaY });
          break;
      }
    }
  }

  /** Types one character like a real keyboard (keydown with text, keyup), so pages see key events. */
  private async typeCharacter(ch: string): Promise<void> {
    if (ch === '\n') {
      await this.pressKey('Enter');
      return;
    }
    const code = /^[a-z]$/i.test(ch)
      ? `Key${ch.toUpperCase()}`
      : /^[0-9]$/.test(ch)
        ? `Digit${ch}`
        : ch === ' '
          ? 'Space'
          : '';
    const vk = /^[a-z0-9]$/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : ch === ' ' ? 32 : 0;
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: ch,
      code,
      text: ch,
      unmodifiedText: ch,
      windowsVirtualKeyCode: vk,
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
  }

  private async pressKey(key: SpecialKey): Promise<void> {
    const k = KEY_CODES[key];
    await this.send('Input.dispatchKeyEvent', {
      type: k.text ? 'keyDown' : 'rawKeyDown',
      key,
      code: key,
      windowsVirtualKeyCode: k.vk,
      ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: k.vk });
  }

  // ---- deterministic stepping ---------------------------------------------

  /** Re-applies the animation freeze (the new document after navigation). */
  async freezeAnimations(): Promise<void> {
    await this.send('Animation.enable');
    await this.send('Animation.setPlaybackRate', { playbackRate: 0 });
  }

  /**
   * Advances page time by `ms`. 'network' waits for pending requests (exact,
   * used for export and seeking); 'free' doesn't (real-time preview playback).
   * Returns false if a never-ending request forced a timeout.
   */
  async advance(ms: number, mode: 'network' | 'free' = 'network'): Promise<boolean> {
    if (ms <= 0) return true;
    if (mode === 'free') {
      const done = this.waitForBudget(STEP_TIMEOUT_MS);
      await this.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: ms });
      await done;
      await this.send('Runtime.evaluate', { expression: STEP_ANIMATIONS(ms), silent: true });
      return true;
    }
    const done = this.waitForBudget(STEP_TIMEOUT_MS);
    await this.send('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending', budget: ms });
    const completed = await done;
    if (!completed) {
      // Let the clock run regardless so the export can't hang. The frame is
      // still produced, just not network-exact.
      const forced = this.waitForBudget(STEP_TIMEOUT_MS);
      await this.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: ms });
      await forced;
    }
    await this.send('Runtime.evaluate', { expression: STEP_ANIMATIONS(ms), silent: true });
    return completed;
  }

  /** Renders a fresh frame of the current (frozen) page state. */
  async capture(): Promise<RawFrame> {
    // captureScreenshot forces a complete new frame (style, layout, rAF, paint);
    // the offscreen paint stream can lag behind the page state.
    const shot = (await withTimeout(
      this.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true }),
      CAPTURE_TIMEOUT_MS,
      'The website stopped rendering.',
    )) as { data: string };
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
    if (image.isEmpty()) throw new Error('The website did not render a frame.');
    return toFrame(image);
  }

  /**
   * Like `capture`, but returns the PNG bytes undecoded: decoding and the
   * 3.7 MB raw-pixel copy happen in the editor instead of the busy main process.
   */
  async capturePng(): Promise<EncodedFrame> {
    const shot = (await withTimeout(
      this.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true }),
      CAPTURE_TIMEOUT_MS,
      'The website stopped rendering.',
    )) as { data: string };
    const png = Buffer.from(shot.data, 'base64');
    // Size from the PNG header (IHDR): bytes 16-23, big-endian.
    if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) throw new Error('The website did not render a frame.');
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), png };
  }

  // ---- change tracking (frame reuse) ----------------------------------------

  private watchContextId: number | null = null;
  private networkEvents = 0;
  private navigated = false;
  private rafClockInstalled = false;
  private lastStyleCount = -1;
  private lastLayoutCount = -1;
  /** Cached: does the page contain content that can change without any signal we watch? */
  private dynamicContent = true;

  /** Starts watching for page changes. Call after load, before rendering frames. */
  async startChangeTracking(): Promise<void> {
    await this.send('Network.enable');
    await this.send('Performance.enable');
    await this.watcher();
    await this.pageChanged(); // establish baselines
  }

  /**
   * Whether anything that could change the page's pixels happened since the
   * previous call. Deliberately conservative: when unsure, it says "changed".
   * A false "unchanged" would reuse a stale frame, so every signal must be quiet:
   * no navigation, no network activity, no style recalculation or layout
   * (catches DOM and hover changes, including inside shadow DOM), no resource
   * loads, no scroll events, no running animations, and no content that can
   * change by itself without those signals (canvas, video, iframes, GIFs, SVG
   * animation).
   */
  async pageChanged(): Promise<boolean> {
    try {
      // 1. Let the page finish its pending frame work, then read the DOM watcher.
      const contextId = await this.watcher();
      const res = (await withTimeout(
        this.send('Runtime.evaluate', {
          contextId,
          returnByValue: true,
          awaitPromise: true,
          expression: WATCH_READ(true),
        }),
        CAPTURE_TIMEOUT_MS,
        'The website stopped rendering.',
      )) as { result?: { value?: { quiet: boolean; dynamic: boolean } }; exceptionDetails?: unknown };
      const value = res.result?.value;
      if (res.exceptionDetails || !value) {
        this.watchContextId = null;
        return true;
      }

      // 2. Chromium's own counters, read after that work ran.
      let changed = this.navigated || this.networkEvents > 0 || !value.quiet;
      this.navigated = false;
      this.networkEvents = 0;
      const { metrics } = (await this.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] };
      const metric = (name: string) => metrics.find((m) => m.name === name)?.value ?? -1;
      const style = metric('RecalcStyleCount');
      const layout = metric('LayoutCount');
      if (style < 0 || layout < 0 || style !== this.lastStyleCount || layout !== this.lastLayoutCount) changed = true;
      this.lastStyleCount = style;
      this.lastLayoutCount = layout;

      // The dynamic-content scan ran too; its answer replaces the cached one.
      this.dynamicContent = value.dynamic;
      return changed || this.dynamicContent;
    } catch {
      this.watchContextId = null;
      return true;
    }
  }

  /**
   * Lets the page draw: resolves after two animation frames, so the frame
   * after the latest change has been fully rendered (not captured). Some state
   * depends on being drawn, e.g. a text field's caret blink restarts when the
   * caret is first painted after typing.
   */
  async render(): Promise<void> {
    try {
      const contextId = await this.watcher();
      await withTimeout(
        this.send('Runtime.evaluate', {
          contextId,
          awaitPromise: true,
          expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))',
        }),
        CAPTURE_TIMEOUT_MS,
        'The website stopped rendering.',
      );
    } catch {
      this.watchContextId = null;
    }
  }

  /** Runs `expression` in the page's isolated world (it sees the DOM, not the page's scripts). */
  async evaluate(expression: string): Promise<unknown> {
    const contextId = await this.watcher();
    const r = (await withTimeout(
      this.send('Runtime.evaluate', { contextId, expression, returnByValue: true, awaitPromise: true }),
      CAPTURE_TIMEOUT_MS,
      'The website did not answer.',
    )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new Error(`Could not read the page: ${r.exceptionDetails.text ?? 'script error'}`);
    return r.result?.value;
  }

  /** How far the page is scrolled (CSS pixels) and its address. */
  async scrollPosition(): Promise<{ y: number; url: string }> {
    const contextId = await this.watcher();
    const r = (await this.send('Runtime.evaluate', {
      contextId,
      returnByValue: true,
      expression: '(document.scrollingElement ?? document.documentElement).scrollTop',
    })) as { result?: { value?: unknown } };
    const y = typeof r.result?.value === 'number' ? r.result.value : 0;
    return { y, url: this.wc.getURL() };
  }

  /** The isolated world holding the DOM watcher (invisible to and unaffected by the page). */
  private async watcher(): Promise<number> {
    if (this.watchContextId !== null) return this.watchContextId;
    const tree = (await this.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    const world = (await this.send('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: 'looit-change-watch',
    })) as { executionContextId: number };
    await this.send('Runtime.evaluate', { contextId: world.executionContextId, expression: WATCH_INSTALL });
    this.watchContextId = world.executionContextId;
    // A fresh watcher has seen nothing yet, so this step must count as changed.
    this.navigated = true;
    return this.watchContextId;
  }

  async pageTime(): Promise<number | undefined> {
    const res = (await this.send('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true }).catch(
      () => null,
    )) as { result?: { value?: number } } | null;
    return res?.result?.value;
  }

  destroy(): void {
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  private send(method: string, params?: object): Promise<unknown> {
    return this.dbg.sendCommand(method, params);
  }

  private waitForBudget(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.budgetWaiter === done) this.budgetWaiter = null;
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.budgetWaiter = done;
    });
  }
}

export interface WebsiteHostEvents {
  frame(frame: SiteFrame): void;
  status(status: SiteStatus): void;
}

export class WebsiteHost {
  /** One preview page controller per website panel. */
  private readonly previews = new Map<string, PreviewController>();
  private readonly inputQueues = new Map<string, InputQueue>();
  private exportSessions = new Map<string, ExportSession>();
  private interactive = false;
  private suspended = false;

  constructor(
    private readonly events: WebsiteHostEvents,
    private readonly allowFile: boolean,
  ) {
    lockDownSession();
  }

  private preview(websiteId: string): PreviewController {
    let p = this.previews.get(websiteId);
    if (!p) {
      p = new PreviewController(
        websiteId,
        () => {
          const page = new SitePage(this.allowFile);
          page.wc.setFrameRate(PREVIEW_FPS);
          return page;
        },
        this.events,
      );
      p.setInteractive(this.interactive);
      p.setSuspended(this.suspended);
      this.previews.set(websiteId, p);
      const controller = p;
      this.inputQueues.set(websiteId, new InputQueue((input) => controller.input(input)));
    }
    return p;
  }

  sync(target: PreviewTarget): void {
    this.preview(target.websiteId).sync(target);
  }

  advance(step: PreviewAdvance): void {
    this.previews.get(step.websiteId)?.advance(step);
  }

  /** Closes preview pages of panels that were deleted. */
  keep(websiteIds: string[]): void {
    for (const [id, p] of this.previews) {
      if (!websiteIds.includes(id)) {
        p.destroy();
        this.previews.delete(id);
        this.inputQueues.delete(id);
      }
    }
  }

  setInteractive(on: boolean): void {
    this.interactive = on;
    for (const p of this.previews.values()) p.setInteractive(on);
  }

  /** AI Studio: reads the preview page once it has reached the playhead. */
  evaluate(websiteId: string, expression: string): Promise<unknown> {
    const p = this.previews.get(websiteId);
    if (!p) return Promise.reject(new Error('This website is not loaded yet.'));
    return p.evaluate(expression);
  }

  capturePng(websiteId: string): Promise<Uint8Array> {
    const p = this.previews.get(websiteId);
    if (!p) return Promise.reject(new Error('This website is not loaded yet.'));
    return p.capturePng();
  }

  /** Resolves once every preview has caught up with its latest sync and repainted. */
  async settle(): Promise<void> {
    await Promise.all([...this.previews.values()].map((p) => p.settle()));
  }

  /** Interact mode: how far the user scrolled the page since entering it. */
  scrollSinceInteract(websiteId: string): Promise<ScrollSinceInteract> {
    const p = this.previews.get(websiteId);
    return p ? p.scrollSinceInteract() : Promise.resolve({ error: 'This website is not loaded yet.' });
  }

  refresh(): void {
    for (const p of this.previews.values()) p.refresh();
  }

  ackFrame(websiteId: string): void {
    this.previews.get(websiteId)?.ackFrame();
  }

  /** The user's own input to one website (Interact mode only). */
  input(websiteId: string, events: PageInput[]): void {
    this.inputQueues.get(websiteId)?.push(events);
  }

  // ---- Deterministic export ------------------------------------------------

  /** Starts an export: one render session per website panel. */
  async beginExport(project: Project, settleMs: number, diagnostics: boolean): Promise<ExportBeginResult> {
    await this.endExport();
    this.suspended = true;
    for (const p of this.previews.values()) p.setSuspended(true);
    const reuseFrames =
      // LOOIT_EXPORT_REUSE=0/1 overrides the project setting (tests).
      process.env.LOOIT_EXPORT_REUSE !== undefined
        ? process.env.LOOIT_EXPORT_REUSE === '1'
        : project.output.skipUnchangedFrames !== false;
    const ids = websites(project).map((x) => x.id);
    if (ids.length === 0) throw new Error('Add a website panel before exporting.');
    // Fresh pages per export, so every export starts from the same state and
    // the live preview is never disturbed.
    for (const websiteId of ids) {
      this.exportSessions.set(
        websiteId,
        new ExportSession(
          () => {
            const page = new SitePage(this.allowFile);
            page.wc.setFrameRate(FAST_CAPTURE_FPS);
            page.wc.on('render-process-gone', (_e, d) => console.error(`Export renderer gone: ${d.reason}`));
            return page;
          },
          {
            project,
            websiteId,
            settleMs,
            workers: exportWorkerCount(),
            diagnostics,
            reuseFrames,
            verifyReuse: process.env.LOOIT_EXPORT_VERIFY_REUSE === '1',
          },
        ),
      );
    }
    const workers = await Promise.all([...this.exportSessions.values()].map((s) => s.start()));
    const total = [...this.exportSessions.values()][0].total;
    return { totalFrames: total, websiteIds: ids, workers: Math.min(...workers) };
  }

  exportFrame(websiteId: string, n: number): Promise<ExportStepResult> {
    const session = this.exportSessions.get(websiteId);
    if (!session) return Promise.reject(new Error('Export not started.'));
    return session.frame(n);
  }

  async endExport(): Promise<void> {
    this.suspended = false;
    for (const p of this.previews.values()) p.setSuspended(false);
    for (const s of this.exportSessions.values()) s.destroy();
    this.exportSessions.clear();
  }

  destroy(): void {
    for (const s of this.exportSessions.values()) s.destroy();
    for (const p of this.previews.values()) p.destroy();
  }
}
