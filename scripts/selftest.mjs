// Runs the app in self-test mode: exports test-pages/clock.html with virtual
// time and writes frames, an MP4 and report.json to selftest-out/.
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const out = path.resolve('selftest-out');
rmSync(out, { recursive: true, force: true });
const child = spawn('npx', ['electron-forge', 'start'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, LOOIT_SELFTEST_OUT: out, ELECTRON_ENABLE_LOGGING: '1' },
});
child.on('exit', () => {
  // Forge does not forward the app's exit code, so judge by the report.
  const ok = existsSync(path.join(out, 'report.json'));
  console.log(`self-test ${ok ? 'PASSED' : 'FAILED'}; output in ${out}`);
  process.exit(ok ? 0 : 1);
});
