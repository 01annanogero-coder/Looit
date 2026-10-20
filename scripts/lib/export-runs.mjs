// Helpers for export tests: run the self-test with settings, keep its output,
// and compare two runs' website frames pixel by pixel.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Invisible differences that are allowed: GPU rasterisation noise (a few
 * pixels off by 1-3 levels), and Chromium's real-time image-quality refinement
 * (a scaled image redrawn at higher quality a few ms later), which frame reuse
 * can shift by one frame (seen: 12 pixels off by 4 on Wikipedia's logo).
 * A stale or wrong frame differs by far more.
 */
const MAX_NOISE_DELTA = 6;
const MAX_NOISE_PIXELS = 50;

export function workDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'looit-export-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs one self-test export with `env` and copies its output into `work`/`label`. */
export function runExport(work, label, env) {
  const r = spawnSync('node', ['scripts/selftest.mjs'], {
    env: { ...process.env, LOOIT_SELFTEST_DUMP: '1', ...env },
    encoding: 'utf8',
    timeout: 900_000,
  });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`${label}: self-test failed`);
  }
  const dir = path.join(work, label.replace(/\W+/g, '-'));
  cpSync(path.resolve('selftest-out'), dir, { recursive: true });
  const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
  return { dir, report };
}

/** Compares every website frame of two runs. Returns true if all match (within noise). */
export function compareRuns(a, b, label) {
  const bad = [];
  let noisy = 0;
  for (const f of a.report.frames) {
    const fa = readFileSync(path.join(a.dir, `frame-${f.n}.bin`));
    const fb = readFileSync(path.join(b.dir, `frame-${f.n}.bin`));
    let pixels = 0;
    let maxDelta = 0;
    for (let i = 0; i < fa.length; i += 3) {
      const d = Math.max(Math.abs(fa[i] - fb[i]), Math.abs(fa[i + 1] - fb[i + 1]), Math.abs(fa[i + 2] - fb[i + 2]));
      if (d > 0) {
        pixels++;
        maxDelta = Math.max(maxDelta, d);
      }
    }
    if (fa.length !== fb.length || maxDelta > MAX_NOISE_DELTA || pixels > MAX_NOISE_PIXELS) {
      bad.push(`${f.n} (${pixels} px, max ${maxDelta})`);
    } else if (pixels > 0) noisy++;
  }
  const n = a.report.frames.length;
  console.log(
    `${bad.length === 0 ? 'PASS' : 'FAIL'}  ${label}: ${n - bad.length}/${n} frames match` +
      (noisy ? ` (${noisy} with invisible raster noise)` : '') +
      (bad.length ? `; differing: ${bad.slice(0, 8).join(', ')}` : ''),
  );
  return bad.length === 0;
}
