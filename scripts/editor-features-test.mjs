// End-to-end test of the editor features a person uses directly:
// screen-space (HUD) text with a pill, the fixed-size cursor, and exporting a
// blank project (which has no website frames at all).
//   node scripts/editor-features-test.mjs
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = 9356;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'looit-editor-'));
const libraryDir = path.join(scratch, 'projects');
const exportDir = path.join(scratch, 'exports');
const env = { ...process.env, LOOIT_LIBRARY_DIR: libraryDir, LOOIT_TEST_EXPORT_DIR: exportDir };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn('npx', ['electron-forge', 'start', '--', `--remote-debugging-port=${PORT}`], {
  shell: true,
  env,
  stdio: 'ignore',
});

async function list() {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  } catch {
    return [];
  }
}
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
  return { send, ev };
}

async function waitFor(ed, expression, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await ed.ev(expression).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

const text = () => `window.__looitEditor.getState().project.objects.find(o => o.kind === 'text')`;
const cursor = () => `window.__looitEditor.getState().project.objects.find(o => o.kind === 'cursor')`;

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
    setter.call(input, 'Editor features');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150);
  await ed.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Create project')).click()`);
  check('a new project opens', await waitFor(ed, `!!document.querySelector('.app')`, 20_000));

  // 1. Add text and make it a HUD.
  await ed.ev(`[...document.querySelectorAll('.rail-btn')].find(b => b.textContent.includes('Text')).click()`);
  await sleep(300);
  const placement = await ed.ev(`(() => {
    const select = [...document.querySelectorAll('.right select')].find(s => [...s.options].some(o => o.value === 'screen'));
    if (!select) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'screen');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  check('text properties offer "On screen" placement', placement === 'ok', String(placement));
  await sleep(300);
  check(
    'choosing it pins the text to the frame',
    (await ed.ev(`(() => { const t = ${text()}; return t && t.space; })()`)) === 'screen',
  );
  check(
    'the world size becomes a frame fraction',
    await ed.ev(`(() => { const t = ${text()}; return !!t && t.size > 0.01 && t.size < 0.2; })()`),
    String(await ed.ev(`(() => { const t = ${text()}; return t && t.size; })()`)),
  );

  // 2. Pill toggle.
  const pill = await ed.ev(`(() => {
    const row = [...document.querySelectorAll('.prop-row')].find(r => r.textContent.startsWith('Pill'));
    const box = row && row.querySelector('input[type=checkbox]');
    if (!box) return 'missing';
    box.click();
    return 'ok';
  })()`);
  check('the text panel has a pill toggle', pill === 'ok', String(pill));
  await sleep(300);
  check(
    'the pill is stored with the text',
    await ed.ev(`(() => { const t = ${text()}; return !!(t && t.background && t.background.opacity > 0); })()`),
  );

  // 3. Cursor keeps its size when zoomed.
  await ed.ev(`(() => {
    const row = [...document.querySelectorAll('.tree-row')].find(r => r.textContent.includes('Cursor'));
    row.click();
  })()`);
  await sleep(300);
  const fixed = await ed.ev(`(() => {
    const row = [...document.querySelectorAll('.prop-row')].find(r => r.textContent.startsWith('Same size when zoomed'));
    const box = row && row.querySelector('input[type=checkbox]');
    if (!box) return 'missing';
    box.click();
    return 'ok';
  })()`);
  check('the cursor panel has a fixed-size toggle', fixed === 'ok', String(fixed));
  await sleep(300);
  check(
    'the cursor flag is stored',
    (await ed.ev(`(() => { const c = ${cursor()}; return c && c.fixedScreenSize; })()`)) === true,
  );

  // 4. Put the cursor on a page spot, then aim the camera at it.
  await ed.ev(`(() => {
    const row = [...document.querySelectorAll('.prop-row')].find(r => r.textContent.startsWith('Position'));
    const fields = row.querySelectorAll('input');
    const set = (el, value) => {
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      el.blur();
    };
    set(fields[0], '200');
    set(fields[1], '100');
  })()`);
  await sleep(400);
  const cursorPx = await ed.ev(
    `(() => { const c = ${cursor()}; return c.position.keyframes[0]?.value ?? c.position.value; })()`,
  );
  check('the cursor position is set in page pixels', String(cursorPx) === '200,100', String(cursorPx));

  await ed.ev(`(() => {
    const row = [...document.querySelectorAll('.tree-row')].find(r => r.textContent.includes('Camera'));
    row.click();
  })()`);
  await sleep(300);
  const aimed = await ed.ev(`(() => {
    const button = [...document.querySelectorAll('.right button')].find(b => b.textContent.includes('Aim at the cursor'));
    if (!button) return 'missing';
    button.click();
    const cam = window.__looitEditor.getState().project.objects.find(o => o.kind === 'camera');
    const v = cam.target.keyframes[0]?.value ?? cam.target.value;
    return v.map(n => Math.round(n * 100) / 100).join(',');
  })()`);
  // (200, 100) on a 1280x720 panel is world (-5.5, 3.25) with the default transform.
  check('Aim at the cursor frames that page point', aimed === '-5.5,3.25,0', String(aimed));

  // 5. Both survive a save and reopen.
  const file = await ed.ev(`window.__looitEditor.getState().filePath`);
  await sleep(1200);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  const savedText = saved.objects.find((o) => o.kind === 'text');
  const savedCursor = saved.objects.find((o) => o.kind === 'cursor');
  check('the HUD text is autosaved', savedText?.space === 'screen' && !!savedText?.background);
  check('the cursor flag is autosaved', savedCursor?.fixedScreenSize === true);

  // 5. Export a project whose only panel is blank.
  await ed.ev(`document.querySelector('.topbar-actions button.primary').click()`);
  let mp4 = null;
  for (let i = 0; i < 180; i++) {
    const files = await fs.readdir(exportDir).catch(() => []);
    const done = files.find((f) => f.endsWith('.mp4'));
    if (done) {
      const stat = await fs.stat(path.join(exportDir, done));
      if (stat.size > 0) {
        mp4 = { name: done, size: stat.size };
        break;
      }
    }
    await sleep(1000);
  }
  check(
    'a blank project exports without a website',
    !!mp4,
    mp4 ? `${mp4.name}, ${Math.round(mp4.size / 1024)} KB` : 'no file',
  );
  check('the export reports success', await waitFor(ed, `!window.__looitEditor.getState().exporting`, 120_000));
  const status = await ed.ev(`window.__looitEditor.getState().status?.text ?? ''`);
  check('no export error is shown', !/failed/i.test(String(status)), String(status).slice(0, 120));

  // 6. Native <select> menus are drawn inside the page (a real popup never is).
  await ed.ev(`(() => {
    const row = [...document.querySelectorAll('.tree-row')].find(r => r.textContent.includes('Website Panel'));
    row.click();
  })()`);
  await sleep(300);
  await ed.ev(`(() => {
    const input = document.querySelector('.url-row input');
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'https://www.selenium.dev/selenium/web/web-form.html');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  })()`);
  let pageTarget = null;
  for (let i = 0; i < 60 && !pageTarget; i++) {
    pageTarget = (await list()).find((x) => x.url.includes('selenium/web/web-form'));
    if (!pageTarget) await sleep(1000);
  }
  check('the form page loads', !!pageTarget, pageTarget ? 'loaded' : 'not found');
  if (pageTarget) {
    const pg = await connect(pageTarget);
    await sleep(4000);
    const rect = await pg.ev(`(() => {
      const s = document.querySelector('select');
      const r = s.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await pg.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        button: 'left',
        clickCount: 1,
      });
    }
    await sleep(400);
    const menu = await pg.ev(`(() => {
      const m = document.querySelector('.__looit-menu');
      return m ? [...m.children].map(d => d.textContent) : null;
    })()`);
    check('clicking a <select> opens a visible menu', Array.isArray(menu) && menu.length > 2, JSON.stringify(menu));
    if (Array.isArray(menu) && menu.length > 2) {
      const item = await pg.ev(`(() => {
        const el = document.querySelector('.__looit-menu').children[2];
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await pg.send('Input.dispatchMouseEvent', {
          type,
          x: Math.round(item.x),
          y: Math.round(item.y),
          button: 'left',
          clickCount: 1,
        });
      }
      await sleep(300);
      const value = await pg.ev(`document.querySelector('select').value`);
      check('choosing an entry sets the select value', value === '2', String(value));
    }
  }
} catch (err) {
  check('unexpected error', false, err instanceof Error ? err.message : String(err));
} finally {
  try {
    execSync(`taskkill /pid ${app.pid} /t /f`, { stdio: 'ignore' });
  } catch {}
  app.kill();
  await sleep(1500);
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  console.log(failures === 0 ? '\neditor features test PASSED' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
