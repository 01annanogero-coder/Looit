// Parallel, deterministic export rendering.
//
// Several offscreen copies of the website ("workers") render the video
// together. The timeline is cut into short chunks dealt out in turn: worker w
// renders chunks w, w+W, w+2W, ... Between its chunks a worker fast-forwards
// through the frames others render, replaying exactly the same per-frame
// inputs and clock steps as a single sequential renderer, just without
// capturing pictures. Frames are handed out strictly in order; workers that
// get too far ahead wait, so memory stays bounded.

import { createHash } from 'node:crypto';
import { frameCount, frameTime } from '../engine/animation';
import { frameInputs } from '../engine/inputs';
import { cursorFor, type Project, type WebsiteObject } from '../engine/project';
import type { ExportStepResult } from '../shared/ipc';
import { nativeImage } from 'electron';
import { withTimeout } from './util';

/** Pixel difference between two BGRA bitmaps (verify mode). */
function compareBitmaps(a: Buffer | null, b: Buffer): { differingPixels: number; maxDelta: number } {
  if (!a || a.length !== b.length) return { differingPixels: -1, maxDelta: 255 };
  let differingPixels = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d > 0) {
      differingPixels++;
      if (d > maxDelta) maxDelta = d;
    }
  }
  return { differingPixels, maxDelta };
}
import type { SitePage } from './website';

const LOAD_TIMEOUT_MS = 60_000;
/** Frames per chunk. Small chunks keep the in-order buffer (and memory) small. */
const CHUNK_FRAMES = 8;

export interface ExportSessionOptions {
  project: Project;
  /** The website panel this session renders. */
  websiteId: string;
  /** Virtual time each page gets to load and settle before frame 0. */
  settleMs: number;
  workers: number;
  /** Report the page clock, per-stage timings and a frame fingerprint (self-test). */
  diagnostics: boolean;
  /** Skip capturing frames where the page provably didn't change. */
  reuseFrames: boolean;
  /** Capture every frame anyway and check each reuse decision against it (tests). */
  verifyReuse: boolean;
}

/** After any change, this many more frames are still captured (catches late paints). */
const SETTLE_FRAMES_AFTER_CHANGE = 2;
/**
 * Pages that change every frame never benefit from the change check, which
 * costs a few frames of waiting. Each consecutive "changed" check doubles the
 * gap to the next check (1, 2, 4, 8, 16 frames); an "unchanged" check resets it.
 * Frames between checks are captured: skipping a check can only cause a
 * capture, never a reuse.
 */
const MAX_CHECK_INTERVAL = 16;

interface Worker {
  page: SitePage;
  /** The last frame whose clock time and inputs this page has reached (-1 = settled, before frame 0). */
  frame: number;
  /** Frame n-1 was rendered by this worker (so reusing it for n is possible). */
  hasPrevious: boolean;
  /** Frames still to capture fully after the last change. */
  settle: number;
  /** Frames between change checks (grows while the page keeps changing). */
  checkInterval: number;
  /** Frames left until the next change check. */
  skipChecks: number;
  /** Verify mode: pixels of the previous captured frame. */
  previousPixels: Buffer | null;
}

export class ExportSession {
  readonly total: number;
  private readonly fps: number;
  private readonly cursor;
  private workers: Worker[] = [];
  private readonly ready = new Map<number, ExportStepResult>();
  private readonly waiting = new Map<number, { resolve(r: ExportStepResult): void; reject(e: Error): void }>();
  private readonly roomWaiters: (() => void)[] = [];
  private nextNeeded = 0;
  /** Date.now() at time 0 for every copy, so date-dependent content matches across chunks. */
  private readonly epochMs = Math.floor(Date.now() / 1000) * 1000;
  private error: Error | null = null;
  private closed = false;

  constructor(
    private readonly createPage: () => SitePage,
    private readonly opts: ExportSessionOptions,
  ) {
    const { project } = opts;
    this.fps = project.output.fps;
    this.total = frameCount(project.duration, this.fps);
    this.cursor = cursorFor(project, opts.websiteId);
  }

  /** Loads the worker pages. Workers that fail to load are dropped; at least one must succeed. */
  async start(): Promise<number> {
    const website = this.opts.project.objects.find(
      (o): o is WebsiteObject => o.id === this.opts.websiteId && o.kind === 'website',
    );
    if (!website) throw new Error('The website panel was not found.');
    // Render the website at the output's pixel density so text stays sharp at 1080p.
    const scale = Math.max(1, this.opts.project.output.width / website.viewport.width);
    const count = Math.max(1, Math.min(this.opts.workers, Math.ceil(this.total / CHUNK_FRAMES)));
    const results = await Promise.allSettled(
      Array.from({ length: count }, async () => {
        const page = this.createPage();
        try {
          await withTimeout(
            (async () => {
              await page.loadFrozen(website.url, website.viewport, scale, this.epochMs);
              // The clock waits for the network, so the page loads the same way every time.
              await page.advance(this.opts.settleMs);
              await page.freezeAnimations();
            })(),
            LOAD_TIMEOUT_MS,
            'The website took too long to load.',
          );
          return page;
        } catch (err) {
          page.destroy();
          throw err;
        }
      }),
    );
    this.workers = results.flatMap((r) =>
      r.status === 'fulfilled'
        ? [
            {
              page: r.value,
              frame: -1,
              hasPrevious: false,
              settle: 0,
              checkInterval: 1,
              skipChecks: 0,
              previousPixels: null,
            },
          ]
        : [],
    );
    if (this.opts.reuseFrames || this.opts.verifyReuse)
      await Promise.all(this.workers.map((w) => w.page.startChangeTracking()));
    if (this.closed) {
      this.destroy();
      throw new Error('Export cancelled.');
    }
    if (this.workers.length === 0) {
      const first = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      throw first?.reason instanceof Error ? first.reason : new Error('The website could not be loaded.');
    }
    this.workers.forEach((w, i) => void this.run(w, i).catch((err) => this.fail(err)));
    return this.workers.length;
  }

  /** Frame n, in order. Resolves once a worker has rendered it. */
  frame(n: number): Promise<ExportStepResult> {
    if (this.error) return Promise.reject(this.error);
    if (n >= this.total || n < 0) return Promise.reject(new Error('Frame out of range.'));
    this.nextNeeded = Math.max(this.nextNeeded, n);
    this.wakeRoom();
    const r = this.ready.get(n);
    if (r) {
      this.ready.delete(n);
      return Promise.resolve(r);
    }
    return new Promise((resolve, reject) => this.waiting.set(n, { resolve, reject }));
  }

  destroy(): void {
    this.closed = true;
    for (const w of this.workers) w.page.destroy();
    this.workers = [];
    this.ready.clear();
    this.fail(new Error('Export cancelled.'));
  }

  // ---- internals -------------------------------------------------------------

  private async run(worker: Worker, index: number): Promise<void> {
    const W = this.workers.length;
    for (let chunk = index; chunk * CHUNK_FRAMES < this.total; chunk += W) {
      const start = chunk * CHUNK_FRAMES;
      const end = Math.min(this.total, start + CHUNK_FRAMES);
      // Don't run more than one round of chunks ahead of what's been requested.
      while (!this.closed && start >= this.nextNeeded + W * CHUNK_FRAMES)
        await new Promise<void>((r) => this.roomWaiters.push(r));
      if (this.closed) return;
      await this.fastForward(worker, start - 1);
      // The worker's last captured frame is from its previous chunk: capture afresh.
      worker.hasPrevious = false;
      for (let n = start; n < end; n++) {
        if (this.closed) return;
        this.deliver(n, await this.render(worker, n));
      }
    }
  }

  /**
   * Steps the page through frames (worker.frame, target] exactly like rendering
   * them: same inputs, one clock step per frame, and the page draws each frame
   * (just not captured). Without drawing, state that depends on painting came
   * out differently (a text field's blinking caret in a different phase).
   */
  private async fastForward(worker: Worker, target: number): Promise<void> {
    for (let n = worker.frame + 1; n <= target; n++) {
      await worker.page.input(frameInputs(this.cursor, this.fps, n));
      if (n > 0) await worker.page.advance((frameTime(n, this.fps) - frameTime(n - 1, this.fps)) * 1000);
      await worker.page.render();
      worker.frame = n;
      if (this.closed) return;
    }
  }

  private async render(worker: Worker, n: number): Promise<ExportStepResult> {
    const page = worker.page;
    const t0 = performance.now();
    const inputs = frameInputs(this.cursor, this.fps, n);
    const tracking = this.opts.reuseFrames || this.opts.verifyReuse;
    const checking = tracking && worker.skipChecks === 0;
    await page.input(inputs);
    const t1 = performance.now();
    const completed = n === 0 ? true : await page.advance((frameTime(n, this.fps) - frameTime(n - 1, this.fps)) * 1000);
    // Let the page draw at exactly this frame's time before anything is checked
    // or captured; otherwise frame-time driven animation (requestAnimationFrame)
    // could show a draw from earlier in the step. Fast-forwarding does the same.
    await page.render();
    const t2 = performance.now();
    let wouldReuse = false;
    if (tracking) {
      // Clicks and scrolls always count as changes; hover moves only if they changed something.
      let changed: boolean;
      if (!checking) {
        worker.skipChecks--;
        changed = true;
      } else {
        changed = inputs.some((i) => i.type !== 'move') || (await page.pageChanged()) || !completed;
        worker.checkInterval = changed ? Math.min(worker.checkInterval * 2, MAX_CHECK_INTERVAL) : 1;
        worker.skipChecks = worker.checkInterval - 1;
      }
      if (changed) worker.settle = SETTLE_FRAMES_AFTER_CHANGE;
      wouldReuse = !changed && worker.hasPrevious && worker.settle === 0;
      if (!changed && worker.settle > 0) worker.settle--;
    }
    worker.frame = n;
    if (wouldReuse && !this.opts.verifyReuse) {
      worker.hasPrevious = true;
      if (!this.opts.diagnostics) return { reused: true, timedOut: false };
      return {
        reused: true,
        timedOut: false,
        pageTime: await page.pageTime(),
        timings: { input: t1 - t0, advance: t2 - t1, capture: performance.now() - t2 },
      };
    }
    const frame = await page.capturePng();
    const t3 = performance.now();
    worker.hasPrevious = true;
    let reuseCheck: ExportStepResult['reuseCheck'];
    if (this.opts.verifyReuse) {
      const pixels = nativeImage.createFromBuffer(Buffer.from(frame.png)).toBitmap();
      reuseCheck = { wouldReuse, ...compareBitmaps(worker.previousPixels, pixels) };
      worker.previousPixels = pixels;
    }
    const url = page.wc.getURL();
    if (!this.opts.diagnostics) return { frame, url, timedOut: !completed, reuseCheck };
    return {
      frame,
      url,
      timedOut: !completed,
      reuseCheck,
      pageTime: await page.pageTime(),
      timings: { input: t1 - t0, advance: t2 - t1, capture: t3 - t2 },
      fingerprint: createHash('sha1').update(frame.png).digest('hex').slice(0, 16),
    };
  }

  private deliver(n: number, result: ExportStepResult): void {
    const w = this.waiting.get(n);
    if (w) {
      this.waiting.delete(n);
      w.resolve(result);
    } else {
      this.ready.set(n, result);
    }
  }

  private wakeRoom(): void {
    const waiters = this.roomWaiters.splice(0);
    for (const w of waiters) w();
  }

  private fail(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    if (!this.error) this.error = e;
    for (const [, w] of this.waiting) w.reject(e);
    this.waiting.clear();
    this.wakeRoom();
  }
}
