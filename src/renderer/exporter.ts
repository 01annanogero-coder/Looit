// Frame-by-frame MP4 export. Each output frame n is rendered at exactly
// t = n / fps: the website clock is advanced to t, the scene is evaluated at t,
// and the result is encoded. Nothing depends on real-time playback speed.

import { CanvasSource, Mp4OutputFormat, Output, QUALITY_VERY_HIGH, StreamTarget, canEncodeVideo } from 'mediabunny';
import type * as THREE from 'three';
import { frameCount, frameTime } from '../engine/animation';
import { websites, type Project } from '../engine/project';
import { serializeProject } from '../engine/schema';
import type { ExportStepResult } from '../shared/ipc';
import type { SceneView } from './viewport/scene-view';
import type { SiteTexture } from './site-texture';

/** Virtual time the page gets to load and settle before the first frame. */
const SETTLE_MS = 1000;

export interface ExportContext {
  project: Project;
  /** File opened with exporter.createFile; the MP4 is streamed into it. */
  fileId: number;
  view: SceneView;
  renderer: THREE.WebGLRenderer;
  /** The texture each website panel's frames are shown with. */
  siteTexture(websiteId: string): SiteTexture;
  onProgress(done: number, total: number): void;
  /** Called synchronously right after frame n is drawn (canvas is readable), with the first panel's step. */
  onFrameRendered?(n: number, step: ExportStepResult): void;
  signal?: AbortSignal;
  /** Called once the website copies are loaded, with how many render in parallel. */
  onStart?(workers: number): void;
  /** Filled with time spent per stage (ms), for diagnostics. */
  stats?: ExportStats;
}

export interface ExportStats {
  website: number;
  render: number;
  encode: number;
  /** Frames where the website didn't change and the previous frame was reused. */
  reused: number;
}

interface PanelFrame {
  websiteId: string;
  step: ExportStepResult;
  bitmap: ImageBitmap | null;
}

/** Fetches one website's frame `n` from the export session and decodes it for WebGL. */
async function fetchPanelFrame(websiteId: string, n: number): Promise<PanelFrame> {
  const step = await window.looit.exporter.frame(websiteId, n);
  // No frame: the website didn't change, keep showing the previous one.
  const bitmap = step.frame
    ? await createImageBitmap(new Blob([step.frame.png as Uint8Array<ArrayBuffer>], { type: 'image/png' }), {
        imageOrientation: 'flipY',
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      })
    : null;
  return { websiteId, step, bitmap };
}

/** Rough MP4 size in bytes, from the bitrate this encoder produced in testing. */
export function estimateSize(project: Project): number {
  const { width, height, fps } = project.output;
  // ~1.7 Mbit/s measured at 1280x720@30 with QUALITY_VERY_HIGH; grows sub-linearly with pixel rate.
  const bitsPerSecond = 1_700_000 * ((width * height * fps) / (1280 * 720 * 30)) ** 0.75;
  return (bitsPerSecond / 8) * project.duration;
}

/** Renders exact export frames (PNG data URLs) at the given times, without encoding. */
export interface FrameRenderContext {
  project: Project;
  view: SceneView;
  renderer: THREE.WebGLRenderer;
  siteTexture(websiteId: string): SiteTexture;
  onProgress?(done: number, total: number): void;
}

export async function renderFrames(ctx: FrameRenderContext, times: number[]): Promise<string[]> {
  const { project, view, renderer } = ctx;
  const { width, height, fps } = project.output;
  if (websites(project).length === 0) throw new Error('Add a website panel before rendering frames.');
  if (times.length === 0) throw new Error('Give at least one time.');

  const canvas = renderer.domElement;
  const prevPixelRatio = renderer.getPixelRatio();
  const prevSize = { w: canvas.width, h: canvas.height };
  const prevAspect = view.camera.aspect;
  const prevUrls = new Map(view.pageUrls);

  // Same fresh, virtual-time page the export uses, so the frame is the export.
  const session = await window.looit.exporter.begin({
    project: serializeProject(project),
    settleMs: SETTLE_MS,
    diagnostics: false,
  });
  const targets = [
    ...new Set(
      times.map((t) => Math.min(Math.max(Math.round((Number.isFinite(t) ? t : 0) * fps), 0), session.totalFrames - 1)),
    ),
  ].sort((a, b) => a - b);
  const last = targets[targets.length - 1];
  const shots = new Map<number, string>();
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    view.setAspect(width / height);
    view.hideGuides();
    await view.prepare(project);

    for (let n = 0; n <= last; n++) {
      const panels = await Promise.all(session.websiteIds.map((id) => fetchPanelFrame(id, n)));
      for (const { websiteId, step, bitmap } of panels) {
        const tex = ctx.siteTexture(websiteId);
        if (bitmap && tex.updateBitmap(bitmap)) view.setWebsiteTexture(websiteId, tex.texture);
        if (step.url && !step.url.startsWith('about:')) view.pageUrls.set(websiteId, step.url);
      }
      const t = frameTime(n, fps);
      view.sync(project, t, { selectedId: null, showHelpers: false });
      renderer.render(view.scene, view.camera);
      if (targets.includes(n)) shots.set(n, canvas.toDataURL('image/png'));
      ctx.onProgress?.(n + 1, last + 1);
    }
  } finally {
    renderer.setPixelRatio(prevPixelRatio);
    renderer.setSize(prevSize.w / prevPixelRatio, prevSize.h / prevPixelRatio, false);
    view.setAspect(prevAspect);
    view.pageUrls.clear();
    for (const [id, url] of prevUrls) view.pageUrls.set(id, url);
    await window.looit.exporter.end();
  }
  return targets.map((n) => shots.get(n)!);
}

export async function exportVideo(ctx: ExportContext): Promise<void> {
  const { project, view, renderer } = ctx;
  const { width, height, fps } = project.output;
  if (websites(project).length === 0) throw new Error('Add a website panel before exporting.');

  const supported = await canEncodeVideo('avc', { width, height, frameRate: fps, quality: QUALITY_VERY_HIGH });
  if (!supported) throw new Error(`This computer cannot encode H.264 video at ${width}x${height}.`);

  const canvas = renderer.domElement;
  const prevPixelRatio = renderer.getPixelRatio();
  const prevSize = { w: canvas.width, h: canvas.height };
  const prevAspect = view.camera.aspect;
  const prevUrls = new Map(view.pageUrls);

  // Stream to disk in 8 MB chunks: memory use stays flat for any video length.
  const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
    write: (chunk) => window.looit.exporter.write(ctx.fileId, chunk.position, chunk.data),
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  });
  const source = new CanvasSource(canvas, { codec: 'avc', quality: QUALITY_VERY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });

  // The main process renders the website frames (in parallel) from the saved project.
  const session = await window.looit.exporter.begin({
    project: serializeProject(project),
    settleMs: SETTLE_MS,
    diagnostics: !!ctx.onFrameRendered,
  });
  ctx.onStart?.(session.workers);
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    view.setAspect(width / height);
    view.hideGuides();
    await view.prepare(project);
    await output.start();

    const total = session.totalFrames;
    if (total !== frameCount(project.duration, fps)) throw new Error('Export frame count mismatch.');
    // Fetch and decode every panel's frame n (off the main thread, already flipped for WebGL).
    const request = (n: number) => {
      const p = Promise.all(session.websiteIds.map((id) => fetchPanelFrame(id, n)));
      p.catch(() => {}); // handled when awaited; avoids an unhandled rejection on cancel
      return p;
    };
    // Pipeline: frame n+1 is transferred and decoded while this frame is rendered and encoded.
    let next = request(0);
    for (let n = 0; n < total; n++) {
      if (ctx.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const t = frameTime(n, fps);
      const t0 = performance.now();
      const panels = await next;
      if (n + 1 < total) next = request(n + 1);
      const t1 = performance.now();
      for (const { websiteId, step, bitmap } of panels) {
        const tex = ctx.siteTexture(websiteId);
        if (bitmap && tex.updateBitmap(bitmap)) view.setWebsiteTexture(websiteId, tex.texture);
        if (step.url && !step.url.startsWith('about:')) view.pageUrls.set(websiteId, step.url);
        if (step.reused && ctx.stats) ctx.stats.reused++;
      }
      const step = panels[0].step;
      view.sync(project, t, { selectedId: null, showHelpers: false });
      renderer.render(view.scene, view.camera);
      ctx.onFrameRendered?.(n, step);
      const t2 = performance.now();
      await source.add(t, 1 / fps);
      if (ctx.stats) {
        ctx.stats.website += t1 - t0;
        ctx.stats.render += t2 - t1;
        ctx.stats.encode += performance.now() - t2;
      }
      ctx.onProgress(n + 1, total);
    }
    source.close();
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  } finally {
    renderer.setPixelRatio(prevPixelRatio);
    renderer.setSize(prevSize.w / prevPixelRatio, prevSize.h / prevPixelRatio, false);
    view.setAspect(prevAspect);
    view.pageUrls.clear();
    for (const [id, url] of prevUrls) view.pageUrls.set(id, url);
    await window.looit.exporter.end();
  }
}
