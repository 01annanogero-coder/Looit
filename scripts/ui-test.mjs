// End-to-end UI test: launches the dev app with remote debugging, drives the
// editor with real mouse/keyboard events and checks the editor state.
//   node scripts/ui-test.mjs
import { spawn, execSync } from 'node:child_process';

const PORT = 9350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const env = { ...process.env };
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

try {
  const list = await targets();
  const ed = await connect(list.find((t) => t.url.startsWith('http://localhost')));
  for (let i = 0; i < 60; i++) {
    const ready = await ed
      .ev(`!!window.__looitEditor && document.querySelectorAll('.lane .marker.p-position').length > 1`)
      .catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  await sleep(1500);
  const state = (expr) =>
    ed.ev(
      `(() => { const s = window.__looitEditor.getState(); const W = s.project.objects.find(o => o.kind === 'website'); return ${expr}; })()`,
    );
  const mouse = async (type, x, y, extra = {}) =>
    ed.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  const drag = async (x1, y1, x2, y2) => {
    await mouse('mouseMoved', x1, y1, { button: 'none' });
    await mouse('mousePressed', x1, y1);
    for (let i = 1; i <= 10; i++) await mouse('mouseMoved', x1 + ((x2 - x1) * i) / 10, y1 + ((y2 - y1) * i) / 10);
    await mouse('mouseReleased', x2, y2);
  };
  const key = async (k, code, extra = {}) => {
    await ed.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: k,
      code,
      windowsVirtualKeyCode: extra.vk,
      modifiers: extra.modifiers ?? 0,
    });
    await ed.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: k,
      code,
      windowsVirtualKeyCode: extra.vk,
      modifiers: extra.modifiers ?? 0,
    });
  };
  const rect = (sel, i = 0) =>
    ed.ev(
      `(() => { const r = document.querySelectorAll(${JSON.stringify(sel)})[${i}].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`,
    );
  const posKeys = () => state(`W.transform.position.keyframes.map(k => k.time)`);

  // 1. Drag a keyframe diamond in the timeline.
  const before = await posKeys();
  const d = await rect('.lane .marker.p-position', 1);
  const laneW = await ed.ev(`document.querySelector('.tl-lanes').clientWidth`);
  const pps = (laneW - 28) / 5;
  await drag(d.x, d.y, d.x + pps * 0.5, d.y);
  const after = await posKeys();
  check(
    'drag keyframe moves it by 0.5 s',
    Math.abs(after[1] - (before[1] + 0.5)) < 0.04,
    `${before[1]} -> ${after[1]}`,
  );
  check('dragged keyframe lands on a frame', Math.abs(after[1] * 30 - Math.round(after[1] * 30)) < 1e-6);

  // 2. Undo restores it in one step.
  await key('z', 'KeyZ', { vk: 90, modifiers: 2 });
  await sleep(100);
  check('Ctrl+Z undoes the whole drag', (await posKeys())[1] === before[1], String((await posKeys())[1]));

  // 3. Arrow keys move the playhead by frames.
  for (let i = 0; i < 30; i++) await key('ArrowRight', 'ArrowRight', { vk: 39 });
  check('ArrowRight x30 = 1 s', Math.abs((await state('s.time')) - 1) < 1e-9, String(await state('s.time')));

  // 4. Typing a value on an animated property adds a keyframe at the playhead.
  await ed.ev(
    `(() => { const el = [...document.querySelectorAll('.prop-row')].find(r => r.textContent.startsWith('Position')).querySelector('input'); el.focus(); })()`,
  );
  await ed.send('Input.insertText', { text: '' });
  await ed.ev(`document.execCommand('selectAll')`);
  await ed.send('Input.insertText', { text: '5' });
  await key('Enter', 'Enter', { vk: 13 });
  await sleep(100);
  const kf = await state(`W.transform.position.keyframes.find(k => Math.abs(k.time - 1) < 1e-4)?.value`);
  check('typing Position X at 1 s creates keyframe [5, …]', kf?.[0] === 5, JSON.stringify(kf));

  // 5. Add text, then delete it.
  await ed.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Add text')).click()`);
  await sleep(100);
  check('Add text adds a text object', (await state(`s.project.objects.filter(o => o.kind === 'text').length`)) === 1);
  check('new text is selected', await state(`s.project.objects.find(o => o.id === s.selectedId)?.kind === 'text'`));
  await ed.ev(`document.activeElement?.blur()`);
  await key('Delete', 'Delete', { vk: 46 });
  await sleep(100);
  check(
    'Delete removes the selected text',
    (await state(`s.project.objects.filter(o => o.kind === 'text').length`)) === 0,
  );

  // 6. Space plays and pauses.
  await key('Home', 'Home', { vk: 36 });
  await key(' ', 'Space', { vk: 32 });
  await sleep(600);
  const playing = await state('s.playing');
  const t = await state('s.time');
  await key(' ', 'Space', { vk: 32 });
  check('Space starts playback', playing && t > 0.3, `playing=${playing} t=${t.toFixed(2)}`);
  check('Space pauses playback', !(await state('s.playing')));

  // 7. Clicking the panel in the viewport selects it; clicking empty space deselects.
  await key('End', 'End', { vk: 35 });
  await sleep(200);
  const c = await rect('.viewport-stage canvas');
  await mouse('mousePressed', c.x - c.w * 0.45, c.y - c.h * 0.45);
  await mouse('mouseReleased', c.x - c.w * 0.45, c.y - c.h * 0.45);
  check('click on empty viewport deselects', (await state('s.selectedId')) === null);
  await mouse('mousePressed', c.x + c.w * 0.2, c.y + c.h * 0.25);
  await mouse('mouseReleased', c.x + c.w * 0.2, c.y + c.h * 0.25);
  check(
    'click on panel selects the website',
    (await state(`s.project.objects.find(o => o.id === s.selectedId)?.kind`)) === 'website',
  );

  // 8. Interact mode (Tab) forwards the wheel to the live website.
  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  /** Waits while the status bar says the website is (re)loading. */
  const waitForWebsite = async () => {
    for (let i = 0; i < 240; i++) {
      if (!String(await state('s.status?.text ?? ""')).startsWith('Loading')) return;
      await sleep(250);
    }
  };
  const siteEval = async (expr) => {
    // While the preview rebuilds, a second (loading) page exists; wait until only
    // the page actually shown remains, so we never read the one being prepared.
    for (let i = 0; i < 60; i++) {
      const pages = (await targets()).filter((x) => x.type === 'page' && !x.url.startsWith('http://localhost'));
      if (pages.length === 1) break;
      await sleep(250);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const pages = (await targets()).filter((x) => x.type === 'page' && !x.url.startsWith('http://localhost'));
      for (const t of pages.reverse()) {
        try {
          const conn = await withTimeout(connect(t), 2000);
          try {
            return await withTimeout(conn.ev(expr), 2000);
          } finally {
            conn.close();
          }
        } catch {}
      }
      await sleep(500);
    }
    throw new Error('Could not reach the website page');
  };
  // Playing from the end rewound the playhead, which reloads the website: wait for it.
  await waitForWebsite();
  await key('Tab', 'Tab', { vk: 9 });
  await sleep(300);
  const y0 = await siteEval('scrollY');
  for (let i = 0; i < 3; i++) {
    await mouse('mouseWheel', c.x, c.y, { button: 'none', deltaX: 0, deltaY: 100 });
    await sleep(80);
  }
  await sleep(500);
  const y1 = await siteEval('scrollY');
  check('wheel in interact mode (Tab) scrolls the website', y1 > y0, `${y0} -> ${y1}`);
  await key('Escape', 'Escape', { vk: 27 });
  check('Esc leaves Interact mode', (await state('s.tool')) === 'select');

  // 9. Dragging the move gizmo's centre handle moves the panel (at 5 s it sits at the canvas centre).
  await sleep(300);
  const posAt5 = () => state(`W.transform.position.keyframes.find(k => k.time === 5).value`);
  const p0 = await posAt5();
  await drag(c.x, c.y, c.x + 120, c.y - 60);
  await sleep(200);
  const p1 = await posAt5();
  check(
    'gizmo drag moves the panel right and up',
    p1[0] > p0[0] + 0.5 && p1[1] > p0[1] + 0.2,
    `${JSON.stringify(p0)} -> ${JSON.stringify(p1)}`,
  );
  await key('z', 'KeyZ', { vk: 90, modifiers: 2 });
  await sleep(100);
  check('one Ctrl+Z undoes the whole gizmo drag', JSON.stringify(await posAt5()) === JSON.stringify(p0));

  // 10. Blender-style modal transforms.
  const typeKeys = async (...keys) => {
    for (const k of keys) {
      if (k === 'Enter') await key('Enter', 'Enter', { vk: 13 });
      else if (/^\d$/.test(k)) await key(k, `Digit${k}`, { vk: 48 + Number(k) });
      else await key(k, `Key${k.toUpperCase()}`, { vk: k.toUpperCase().charCodeAt(0) });
    }
  };
  await mouse('mouseMoved', c.x + 50, c.y + 20, { button: 'none' });
  await typeKeys('g', 'x', '2', 'Enter');
  await sleep(150);
  const g = await posAt5();
  check(
    'G X 2 Enter moves the panel exactly +2 on X',
    Math.abs(g[0] - (p0[0] + 2)) < 1e-9 && g[1] === p0[1] && g[2] === p0[2],
    JSON.stringify(g),
  );
  await typeKeys('r', 'z', '9', '0', 'Enter');
  await sleep(150);
  const rot = await state(`W.transform.rotation.keyframes.find(k => Math.abs(k.time - 5) < 1e-4)?.value`);
  check('R Z 90 Enter rotates exactly 90° on Z', rot?.[2] === 90, JSON.stringify(rot));
  const beforeCancel = await posAt5();
  await key('g', 'KeyG', { vk: 71 });
  for (let i = 0; i < 5; i++) await mouse('mouseMoved', c.x + 50 + i * 30, c.y + 20, { button: 'none' });
  await key('Escape', 'Escape', { vk: 27 });
  await sleep(150);
  check('Esc cancels a grab', JSON.stringify(await posAt5()) === JSON.stringify(beforeCancel));
  await typeKeys('s', '2', 'Enter');
  await sleep(150);
  const sc = await state(
    `W.transform.scale.keyframes.find(k => Math.abs(k.time - 5) < 1e-4)?.value ?? W.transform.scale.value`,
  );
  check(
    'S 2 Enter scales uniformly by 2',
    sc.every((v) => Math.abs(v - 2) < 1e-9),
    JSON.stringify(sc),
  );
  await key('z', 'KeyZ', { vk: 90, modifiers: 2 });

  // 11. Cursor tool: dragging on the page sets a cursor keyframe; the wheel adds a scroll event.
  await ed.ev(`window.__looitEditor.setState({ time: 1 })`);
  await key('c', 'KeyC', { vk: 67 });
  await sleep(200);
  await drag(c.x, c.y, c.x + 30, c.y + 10);
  await sleep(150);
  const ck = await state(
    `s.project.objects.find(o => o.kind === 'cursor').position.keyframes.find(k => Math.abs(k.time - 1) < 1e-4)?.value`,
  );
  check('cursor tool drag sets a cursor keyframe at the playhead', Array.isArray(ck), JSON.stringify(ck));
  for (let i = 0; i < 3; i++) await mouse('mouseWheel', c.x, c.y, { button: 'none', deltaX: 0, deltaY: 100 });
  await sleep(150);
  const scrollEv = await state(
    `s.project.objects.find(o => o.kind === 'cursor').scrolls.find(x => Math.abs(x.time - 1) < 1e-4)?.deltaY`,
  );
  check('cursor tool wheel adds one scroll event at the playhead', scrollEv === 300, String(scrollEv));

  // 12. The preview website follows the timeline.
  await ed.ev(`window.__looitEditor.setState({ time: 2 })`);
  await sleep(6000);
  const scrolledLater = await siteEval('scrollY');
  await ed.ev(`window.__looitEditor.setState({ time: 0.5 })`);
  await sleep(8000);
  const scrolledEarlier = await siteEval('scrollY');
  check('preview at 2 s shows the page scrolled by the 1 s scroll', scrolledLater >= 300, String(scrolledLater));
  check('scrubbing back to 0.5 s rebuilds the page unscrolled', scrolledEarlier === 0, String(scrolledEarlier));

  // 12b. Scroll to here: scroll the live page in Interact mode, turn it into a scroll event, replay it.
  await ed.ev(`window.__looitEditor.setState({ time: 3 })`);
  await sleep(1000);
  await waitForWebsite();
  await key('Tab', 'Tab', { vk: 9 });
  await sleep(1500);
  for (let i = 0; i < 5; i++) {
    await mouse('mouseWheel', c.x, c.y, { button: 'none', deltaX: 0, deltaY: 100 });
    await sleep(80);
  }
  await sleep(1200);
  const yHere = await siteEval('scrollY');
  await ed.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Scroll to here')).click()`);
  await sleep(1000);
  const added = await state(
    `s.project.objects.find(o => o.kind === 'cursor').scrolls.find(x => Math.abs(x.time - 3) < 1e-4)?.deltaY`,
  );
  check(
    'Scroll to here adds a scroll at the playhead and leaves Interact mode',
    (await state('s.tool')) === 'select' && added === yHere - scrolledLater,
    `${added} px, page at ${yHere}, timeline had ${scrolledLater}`,
  );
  await ed.ev(`window.__looitEditor.setState({ time: 4.5 })`);
  await sleep(7000);
  const yReplay = await siteEval('scrollY');
  check(
    'the replayed scroll lands where the page was scrolled to',
    Math.abs(yReplay - yHere) <= 2,
    `${yReplay} vs ${yHere}`,
  );

  // 13. Duration: type 1:00 in the End field; the wheel zooms the timeline.
  await key('Escape', 'Escape', { vk: 27 });
  await ed.ev(`document.querySelector('.duration-field input').focus()`);
  await ed.ev(`document.execCommand('selectAll')`);
  await ed.send('Input.insertText', { text: '1:00' });
  await key('Enter', 'Enter', { vk: 13 });
  await sleep(150);
  check('End field accepts 1:00 (60 s)', (await state('s.project.duration')) === 60);
  // The ruler is always visible at the top of the timeline (panel sizes persist between runs).
  const lanes = await rect('.ruler');
  await mouse('mouseWheel', lanes.x, lanes.y, { button: 'none', deltaX: 0, deltaY: -400 });
  await sleep(150);
  check(
    'wheel zooms the timeline (Fit becomes available)',
    await ed.ev(
      `![...document.querySelectorAll('.timeline-head button')].find(b => b.textContent.includes('Fit')).disabled`,
    ),
  );

  // 14. Layout: T / N hide panels; the timeline edge resizes.
  await ed.ev(`document.activeElement?.blur()`);
  await key('t', 'KeyT', { vk: 84 });
  await key('n', 'KeyN', { vk: 78 });
  await sleep(150);
  check(
    'T hides the left panel and N the properties',
    (await ed.ev(`!document.querySelector('.hierarchy') && !document.querySelector('.inspector')`)) === true,
  );
  await key('t', 'KeyT', { vk: 84 });
  await key('n', 'KeyN', { vk: 78 });
  await sleep(150);
  check(
    'T / N bring them back',
    (await ed.ev(`!!document.querySelector('.hierarchy') && !!document.querySelector('.inspector')`)) === true,
  );
  const h0 = await ed.ev(`document.querySelector('.area-time').getBoundingClientRect().height`);
  const sp = await rect('.splitter-top');
  await drag(sp.x, sp.y, sp.x, sp.y - 100);
  await sleep(150);
  const h1 = await ed.ev(`document.querySelector('.area-time').getBoundingClientRect().height`);
  check('dragging the timeline edge makes it taller', Math.abs(h1 - h0 - 100) < 3, `${h0} -> ${h1}`);
  await drag(sp.x, sp.y - 100, sp.x, sp.y);

  // 15. Multiple website panels: add one (with its cursor), delete it again; the last can't go.
  await ed.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Add website')).click()`);
  await sleep(300);
  check(
    'Add website adds a panel with its own cursor',
    (await state(
      `s.project.objects.filter(o => o.kind === 'website').length === 2 && s.project.objects.filter(o => o.kind === 'cursor').length === 2`,
    )) === true,
  );
  check(
    'the new panel is selected',
    (await state(`s.project.objects.find(o => o.id === s.selectedId)?.kind`)) === 'website',
  );
  await ed.ev(`document.activeElement?.blur()`);
  await key('Delete', 'Delete', { vk: 46 });
  await sleep(200);
  check(
    'Delete removes the panel and its cursor',
    (await state(
      `s.project.objects.filter(o => o.kind === 'website').length === 1 && s.project.objects.filter(o => o.kind === 'cursor').length === 1`,
    )) === true,
  );
  await ed.ev(
    `window.__looitEditor.setState({ selectedId: window.__looitEditor.getState().project.objects.find(o => o.kind === 'website').id })`,
  );
  await key('Delete', 'Delete', { vk: 46 });
  await sleep(200);
  check(
    'the last website panel cannot be deleted',
    (await state(`s.project.objects.filter(o => o.kind === 'website').length`)) === 1,
  );

  // 15b. Camera, presets and environment.
  const clickText = (sel, text) =>
    ed.ev(
      `[...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`,
    );
  await ed.ev(`window.__looitEditor.setState({ time: 1 })`);
  await ed.ev(`[...document.querySelectorAll('.tree-row')].find(r => r.textContent.includes('Camera')).click()`);
  await sleep(100);
  check(
    'the camera can be selected',
    (await state(`s.project.objects.find(o => o.id === s.selectedId)?.kind`)) === 'camera',
  );
  await clickText('.tabs button', 'Animation');
  await sleep(100);
  await clickText('.preset-grid button', 'Zoom in');
  await sleep(100);
  check(
    'the Zoom in preset keyframes the camera zoom from the playhead',
    JSON.stringify(
      await state(
        `s.project.objects.find(o => o.kind === 'camera').zoom.keyframes.map(k => [k.time, +k.value.toFixed(2)])`,
      ),
    ) ===
      JSON.stringify([
        [1, 1],
        [2, 1.5],
      ]),
  );
  await ed.ev(
    `window.__looitEditor.setState({ selectedId: window.__looitEditor.getState().project.objects.find(o => o.kind === 'website').id })`,
  );
  await sleep(100);
  await clickText('.preset-grid button', 'Fade in');
  await sleep(100);
  check(
    'the Fade in preset fades the panel in',
    JSON.stringify(await state(`W.transform.opacity.keyframes.map(k => k.value)`)) === '[0,1]',
  );
  await clickText('.tabs button', 'Properties');
  await ed.ev(`window.__looitEditor.setState({ selectedId: null })`);
  await sleep(100);
  await ed.ev(`(() => {
    const sel = [...document.querySelectorAll('.inspector select')].find(x => [...x.options].some(o => o.value === 'reflection'));
    sel.value = 'reflection';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  check('the floor can be turned on', (await state(`s.project.environment?.floor`)) === 'reflection');
  await ed.ev(`(() => {
    const sel = [...document.querySelectorAll('.inspector select')].find(x => [...x.options].some(o => o.value === 'gradient'));
    sel.value = 'gradient';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  check('the background can be a gradient', (await state(`s.project.environment?.background`)) === 'gradient');
  const shot = await ed.send('Page.captureScreenshot', { format: 'png' });
  if (shot.data) {
    const fsm = await import('node:fs');
    fsm.mkdirSync('selftest-out', { recursive: true });
    fsm.writeFileSync('selftest-out/ui-environment.png', Buffer.from(shot.data, 'base64'));
  }

  // 16. Undo history works across all of this.
  const n = await state('s.past.length');
  check('edits are recorded for undo', n >= 5, `${n} steps`);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='electron.exe'\\" | Where-Object { $_.CommandLine -like '*remote-debugging-port=${PORT}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
    );
  } catch {}
  app.kill();
  console.log(failures ? `${failures} check(s) failed` : 'All UI checks passed');
  process.exit(failures ? 1 : 0);
}
