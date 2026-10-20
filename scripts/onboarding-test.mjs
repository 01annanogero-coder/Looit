// End-to-end test of the onboarding screen: creates a project through the UI,
// checks that edits are autosaved to the .looit file, then renames, pins,
// opens the demo and deletes it again.
//   node scripts/onboarding-test.mjs
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

// Keep the test away from the user's real projects.
const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'looit-onboarding-'));
const env = { ...process.env, LOOIT_LIBRARY_DIR: libraryDir };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn('npx', ['electron-forge', 'start', '--', `--remote-debugging-port=${PORT}`], {
  shell: true,
  env,
  stdio: 'ignore',
});

async function targets() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      if (list.some((t) => t.url.startsWith('http://localhost'))) return list;
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
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result?.value;
  };
  return { send, ev, close: () => ws.close() };
}

async function waitFor(ed, expression, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await ed.ev(expression).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

/** Clicks the first element matching `selector` whose text contains `text`. */
const clickByText = (selector, text) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)})); if (!el) return 'missing'; el.click(); return 'ok'; })()`;

try {
  const list = await targets();
  const ed = await connect(list.find((t) => t.url.startsWith('http://localhost')));

  check('onboarding screen is shown at launch', await waitFor(ed, `!!document.querySelector('.home')`, 30_000));
  check('editor is not shown yet', !(await ed.ev(`!!document.querySelector('.app')`)));

  // 1. Create a project with a name.
  await ed.ev(`(() => {
    const input = document.querySelector('.new-row input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Onboarding test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  await ed.ev(clickByText('button', 'Create project'));
  check('creating a project opens the editor', await waitFor(ed, `!!document.querySelector('.app')`, 20_000));
  const file = await ed.ev(`window.__looitEditor.getState().filePath`);
  check(
    'the project has a .looit file',
    typeof file === 'string' && file.endsWith('Onboarding test.looit'),
    String(file),
  );
  const onDisk = await fs
    .readFile(file, 'utf8')
    .then((t) => JSON.parse(t))
    .catch(() => null);
  check('the file exists and holds the project', onDisk?.name === 'Onboarding test', onDisk?.name);
  const blankUrl = await ed.ev(
    `(() => { const w = window.__looitEditor.getState().project.objects.find(o => o.kind === 'website'); return w && w.url; })()`,
  );
  check('a new project starts as a blank browser card', blankUrl === '', String(blankUrl));

  // 2. Point the card at a website from the Inspector.
  await ed.ev(`(() => {
    const input = document.querySelector('.url-row input');
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'example.com');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  })()`);
  await sleep(900);
  const liveUrl = await ed.ev(
    `(() => { const w = window.__looitEditor.getState().project.objects.find(o => o.kind === 'website'); return w && w.url; })()`,
  );
  check(
    'typing an address points the panel at a site',
    /^https:\/\/example\.com\/?$/.test(String(liveUrl)),
    String(liveUrl),
  );

  // 3. Editing autosaves: add a text object and wait for the file to change.
  const before = onDisk.objects.length;
  await ed.ev(clickByText('.rail-btn', 'Text'));
  await sleep(1400);
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  check(
    'an edit is autosaved to the file',
    after.objects.length === before + 1,
    `${before} -> ${after.objects.length}`,
  );
  check(
    'autosave cleared the unsaved marker',
    (await ed.ev(`window.__looitEditor.getState().project === window.__looitEditor.getState().savedProject`)) === true,
  );

  // 3. Back to the library, rename the project.
  await ed.ev(`document.querySelector('.topbar-actions button[title="Back to your projects"]').click()`);
  check('Projects returns to the library', await waitFor(ed, `!!document.querySelector('.home')`, 15_000));
  await ed.ev(
    `(() => { const row = [...document.querySelectorAll('.project-row')].find(r => r.textContent.includes('Onboarding test')); row.querySelector('button[title="Rename"]').click(); })()`,
  );
  await waitFor(ed, `!!document.querySelector('.rename-input')`, 5000);
  await ed.ev(`(() => {
    const input = document.querySelector('.rename-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Renamed test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await ed.ev(
    `document.querySelector('.rename-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  );
  check(
    'renaming updates the list',
    await waitFor(
      ed,
      `[...document.querySelectorAll('.project-name')].some(e => e.textContent.includes('Renamed test'))`,
      10_000,
    ),
  );
  const renamed = path.join(path.dirname(file), 'Renamed test.looit');
  check(
    'renaming renames the file',
    await fs.stat(renamed).then(
      () => true,
      () => false,
    ),
  );
  check(
    'the old file is gone',
    !(await fs.stat(file).then(
      () => true,
      () => false,
    )),
  );
  check('the name inside the file follows', JSON.parse(await fs.readFile(renamed, 'utf8')).name === 'Renamed test');

  // 4. Pin it.
  await ed.ev(
    `(() => { const row = [...document.querySelectorAll('.project-row')].find(r => r.textContent.includes('Renamed test')); row.querySelector('button[title="Pin to top"]').click(); })()`,
  );
  check('pinning marks the row', await waitFor(ed, `!!document.querySelector('.project-row.pinned')`, 8000));

  // 5. The demo project opens the electronjs.org project.
  await ed.ev(`document.querySelector('.demo-card').click()`);
  check('demo opens the editor', await waitFor(ed, `!!document.querySelector('.app')`, 20_000));
  const demoUrl = await ed.ev(
    `(() => { const w = window.__looitEditor.getState().project.objects.find(o => o.kind === 'website'); return w && w.url; })()`,
  );
  check(
    'demo shows electronjs.org',
    typeof demoUrl === 'string' && demoUrl.includes('electronjs.org'),
    String(demoUrl),
  );
  const demoFile = await ed.ev(`window.__looitEditor.getState().filePath`);
  check(
    'demo has its own project file',
    typeof demoFile === 'string' && demoFile.endsWith('Demo project.looit'),
    String(demoFile),
  );

  // 6. Continue with a project from the list.
  await ed.ev(`document.querySelector('.topbar-actions button[title="Back to your projects"]').click()`);
  await waitFor(ed, `!!document.querySelector('.home')`, 15_000);
  await ed.ev(
    `(() => { const row = [...document.querySelectorAll('.project-row')].find(r => r.textContent.includes('Renamed test')); row.querySelector('.project-main').click(); })()`,
  );
  check('Continue with reopens the project', await waitFor(ed, `!!document.querySelector('.app')`, 15_000));
  check(
    'the reopened project is the renamed one',
    (await ed.ev(`window.__looitEditor.getState().project.name`)) === 'Renamed test',
  );

  // 7. Delete both test projects (confirmation is auto-accepted).
  await ed.ev(`document.querySelector('.topbar-actions button[title="Back to your projects"]').click()`);
  await waitFor(ed, `!!document.querySelector('.home')`, 15_000);
  await ed.ev(`window.confirm = () => true`);
  for (const name of ['Renamed test', 'Demo project']) {
    await ed.ev(
      `(() => { const row = [...document.querySelectorAll('.project-row')].find(r => r.textContent.includes(${JSON.stringify(name)})); if (row) row.querySelector('button[title="Delete"]').click(); })()`,
    );
    await sleep(700);
  }
  check(
    'deleting removes the file',
    !(await fs.stat(renamed).then(
      () => true,
      () => false,
    )),
  );
  check(
    'deleting removes the demo file',
    !(await fs.stat(demoFile).then(
      () => true,
      () => false,
    )),
  );
  check('the list is empty again', (await ed.ev(`document.querySelectorAll('.project-row').length`)) === 0);
  ed.close();
} catch (err) {
  check('unexpected error', false, err instanceof Error ? err.message : String(err));
} finally {
  // `app.kill()` only stops the shell that started forge; kill the tree too, or
  // the next run would attach to this app and test stale code.
  try {
    execSync(`taskkill /pid ${app.pid} /t /f`, { stdio: 'ignore' });
  } catch {}
  app.kill();
  await sleep(1500);
  await fs.rm(libraryDir, { recursive: true, force: true }).catch(() => {});
  console.log(failures === 0 ? '\nonboarding test PASSED' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
