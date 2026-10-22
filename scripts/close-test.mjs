// End-to-end test of closing the window with unsaved changes. The window is closed the way the X
// button does it (a real WM_CLOSE sent from outside the app; `window.close()` from page script takes a
// different path and proves nothing). First answer Cancel: the window must stay open. Second answer
// Save and close: an edit made a moment before closing (before autosave could run) is written and the
// app exits. The dialog is answered by LOOIT_TEST_CLOSE_CHOICES (development only).
//   node scripts/close-test.mjs
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = 9352;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

// Keep the test away from the user's real projects.
const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'looit-close-'));
const closeFlag = path.join(os.tmpdir(), `looit-close-test-${PORT}.flag`);
await fs.rm(closeFlag, { force: true });
const env = { ...process.env, LOOIT_LIBRARY_DIR: libraryDir, LOOIT_TEST_CLOSE_CHOICES: '2,0' };
delete env.ELECTRON_RUN_AS_NODE;
// The editor state hook used below only exists in development mode.
delete env.NODE_ENV;
const app = spawn('npx', ['electron-forge', 'start', '--', `--remote-debugging-port=${PORT}`], {
  shell: true,
  env,
  stdio: 'ignore',
});
let watcher = null;

const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).json();

async function editorTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const t = (await list()).find((x) => x.url.startsWith('http://localhost'));
      if (t) return t;
    } catch {}
    await sleep(500);
  }
  throw new Error('App did not start');
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result ?? { error: m.error });
      pending.delete(m.id);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const ev = (expression) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, (r) =>
        r.exceptionDetails
          ? reject(new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed'))
          : resolve(r.result?.value),
      );
      ws.send(
        JSON.stringify({
          id: i,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  return { ev };
}

async function waitFor(ed, expression, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await ed.ev(expression).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

const clickByText = (selector, text) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)})); if (!el) return 'missing'; el.click(); return 'ok'; })()`;
const dirty = `(() => { const s = window.__looitEditor.getState(); return s.project !== s.savedProject; })()`;
const objectCount = `window.__looitEditor.getState().project.objects.length`;

// Starting PowerShell takes longer than the 500 ms autosave, so a watcher is started first and waits for
// a flag file; touching the file closes the app's window within a few milliseconds.
async function armWindowCloser() {
  const script =
    `$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -match 'remote-debugging-port=${PORT}' -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1; ` +
    `if (-not $p) { 'not-found'; exit }; 'armed'; ` +
    `while ($true) { if (Test-Path '${closeFlag}') { Remove-Item '${closeFlag}' -Force; $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue; if ($proc) { $null = $proc.CloseMainWindow() } }; Start-Sleep -Milliseconds 15 }`;
  watcher = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    watcher.stdout.on('data', (d) => {
      if (String(d).includes('armed')) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}
const closeWindow = () => fs.writeFile(closeFlag, '1');

try {
  const ed = await connect(await editorTarget());
  check('onboarding screen is shown at launch', await waitFor(ed, `!!document.querySelector('.home')`, 30_000));
  await ed.ev(`(() => {
    const input = document.querySelector('.new-row input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Close test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  await ed.ev(clickByText('button', 'Create project'));
  check('creating a project opens the editor', await waitFor(ed, `!!document.querySelector('.app')`, 20_000));
  const file = await ed.ev(`window.__looitEditor.getState().filePath`);
  await sleep(1500); // let the first autosave settle
  check('the window closer is ready', await armWindowCloser());
  const before = await ed.ev(objectCount);

  // First edit, then close at once: autosave (500 ms) has not run yet. Answer: Cancel.
  await ed.ev(clickByText('.rail-btn', 'Text'));
  check('the edit is unsaved', (await ed.ev(dirty)) === true);
  await closeWindow();
  await sleep(1500);
  const stillOpen = await list().then(
    (l) => l.some((t) => t.url.startsWith('http://localhost')),
    () => false,
  );
  check('Cancel keeps the window open', stillOpen);

  // Second edit, then close at once. Answer: Save and close. The file gets the edit and the app exits.
  await ed.ev(clickByText('.rail-btn', 'Text'));
  check('the second edit is unsaved', (await ed.ev(dirty)) === true);
  await closeWindow();
  let exited = false;
  for (let i = 0; i < 60 && !exited; i++) {
    await sleep(500);
    exited = await list().then(
      () => false,
      () => true,
    );
  }
  check('Save and close closes the app', exited);
  const after = JSON.parse(await fs.readFile(file, 'utf8')).objects.length;
  check('both edits made just before closing were saved', after === before + 2, `${before} -> ${after}`);
} catch (err) {
  check('unexpected error', false, err instanceof Error ? err.message : String(err));
} finally {
  // `app.kill()` only stops the shell that started forge; kill the tree too.
  for (const pid of [app.pid, watcher?.pid]) {
    if (!pid) continue;
    try {
      execSync(`taskkill /pid ${pid} /t /f`, { stdio: 'ignore' });
    } catch {}
  }
  app.kill();
  await sleep(1500);
  await fs.rm(libraryDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(closeFlag, { force: true }).catch(() => {});
  console.log(failures === 0 ? '\nclose test PASSED' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
