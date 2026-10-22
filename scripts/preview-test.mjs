// End-to-end test of the full-screen preview: Preview fills the window with the
// 3D view, plays from the start, loops at the end, and Esc returns to the editor.
//   node scripts/preview-test.mjs
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = 9363;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'looit-preview-'));
const env = { ...process.env, LOOIT_LIBRARY_DIR: path.join(scratch, 'projects') };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn('npx', ['electron-forge', 'start', '--', `--remote-debugging-port=${PORT}`], {
  shell: true,
  env,
  stdio: 'ignore',
});

const list = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  } catch {
    return [];
  }
};

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result ?? {});
      pending.delete(m.id);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'failed');
    return r.result?.value;
  };
  return { ev };
}

const waitFor = async (ed, expression, timeout = 15_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await ed.ev(expression).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};

try {
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    target = (await list()).find((x) => x.url.startsWith('http://localhost'));
    if (!target) await sleep(500);
  }
  const ed = await connect(target);
  await waitFor(ed, `!!document.querySelector('.home')`, 30_000);
  await ed.ev(`(() => {
    const input = document.querySelector('.new-row input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Preview test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150);
  await ed.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Create project')).click()`);
  check('a project is open', await waitFor(ed, `!!document.querySelector('.app')`, 20_000));

  // A short project makes the loop quick to observe.
  await ed.ev(`(() => {
    const s = window.__looitEditor.getState();
    const project = { ...s.project, duration: 1.2 };
    window.__looitEditor.setState({ project, savedProject: project });
    return true;
  })()`);

  // 1. Preview fills the window with the 3D view and starts playing.
  await ed.ev(
    `[...document.querySelectorAll('.topbar-actions button')].find(b => b.textContent.includes('Preview')).click()`,
  );
  check('Preview enters full-screen mode', await waitFor(ed, `!!document.querySelector('.app.preview-mode')`, 5000));
  check(
    'the editor chrome is hidden',
    (await ed.ev(`getComputedStyle(document.querySelector('.topbar')).display`)) === 'none',
    String(await ed.ev(`getComputedStyle(document.querySelector('.topbar')).display`)),
  );
  check(
    'the 3D viewport is shown',
    (await ed.ev(`!!document.querySelector('.app.preview-mode .viewport canvas')`)) === true,
  );
  check('playback started from the beginning', (await ed.ev(`window.__looitEditor.getState().playing`)) === true);
  await sleep(400);
  const first = await ed.ev(`window.__looitEditor.getState().time`);
  check('the playhead moves', first > 0, String(first));

  // 2. It loops at the end instead of stopping.
  let wrapped = false;
  let previous = first;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const state = await ed.ev(
      `(() => { const s = window.__looitEditor.getState(); return { time: s.time, playing: s.playing }; })()`,
    );
    if (!state.playing) break;
    if (state.time < previous - 0.05) {
      wrapped = true;
      break;
    }
    previous = state.time;
  }
  check('the video loops at the end', wrapped, `wrapped=${wrapped}`);
  check('it is still playing after the loop', (await ed.ev(`window.__looitEditor.getState().playing`)) === true);

  // 3. Esc leaves the preview and stops playback.
  await ed.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  check('Esc leaves the preview', await waitFor(ed, `!document.querySelector('.app.preview-mode')`, 5000));
  check('playback stopped', (await ed.ev(`window.__looitEditor.getState().playing`)) === false);
  check('the editor is back', (await ed.ev(`getComputedStyle(document.querySelector('.topbar')).display`)) !== 'none');
} catch (err) {
  check('unexpected error', false, err instanceof Error ? err.message : String(err));
} finally {
  try {
    execSync(`taskkill /pid ${app.pid} /t /f`, { stdio: 'ignore' });
  } catch {}
  app.kill();
  await sleep(1500);
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  console.log(failures === 0 ? '\npreview test PASSED' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
