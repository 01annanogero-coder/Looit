// Export determinism test: exports test-pages/determinism.html with 1 website
// copy (twice) and with several copies in parallel, then compares every
// website frame pixel by pixel (invisible GPU raster noise is tolerated).
//   node scripts/determinism-test.mjs [parallelWorkers=3] [testPage=determinism]
import { compareRuns, runExport, workDir } from './lib/export-runs.mjs';

const parallel = Number(process.argv[2] ?? 3);
const page = process.argv[3] ?? 'determinism';
const work = workDir();
const run = (workers, label) => {
  const r = runExport(work.dir, label, { LOOIT_SELFTEST_PAGE: page, LOOIT_EXPORT_WORKERS: String(workers) });
  console.log(`${label}: ${r.report.workers} cop${r.report.workers === 1 ? 'y' : 'ies'}, ${r.report.elapsedMs} ms`);
  return r;
};

try {
  const seqA = run(1, 'sequential run 1');
  const seqB = run(1, 'sequential run 2');
  const par = run(parallel, 'parallel run');
  const ok = [
    compareRuns(seqA, seqB, 'sequential vs sequential'),
    compareRuns(seqA, par, `sequential vs ${parallel} copies`),
  ];
  console.log(`speed-up: ${(seqA.report.elapsedMs / par.report.elapsedMs).toFixed(2)}x`);
  process.exitCode = ok.every(Boolean) ? 0 : 1;
} finally {
  work.cleanup();
}
