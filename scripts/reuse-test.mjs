// Frame-reuse test: exports each target with frame reuse off and on and checks
// that every website frame is the same (reuse must never show a stale frame).
//   node scripts/reuse-test.mjs [target...]
// Targets: test page names (test-pages/<name>.html) or https:// URLs.
import { compareRuns, runExport, workDir } from './lib/export-runs.mjs';

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['mostly-static', 'determinism', 'https://en.wikipedia.org/wiki/Electron', 'https://example.com/'];
const work = workDir();
let ok = true;

try {
  for (const target of targets) {
    const env = target.startsWith('https://') ? { LOOIT_SELFTEST_URL: target } : { LOOIT_SELFTEST_PAGE: target };
    const off = runExport(work.dir, `${target} off`, { ...env, LOOIT_EXPORT_REUSE: '0' });
    const on = runExport(work.dir, `${target} on`, { ...env, LOOIT_EXPORT_REUSE: '1' });
    const same = compareRuns(off, on, `${target}: reuse on vs off`);
    console.log(
      `      ${on.report.reuse.reused}/${on.report.frames.length} frames reused; ` +
        `${off.report.elapsedMs} ms -> ${on.report.elapsedMs} ms (diagnostics on, so timings are indicative only)`,
    );
    ok &&= same;
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  if (process.env.LOOIT_KEEP_TEST_OUTPUT === '1') console.log(`output kept in ${work.dir}`);
  else work.cleanup();
}
