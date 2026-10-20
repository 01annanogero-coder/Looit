// Development self-test: exports the local clock test page without user input
// and writes frame snapshots plus timing diagnostics for inspection.

import { cameraOf, DEFAULT_ENVIRONMENT, newProject, newWebsiteWithCursor } from '../engine/project';
import { parseProject } from '../engine/schema';
import type { EncodedFrame, SelfTestConfig } from '../shared/ipc';
import { exportVideo } from './exporter';
import { loadProject, setEditor } from './store';
import { currentRenderer, siteTexture, view } from './viewport/runtime';

const SNAPSHOTS_AT_SECONDS = [0, 1, 2.5, 3.367, 3.4, 4, 4.967];

/** Website frame decoded and downscaled 2x (2x2 average) to raw RGB, for determinism comparisons. */
async function downscaleRgb(frame: EncodedFrame): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([frame.png as Uint8Array<ArrayBuffer>], { type: 'image/png' }), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const w = canvas.width >> 1;
  const h = canvas.height >> 1;
  const stride = canvas.width * 4;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * 2 * stride + x * 8;
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[o + c] = (d[i + c] + d[i + 4 + c] + d[i + stride + c] + d[i + stride + 4 + c] + 2) >> 2;
      }
    }
  }
  return out;
}

async function write(name: string, blob: Blob | Promise<Blob | null>): Promise<void> {
  const b = await blob;
  if (b) await window.looit.selfTest.writeFile(name, new Uint8Array(await b.arrayBuffer()));
}

async function waitFor<T>(get: () => T | null, timeoutMs = 10_000): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - start > timeoutMs) throw new Error('Timed out waiting for the editor.');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function runSelfTest(config: SelfTestConfig): Promise<void> {
  const log: string[] = [];
  const pending: Promise<void>[] = [];
  let ok = false;
  try {
    const project = newProject(config.url);
    project.output = { width: config.width, height: config.height, fps: config.fps };
    const cursor = project.objects.find((o) => o.kind === 'cursor');
    if (cursor?.kind === 'cursor') {
      cursor.scrolls = [{ id: 'scroll-1', time: 4, deltaY: 400 }];
      // The typing test page: click the search box (3.4 s), type, press Enter.
      if (config.url.includes('typing')) {
        cursor.scrolls = [];
        cursor.keys = [
          { id: 'type-1', time: 3.5, kind: 'type', text: 'loo', cps: 12 },
          { id: 'enter-1', time: 4.3, kind: 'press', key: 'Enter' },
        ];
      }
    }
    if (config.secondUrl) {
      const [second, secondCursor] = newWebsiteWithCursor(config.secondUrl, 'Second website', [5.5, -2.5, 2]);
      project.objects.push(second, secondCursor);
    }
    if (config.environment) {
      project.environment = { ...DEFAULT_ENVIRONMENT, background: 'gradient', floor: 'reflection' };
      if (config.environment === 'image') {
        // A tall checkerboard: cover-fit must crop it, not stretch it.
        const c = document.createElement('canvas');
        c.width = 400;
        c.height = 800;
        const g = c.getContext('2d')!;
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 4; x++) {
            g.fillStyle = (x + y) % 2 ? '#f59e0b' : '#0ea5e9';
            g.fillRect(x * 100, y * 100, 100, 100);
          }
        project.environment = {
          ...project.environment,
          background: 'image',
          image: c.toDataURL('image/png'),
          floor: 'grid',
        };
      }
      const cam = cameraOf(project);
      cam.position.keyframes = [
        { id: 'cam-1', time: 0, value: [-6, 3, 20], easing: 'easeInOut' },
        { id: 'cam-2', time: 5, value: [2, 0.5, 15], easing: 'easeInOut' },
      ];
      cam.zoom.keyframes = [
        { id: 'zoom-1', time: 0, value: 1, easing: 'easeInOut' },
        { id: 'zoom-2', time: 5, value: 1.4, easing: 'easeInOut' },
      ];
    }
    const exported = config.projectText ? parseProject(config.projectText) : project;
    loadProject(exported, null);
    const renderer = await waitFor(currentRenderer);
    console.log('[selftest] exporting', `${config.width}x${config.height}@${config.fps}`);
    const snapshotFrames = new Set([...SNAPSHOTS_AT_SECONDS.map((t) => Math.round(t * config.fps)), ...config.frames]);
    const frames: {
      n: number;
      pageTime?: number;
      timedOut: boolean;
      size: string;
      timings?: { input: number; advance: number; capture: number };
      fingerprint?: string;
    }[] = [];
    let workers = 0;
    let lastFrame: EncodedFrame | null = null;
    const reuse = { wouldReuse: 0, wrong: [] as { n: number; differingPixels: number; maxDelta: number }[] };
    const started = performance.now();
    const stats = { website: 0, render: 0, encode: 0, reused: 0 };
    setEditor({ exporting: true });
    const file = await window.looit.exporter.createFile('export');
    if (!file) throw new Error('Could not create the export file.');
    await exportVideo({
      project: exported,
      fileId: file.id,
      onStart: (w) => {
        workers = w;
        console.log(`[selftest] rendering with ${w} website copies`);
      },
      stats,
      view,
      renderer,
      siteTexture,
      onProgress: (done, total) => {
        if (done % 30 === 0 || done === total) console.log(`[selftest] frame ${done}/${total}`);
      },
      onFrameRendered: config.lean
        ? undefined
        : (n, step) => {
            // A reused frame is identical to the previous website frame.
            const frame = step.frame ?? lastFrame!;
            lastFrame = frame;
            const check = step.reuseCheck;
            if (check?.wouldReuse) {
              reuse.wouldReuse++;
              if (check.differingPixels < 0 || check.maxDelta > 3 || check.differingPixels > 200) {
                reuse.wrong.push({ n, differingPixels: check.differingPixels, maxDelta: check.maxDelta });
              }
            }
            frames.push({
              n,
              pageTime: step.pageTime,
              timedOut: step.timedOut,
              timings: step.timings,
              fingerprint: step.fingerprint,
              size: `${frame.width}x${frame.height}`,
            });
            if (config.dumpFrames) {
              pending.push(downscaleRgb(frame).then((rgb) => window.looit.selfTest.writeFile(`frame-${n}.bin`, rgb)));
            }
            if (snapshotFrames.has(n)) {
              const composite = new Promise<Blob | null>((r) => renderer.domElement.toBlob(r, 'image/png'));
              pending.push(
                write(`composite-${n}.png`, composite),
                window.looit.selfTest.writeFile(`website-${n}.png`, frame.png),
              );
            }
          },
    });
    await Promise.all(pending);
    const elapsed = performance.now() - started;
    await window.looit.exporter.closeFile(file.id, true);
    const deltas = frames.slice(1).map((f, i) => (f.pageTime ?? NaN) - (frames[i].pageTime ?? NaN));
    await window.looit.selfTest.writeFile(
      'report.json',
      JSON.stringify(
        {
          output: { ...config, projectText: config.projectText ? '(project file)' : null },
          workers,
          reuse: { ...reuse, reused: stats.reused },
          elapsedMs: Math.round(elapsed),
          mainStageMs: frames.reduce(
            (acc, f) => {
              for (const k of ['input', 'advance', 'capture'] as const) acc[k] += Math.round(f.timings?.[k] ?? 0);
              return acc;
            },
            { input: 0, advance: 0, capture: 0 },
          ),
          stageMs: {
            website: Math.round(stats.website),
            render: Math.round(stats.render),
            encode: Math.round(stats.encode),
          },
          deltaMin: config.lean ? null : Math.min(...deltas),
          deltaMax: config.lean ? null : Math.max(...deltas),
          frames,
        },
        null,
        1,
      ),
    );
    ok = true;
  } catch (err) {
    log.push(String(err instanceof Error ? err.stack : err));
  } finally {
    setEditor({ exporting: false });
    if (log.length) await window.looit.selfTest.writeFile('error.txt', log.join('\n'));
    window.looit.selfTest.finish(ok);
  }
}
