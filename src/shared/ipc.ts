// Types shared by the main process, preload bridge and editor renderer.

import type { PageInput } from '../engine/inputs';

export type { PageInput };

/** Mouse input in website CSS pixels. */
export type MouseInput =
  | { type: 'move' | 'down' | 'up' | 'click'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; deltaY: number };

/** An input scheduled at a timeline time (seconds). */
export interface TimedInput {
  time: number;
  input: PageInput;
}

/** "Show the website as it is at `time`": the preview page replays inputs up to then. */
export interface PreviewTarget {
  /** The website panel this preview page belongs to. */
  websiteId: string;
  url: string;
  viewport: { width: number; height: number };
  time: number;
  /** Clicks, scrolls and the hover moves around them, sorted by time. */
  events: TimedInput[];
  /** Where the cursor rests at `time`. */
  hover: { x: number; y: number } | null;
  /** Reload the page even if nothing changed (the Reload button). */
  reload?: boolean;
}

/** A playback tick: dispatch these inputs and advance the page clock to `time`. */
export interface PreviewAdvance {
  websiteId: string;
  time: number;
  inputs: TimedInput[];
}

/** One rendered website frame: BGRA pixels, top row first. */
export interface SiteFrame {
  /** Which website panel the frame belongs to. */
  websiteId: string;
  width: number;
  height: number;
  data: Uint8Array;
}

/** A website frame as PNG bytes (exports: decoded off the main thread by the editor). */
export interface EncodedFrame {
  width: number;
  height: number;
  png: Uint8Array;
}

export interface SiteStatus {
  websiteId: string;
  url: string;
  loading: boolean;
  title: string;
  error?: string;
}

/** A request from the main process to a window's renderer (AI connection). */
export interface AiRequest {
  id: number;
  method: string;
  params: unknown;
}

export interface AiResponse {
  id: number;
  result?: unknown;
  error?: string;
}

/** What the AI Studio window reports about its project and export. */
export interface StudioStatus {
  projectName: string;
  duration: number;
  time: number;
  playing: boolean;
  export: {
    phase: 'idle' | 'choosing' | 'exporting' | 'done' | 'cancelled' | 'failed';
    done: number;
    total: number;
    path?: string;
    error?: string;
    seconds?: number;
  };
}

/** Help → Connect an AI app: the setting and what to put in the AI app's config. */
export interface AiConnectionInfo {
  enabled: boolean;
  /** The JSON to add to claude_desktop_config.json. */
  snippet: string;
  configs: { label: string; path: string; exists: boolean }[];
  /** Development build: Looit must already be running for the AI app to reach it. */
  development: boolean;
}

/** "Scroll to here": the scroll distance since Interact mode began, or why it can't be measured. */
export type ScrollSinceInteract = { deltaY: number } | { error: string };

export interface ExportBeginOptions {
  /** The project to render, as saved to disk (validated again in the main process). */
  project: string;
  /** Virtual time the page gets to load and settle before frame 0. */
  settleMs: number;
  /** Report page clock, timings and frame fingerprints (self-test). */
  diagnostics?: boolean;
}

export interface ExportBeginResult {
  totalFrames: number;
  /** The website panels being rendered (request frames for each). */
  websiteIds: string[];
  /** How many website copies render in parallel. */
  workers: number;
}

export interface ExportStepResult {
  /** Absent when `reused`: the website looks exactly like the previous frame. */
  frame?: EncodedFrame;
  /** The page's address when the frame was captured (it changes when a click opens another page). */
  url?: string;
  reused?: boolean;
  /** Verify mode: what frame reuse would have decided, checked against the real frame. */
  reuseCheck?: { wouldReuse: boolean; differingPixels: number; maxDelta: number };
  /** The page's performance.now() after the step (self-test diagnostics). */
  pageTime?: number;
  /** True if the step hit the real-time timeout (e.g. a never-ending fetch). */
  timedOut: boolean;
  /** Milliseconds per stage in the main process (diagnostics only). */
  timings?: { input: number; advance: number; capture: number };
  /** Hash of the website frame's pixels (diagnostics only), for determinism checks. */
  fingerprint?: string;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface OpenedProject {
  path: string;
  text: string;
}

export interface SelfTestConfig {
  url: string;
  /** A saved project to export instead of the built-in test scene (LOOIT_SELFTEST_PROJECT=path.looit). */
  projectText: string | null;
  /** Gradient (LOOIT_SELFTEST_ENV=1) or image (=image) background, a floor and a moving camera. */
  environment: 'gradient' | 'image' | null;
  /** Adds a second website panel (LOOIT_SELFTEST_SECOND_URL=https://...). */
  secondUrl: string | null;
  /** Extra frame numbers to save as PNG (LOOIT_SELFTEST_FRAMES=105,107). */
  frames: number[];
  /** Save every website frame, downscaled 2x as raw RGB (LOOIT_SELFTEST_DUMP=1). */
  dumpFrames: boolean;
  /** Timing only: no per-frame diagnostics, exactly like a user export (LOOIT_SELFTEST_LEAN=1). */
  lean: boolean;
  width: number;
  height: number;
  fps: number;
}

export interface LooitApi {
  site: {
    /** Shows the website at a timeline time (scrub / pause / project change). */
    sync(target: PreviewTarget): void;
    /** Playback tick. */
    advance(step: PreviewAdvance): void;
    /** Closes preview pages of website panels that no longer exist. */
    keep(websiteIds: string[]): void;
    /** Interact mode: the pages run freely and take the user's own input. */
    setInteractive(on: boolean): void;
    /** The user's own input to one website (Interact mode only). */
    input(websiteId: string, events: PageInput[]): void;
    /** Interact mode: how far the user scrolled this website since entering it. */
    scrollSinceInteract(websiteId: string): Promise<ScrollSinceInteract>;
    ackFrame(websiteId: string): void;
    /** Asks the live page to repaint (e.g. after an export replaced the texture). */
    refresh(): void;
    onFrame(cb: (frame: SiteFrame) => void): void;
    onStatus(cb: (status: SiteStatus) => void): void;
  };
  exporter: {
    begin(opts: ExportBeginOptions): Promise<ExportBeginResult>;
    /** Frame n of one website of the running export (requested in order per website). */
    frame(websiteId: string, n: number): Promise<ExportStepResult>;
    end(): Promise<void>;
    /** Asks where to save, then opens the file for streaming. Null if cancelled. */
    createFile(suggestedName: string): Promise<{ id: number; path: string } | null>;
    write(id: number, position: number, data: Uint8Array): Promise<void>;
    /** Finishes the file (keep) or deletes the partial file. In the AI Studio, returns a URL to play the video. */
    closeFile(id: number, keep: boolean): Promise<string | null>;
  };
  project: {
    /** Shows an open dialog. Returns null if cancelled. */
    open(): Promise<OpenedProject | null>;
    /** Saves to `path` (a path from open/save), or asks where when null. Returns the path or null if cancelled. */
    save(text: string, path: string | null, suggestedName: string): Promise<string | null>;
    /** Tells the main process whether closing should warn about unsaved changes. */
    setDirty(dirty: boolean): void;
    /** Asks for a PNG, JPEG or WebP background image; returns it as a data: URL, or null if cancelled. */
    pickImage(): Promise<string | null>;
  };
  ai: {
    /** Answers the main process's requests; also tells it the window is ready for them. */
    onRequest(handler: (method: string, params: unknown) => unknown): void;
    connection(): Promise<AiConnectionInfo>;
    setEnabled(enabled: boolean): Promise<void>;
    /** Shows the AI app's config file (or its folder) in Explorer. */
    showConfig(path: string): Promise<void>;
  };
  studio: {
    /** Resolves once every website preview has reached the playhead and repainted. */
    settle(): Promise<void>;
  };
  selfTest: {
    config(): Promise<SelfTestConfig | null>;
    writeFile(name: string, data: Uint8Array | string): Promise<void>;
    finish(ok: boolean): void;
  };
}
