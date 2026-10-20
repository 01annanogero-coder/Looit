// End-to-end test of the AI connection: starts Looit, then talks MCP to the
// bridge (`Looit --mcp`) exactly like Claude Desktop would, and uses every tool.
//   node scripts/mcp-test.mjs
// Exports and saves go to selftest-out/mcp (no dialogs); AI access is enabled
// for this run only (development switch), not in the saved settings.
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MARK = '--looit-mcp-test';
const out = path.resolve('selftest-out', 'mcp');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const env = { ...process.env, LOOIT_AI_TEST_ENABLE: '1', LOOIT_AI_TEST_EXPORT_DIR: out, LOOIT_AI_TEST_SAVE_DIR: out };
delete env.ELECTRON_RUN_AS_NODE;

const DEBUG_PORT = 9351;
const app = spawn('npx', ['electron-forge', 'start', '--', MARK, `--remote-debugging-port=${DEBUG_PORT}`], {
  shell: true,
  env,
  stdio: 'ignore',
});
const user =
  os
    .userInfo()
    .username.replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 40) || 'user';
const pipe = `\\\\.\\pipe\\looit-ai-${user}`;

async function waitForPipe() {
  for (let i = 0; i < 240; i++) {
    const ok = await new Promise((r) => {
      const s = net.connect(pipe);
      s.once('connect', () => (s.destroy(), r(true)));
      s.once('error', () => r(false));
    });
    if (ok) return;
    await sleep(500);
  }
  throw new Error('Looit did not start listening for AI apps');
}

/** A minimal MCP client over the bridge's stdio. */
function startBridge() {
  const electron = path.resolve('node_modules', 'electron', 'dist', 'electron.exe');
  const bridge = spawn(electron, [path.resolve('.'), '--mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const request = (method, params = {}, timeoutMs = 180_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params = {}) => bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const tool = async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result;
  return { bridge, request, notify, tool };
}

/** Saves a screenshot of the app window whose address matches `match` (DevTools protocol). */
async function screenshotWindow(match, file, prepare) {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
  const target = targets.find((t) => t.type === 'page' && match(t.url));
  if (!target) return false;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const my = ++id;
      ws.addEventListener('message', function onMsg(e) {
        const m = JSON.parse(e.data);
        if (m.id === my) {
          ws.removeEventListener('message', onMsg);
          resolve(m.result);
        }
      });
      ws.send(JSON.stringify({ id: my, method, params }));
    });
  if (prepare) await send('Runtime.evaluate', { expression: prepare, awaitPromise: true });
  await sleep(800);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  ws.close();
  writeFileSync(path.join(out, file), Buffer.from(shot.data, 'base64'));
  return true;
}

const text = (r) => r?.content?.find((c) => c.type === 'text')?.text ?? '';
const jsonAfterFirstLine = (t) => JSON.parse(t.slice(t.indexOf('\n') + 1));

let mcp;
try {
  await waitForPipe();
  mcp = startBridge();

  // 1. Handshake and tool list.
  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'looit-mcp-test', version: '1' },
  });
  check(
    'initialize answers as Looit with instructions',
    init.result?.serverInfo?.name === 'looit' &&
      init.result.protocolVersion === '2025-06-18' &&
      /looit_guide/.test(init.result.instructions ?? ''),
  );
  mcp.notify('notifications/initialized');
  const list = await mcp.request('tools/list');
  const names = list.result?.tools?.map((t) => t.name) ?? [];
  check('tools/list has the 12 tools', names.length === 12, names.join(', '));
  check('looit_guide returns the guide', /# Looit guide/.test(text(await mcp.tool('looit_guide'))));

  // 2. The user's editor project: readable, and it must stay exactly as it is.
  const userBefore = text(await mcp.tool('read_user_project'));
  check(
    'read_user_project returns the editor project (read-only)',
    /read-only/.test(userBefore) && /"looit-project"/.test(userBefore),
  );

  // 3. A studio project.
  const created = await mcp.tool('new_project', { url: 'https://example.com/', duration: 6, name: 'MCP test' });
  check(
    'new_project starts a studio project',
    !created.isError && /Studio project ready/.test(text(created)),
    text(created).split('\n')[0],
  );
  const found = jsonAfterFirstLine(text(await mcp.tool('inspect_page', { time: 0, query: 'learn more' })));
  const below = found.elements?.[0];
  check(
    'inspect_page finds an element by text with its page position',
    !!below && below.pageY > 0,
    JSON.stringify(below),
  );

  // 4. Edit: scroll so the link is in view, then move to it and click.
  const project = JSON.parse(text(await mcp.tool('get_project')));
  const cursor = project.objects.find((o) => o.kind === 'cursor');
  cursor.position = { value: [640, 400], keyframes: [] };
  cursor.scrolls = [{ id: 's1', time: 0.5, deltaY: 300 }];
  await mcp.tool('set_project', { project });
  const scrolled = jsonAfterFirstLine(text(await mcp.tool('inspect_page', { time: 1.5, query: 'learn more' })));
  const link = scrolled.elements?.[0];
  check(
    'after the scroll the link is in view, with cursor coordinates',
    scrolled.scrollY > 0 && !!link && link.inView,
    `scrollY ${scrolled.scrollY}, link ${JSON.stringify(link)}`,
  );
  cursor.position = {
    value: [640, 400],
    keyframes: [
      { id: 'm1', time: 1.5, value: [640, 400], easing: 'easeInOut' },
      { id: 'm2', time: 2.5, value: [link.x, link.y] },
    ],
  };
  cursor.clicks = [{ id: 'c1', time: 3 }];
  const bad = structuredClone(project);
  bad.objects.find((o) => o.kind === 'cursor').clicks[0].time = -1;
  const rejected = await mcp.tool('set_project', { project: bad });
  check(
    'set_project rejects an invalid project and names the field',
    rejected.isError && /clicks\[0\]\.time/.test(text(rejected)),
    text(rejected),
  );
  const updated = await mcp.tool('set_project', { project });
  check('set_project accepts the edited project', !updated.isError, text(updated).split('\n')[0]);
  const site = project.objects.find((o) => o.kind === 'website');
  const preset = await mcp.tool('apply_preset', { object_id: site.id, preset: 'fadeIn', start: 0, length: 0.5 });
  check('apply_preset adds a fade-in', !preset.isError, text(preset));

  const after = jsonAfterFirstLine(text(await mcp.tool('inspect_page', { time: 5 })));
  check('the click opened the linked page', !/^https:\/\/example\.com\/?$/.test(after.url), after.url);

  // 5. Looking.
  const shot = await mcp.tool('screenshot', { time: 2.6 });
  const img = shot.content?.find((c) => c.type === 'image');
  if (img) writeFileSync(path.join(out, 'scene.jpg'), Buffer.from(img.data, 'base64'));
  check('screenshot returns the scene as an image', img?.mimeType === 'image/jpeg' && img.data.length > 10_000);
  const pageShot = await mcp.tool('screenshot', { time: 2.6, target: 'website' });
  const pageImg = pageShot.content?.find((c) => c.type === 'image');
  if (pageImg) writeFileSync(path.join(out, 'website.png'), Buffer.from(pageImg.data, 'base64'));
  check('screenshot of the website alone', pageImg?.mimeType === 'image/png');
  check('preview plays for the user', !(await mcp.tool('preview', { time: 0, play: true })).isError);

  // 6. Export and save (dialogs skipped in this test; the files land in selftest-out/mcp).
  const started = await mcp.tool('export_video', { file_name: 'mcp-test' });
  check('export_video starts', !started.isError, text(started));
  let status;
  for (let i = 0; i < 10; i++) {
    status = JSON.parse(text(await mcp.tool('get_status', { wait_seconds: 50 })));
    if (!['choosing', 'exporting'].includes(status.export.phase)) break;
  }
  const video = path.join(out, 'mcp-test.mp4');
  check(
    'the export finishes and the MP4 exists',
    status.export.phase === 'done' && existsSync(video) && statSync(video).size > 20_000,
    `${status.export.phase} ${status.export.path ?? status.export.error ?? ''}`,
  );
  await mcp.tool('save_project', { file_name: 'mcp-test' });
  for (let i = 0; i < 10 && status.save.phase !== 'saved'; i++) {
    status = JSON.parse(text(await mcp.tool('get_status', { wait_seconds: 5 })));
  }
  const saved = path.join(out, 'mcp-test.looit');
  check(
    'save_project writes the project',
    status.save.phase === 'saved' && existsSync(saved) && JSON.parse(readFileSync(saved, 'utf8')).name === 'MCP test',
  );

  // Pictures of the two new windows, for a visual check (not pass/fail).
  await screenshotWindow((u) => u.includes('#studio'), 'studio.png');
  await screenshotWindow(
    (u) => u.startsWith('http://localhost') && !u.includes('#studio'),
    'connect-dialog.png',
    `(() => { [...document.querySelectorAll('.menu-btn')].find((b) => b.textContent === 'Help').click();
      return new Promise((r) => setTimeout(() => { [...document.querySelectorAll('.menu-list button')].find((b) => b.textContent.includes('Connect')).click(); r(); }, 200)); })()`,
  );

  // 7. The user's work is untouched.
  const userAfter = text(await mcp.tool('read_user_project'));
  check("the user's editor project did not change", userAfter === userBefore);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  mcp?.bridge.stdin.end();
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='electron.exe'\\" | Where-Object { $_.CommandLine -like '*${MARK}*' -or $_.CommandLine -like '*--mcp*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
    );
  } catch {}
  app.kill();
  console.log(failures ? `${failures} check(s) failed` : 'All MCP checks passed');
  process.exit(failures ? 1 : 0);
}
