// The preview website, kept in sync with the timeline.
//
// The page's clock is virtual time (like the export), so it shows what the
// website looks like at the playhead: scrubbing backwards rebuilds the page
// and replays the cursor's clicks and scrolls up to that moment; playing
// advances the page clock together with the playhead. In Interact mode the
// page runs freely so the user can explore it; the next sync rebuilds it.

import type {
  PageInput,
  PreviewAdvance,
  PreviewTarget,
  ScrollSinceInteract,
  SiteFrame,
  SiteStatus,
  TimedInput,
} from '../shared/ipc';
import { withTimeout } from './util';
import type { RawFrame, SitePage } from './website';

export const PREVIEW_FPS = 30;
/** Virtual time a freshly loaded page gets before timeline 0 (same as export). */
const SETTLE_MS = 1000;
const LOAD_TIMEOUT_MS = 60_000;
const EPS = 1e-6;

export interface PreviewEvents {
  frame(frame: SiteFrame): void;
  status(status: SiteStatus): void;
}

function sameInput(a: TimedInput, b: TimedInput): boolean {
  const ai = a.input;
  const bi = b.input;
  if (Math.abs(a.time - b.time) >= 1e-4 || ai.type !== bi.type) return false;
  if (ai.type === 'text') return bi.type === 'text' && ai.text === bi.text;
  if (ai.type === 'key') return bi.type === 'key' && ai.key === bi.key;
  if (bi.type === 'text' || bi.type === 'key') return false;
  return (
    Math.round(ai.x) === Math.round(bi.x) &&
    Math.round(ai.y) === Math.round(bi.y) &&
    (ai.type !== 'wheel' || (bi.type === 'wheel' && ai.deltaY === bi.deltaY))
  );
}

/** Clicks and scrolls change page state; hover moves are only replayed approximately. */
function isStateChanging(e: TimedInput): boolean {
  return e.input.type !== 'move';
}

export class PreviewController {
  private page: SitePage | null = null;
  private pageKey = '';
  /** Timeline time the page currently shows. */
  private pageTime = 0;
  /** State-changing inputs already dispatched to the page, in order. */
  private applied: TimedInput[] = [];
  private diverged = false;
  private interactTimer: ReturnType<typeof setInterval> | null = null;
  /** Where the page was (the timeline's state at the playhead) when Interact mode began. */
  private interactStart: Promise<{ y: number; url: string } | null> | null = null;
  private busy = false;
  private pendingSync: PreviewTarget | null = null;
  private pendingAdvance: PreviewAdvance | null = null;
  private generation = 0;
  // Frame flow control: at most one frame in flight to the editor.
  private inFlight = false;
  /** While exporting, the preview stops rendering and sending frames. */
  private suspended = false;
  private pendingFrame: RawFrame | null = null;

  constructor(
    private readonly websiteId: string,
    private readonly createPage: () => SitePage,
    private readonly events: PreviewEvents,
  ) {}

  /** Show the page as it is at `target.time`. */
  sync(target: PreviewTarget): void {
    this.pendingSync = target;
    this.pendingAdvance = null;
    void this.pump();
  }

  /** Playback tick: send the inputs for (pageTime, time] and advance the clock. */
  advance(step: PreviewAdvance): void {
    if (this.pendingAdvance) {
      // Merge ticks that arrive while the page is busy.
      step = { ...step, inputs: [...this.pendingAdvance.inputs, ...step.inputs] };
    }
    this.pendingAdvance = step;
    void this.pump();
  }

  /** Interact mode: the page runs on the real clock and takes the user's input. */
  setInteractive(on: boolean): void {
    if (on === !!this.interactTimer) return;
    if (on) {
      // Measured once any pending sync has finished, before the user's own input.
      this.interactStart = this.idle().then(() => this.settledScroll());
      this.diverged = true;
      let last = Date.now();
      this.interactTimer = setInterval(() => {
        const now = Date.now();
        const ms = now - last;
        last = now;
        if (!this.busy && this.page) void this.page.advance(ms, 'free').catch(() => {});
      }, 33);
    } else {
      clearInterval(this.interactTimer!);
      this.interactTimer = null;
    }
  }

  /**
   * The scroll position once earlier scrolls have finished gliding (the page
   * runs on the real clock in Interact mode), so a new scroll is measured from
   * where the timeline's scrolls end up.
   */
  private async settledScroll(): Promise<{ y: number; url: string } | null> {
    let last = await this.page?.scrollPosition().catch(() => null);
    for (let i = 0; last && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 120));
      const now = await this.page?.scrollPosition().catch(() => null);
      if (!now) return null;
      const still = Math.abs(now.y - last.y) < 0.5 && now.url === last.url;
      last = now;
      if (still) break;
    }
    return last ?? null;
  }

  /** Runs `expression` in the page once pending syncs are done. */
  async evaluate(expression: string): Promise<unknown> {
    await this.idle();
    if (!this.page) throw new Error('The website could not be loaded.');
    return this.page.evaluate(expression);
  }

  async capturePng(): Promise<Uint8Array> {
    await this.idle();
    if (!this.page) throw new Error('The website could not be loaded.');
    return (await this.page.capturePng()).png;
  }

  /** Waits for pending syncs, then asks for a fresh paint (sent to the renderer as a frame). */
  async settle(): Promise<void> {
    await this.idle();
    this.page?.wc.invalidate();
  }

  /** How far the user has scrolled since Interact mode began ("Scroll to here"). */
  async scrollSinceInteract(): Promise<ScrollSinceInteract> {
    if (!this.interactTimer || !this.interactStart) return { error: 'Scroll to here works in Interact mode.' };
    const start = await this.interactStart;
    await this.idle();
    const now = await this.page?.scrollPosition().catch(() => null);
    if (!start || !now) return { error: 'The website is not ready yet.' };
    if (now.url !== start.url) {
      return { error: 'You opened another page in Interact mode. Scroll to here only measures scrolling on one page.' };
    }
    return { deltaY: Math.round(now.y - start.y) };
  }

  /** The user's own input in Interact mode. */
  async input(events: PageInput[]): Promise<void> {
    // If the page is being rebuilt, wait: the input belongs to the page that's
    // about to be shown, not the one being replaced.
    await this.idle();
    if (this.interactTimer && this.page) await this.page.input(events);
  }

  /** Resolves once no sync/advance work is running. */
  private idle(): Promise<void> {
    return this.busy ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve();
  }

  ackFrame(): void {
    this.inFlight = false;
    if (this.pendingFrame) {
      const f = this.pendingFrame;
      this.pendingFrame = null;
      this.sendFrame(f);
    }
  }

  /** Pauses the preview's frame stream (during export) so it doesn't compete for CPU/GPU. */
  setSuspended(on: boolean): void {
    this.suspended = on;
    this.page?.wc.setFrameRate(on ? 1 : PREVIEW_FPS);
    if (!on) this.page?.wc.invalidate();
  }

  refresh(): void {
    this.page?.wc.invalidate();
  }

  destroy(): void {
    this.setInteractive(false);
    this.page?.destroy();
    this.page = null;
  }

  // ---- internals ---------------------------------------------------------------

  private readonly idleWaiters: (() => void)[] = [];

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pendingSync || this.pendingAdvance) {
        if (this.pendingSync) {
          const target = this.pendingSync;
          this.pendingSync = null;
          await this.doSync(target);
        } else if (this.pendingAdvance) {
          const step = this.pendingAdvance;
          this.pendingAdvance = null;
          await this.doAdvance(step);
        }
      }
    } catch (err) {
      this.events.status({
        websiteId: this.websiteId,
        url: '',
        loading: false,
        title: '',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.busy = false;
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private needsRebuild(target: PreviewTarget): boolean {
    const key = `${target.url}|${target.viewport.width}x${target.viewport.height}`;
    if (!this.page || key !== this.pageKey || this.diverged || target.reload) return true;
    if (target.time < this.pageTime - EPS) return true;
    // Did any click/scroll that already happened change?
    const past = target.events.filter((e) => isStateChanging(e) && e.time <= this.pageTime + EPS);
    return past.length !== this.applied.length || past.some((e, i) => !sameInput(e, this.applied[i]));
  }

  private async doSync(target: PreviewTarget): Promise<void> {
    if (this.interactTimer) return;
    if (this.needsRebuild(target)) await this.rebuild(target);
    if (this.pendingSync) return; // superseded while loading
    await this.fastForward(target.events, target.time);
    if (target.hover) await this.page!.input([{ type: 'move', x: target.hover.x, y: target.hover.y }]);
    // A screenshot forces a complete, up-to-date frame.
    const frame = await this.page!.capture().catch(() => null);
    if (frame) this.sendFrame(frame);
  }

  private async doAdvance(step: PreviewAdvance): Promise<void> {
    if (!this.page || this.interactTimer || step.time < this.pageTime - EPS) return;
    for (const ev of step.inputs) if (isStateChanging(ev)) this.applied.push(ev);
    await this.page.input(step.inputs.map((e) => e.input));
    // Real-time playback: don't wait for the network, just like a real browser.
    await this.page.advance((step.time - this.pageTime) * 1000, 'free');
    this.pageTime = step.time;
  }

  /** Replays state-changing inputs in (pageTime, time] at their exact times. */
  private async fastForward(events: TimedInput[], time: number): Promise<void> {
    const page = this.page!;
    const due = events
      .filter((e) => e.time > this.pageTime + EPS && e.time <= time + EPS)
      .sort((a, b) => a.time - b.time);
    for (const ev of due) {
      if (ev.time > this.pageTime) {
        await page.advance((ev.time - this.pageTime) * 1000, 'network');
        this.pageTime = ev.time;
      }
      await page.input([ev.input]);
      if (isStateChanging(ev)) this.applied.push(ev);
    }
    if (time > this.pageTime) {
      await page.advance((time - this.pageTime) * 1000, 'network');
      this.pageTime = time;
    }
  }

  private async rebuild(target: PreviewTarget): Promise<void> {
    const gen = ++this.generation;
    const url = target.url;
    this.events.status({
      websiteId: this.websiteId,
      url,
      loading: true,
      title: '',
      error: undefined,
    });
    const page = this.createPage();
    try {
      page.wc.on('paint', (_e, _dirty, image) => {
        if (page !== this.page || image.isEmpty()) return;
        this.sendFrame({ ...image.getSize(), data: image.toBitmap() });
      });
      page.wc.on('page-title-updated', () => {
        if (page === this.page)
          this.events.status({
            websiteId: this.websiteId,
            url,
            loading: false,
            title: page.wc.getTitle(),
          });
      });
      page.wc.on('render-process-gone', (_e, d) => {
        if (page === this.page)
          this.events.status({
            websiteId: this.websiteId,
            url,
            loading: false,
            title: '',
            error: `Website crashed: ${d.reason}`,
          });
      });
      await withTimeout(
        (async () => {
          // Same frozen-from-the-start load as the export, so the preview matches it.
          await page.loadFrozen(url, target.viewport, 1, Math.floor(Date.now() / 1000) * 1000);
          await page.advance(SETTLE_MS, 'network');
          await page.freezeAnimations();
        })(),
        LOAD_TIMEOUT_MS,
        'The website took too long to load.',
      );
    } catch (err) {
      page.destroy();
      if (gen === this.generation) {
        const msg = err instanceof Error ? err.message : String(err);
        this.events.status({
          websiteId: this.websiteId,
          url,
          loading: false,
          title: '',
          error: msg.replace(/^Error: /, ''),
        });
      }
      throw err;
    }
    // Swap only when the new page is ready, so the preview never flashes empty.
    const old = this.page;
    this.page = page;
    this.pageKey = `${target.url}|${target.viewport.width}x${target.viewport.height}`;
    this.pageTime = 0;
    this.applied = [];
    this.diverged = false;
    old?.destroy();
    this.events.status({
      websiteId: this.websiteId,
      url,
      loading: false,
      title: page.wc.getTitle(),
    });
  }

  private sendFrame(frame: RawFrame): void {
    if (this.suspended) return;
    if (this.inFlight) {
      this.pendingFrame = frame;
      return;
    }
    this.inFlight = true;
    this.events.frame({ ...frame, websiteId: this.websiteId });
  }
}
