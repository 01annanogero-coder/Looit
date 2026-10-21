import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type {
  AiConnectionInfo,
  AiResponse,
  ExportBeginOptions,
  PageInput,
  PreviewAdvance,
  PreviewTarget,
  SelfTestConfig,
  TimedInput,
} from '../shared/ipc';
import { SPECIAL_KEYS } from '../engine/project';
import { parseProject } from '../engine/schema';
import { RendererRpc } from './ai/renderer-rpc';
import { AiService, Studio } from './ai/service';
import { aiAccessEnabled, setAiAccessEnabled } from './ai/settings';
import { Library } from './library';
import { runBridge } from './mcp/bridge';
import { isAllowedSiteUrl, WebsiteHost } from './website';

// Self-test mode (development only): runs an export of a local test page
// without user interaction and writes diagnostics to LOOIT_SELFTEST_OUT.
const selfTestOut = !app.isPackaged ? process.env.LOOIT_SELFTEST_OUT : undefined;

// Deterministic rendering: paint completely before each frame, keep animations
// and scrolling on the main thread (where they can be frozen and stepped), and
// make scrolling instant rather than a real-time smooth animation.
function appendRenderingSwitches(): void {
  app.commandLine.appendSwitch('run-all-compositor-stages-before-draw');
  app.commandLine.appendSwitch('disable-threaded-animation');
  app.commandLine.appendSwitch('disable-checker-imaging');
  app.commandLine.appendSwitch('disable-smooth-scrolling');
}

let editor: BrowserWindow | null = null;
let website: WebsiteHost | null = null;
let projectDirty = false;
/** Project paths the user picked in an open/save dialog; saving is only allowed to these. */
const approvedProjectPaths = new Set<string>();
const MAX_PROJECT_BYTES = 20 * 1024 * 1024;
/** Background images are embedded in the project (as base64), so keep them modest. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

let libraryInstance: Library | null = null;
/** The onboarding project library: files in the user's home folder, never in a synced OneDrive folder. */
function library(): Library {
  // Development only: automated tests of the onboarding screen use a scratch folder.
  const testDir = !app.isPackaged ? process.env.LOOIT_LIBRARY_DIR : undefined;
  libraryInstance ??= new Library({
    indexFile: testDir ? path.join(testDir, 'projects.json') : path.join(app.getPath('userData'), 'projects.json'),
    folder: testDir ?? path.join(app.getPath('home'), 'Looit Projects'),
    trash: (file) => shell.trashItem(file),
  });
  return libraryInstance;
}
let exportFileCounter = 0;
const exportFiles = new Map<number, { handle: FileHandle; temp: string; target: string; owner: Workspace['kind'] }>();
/** Videos the AI Studio exported, playable in its window as looit-media://video/<token>. */
const studioVideos = new Map<string, string>();

/** The AI's own window, project and website pages. */
const studio = new Studio((s) => createStudioWindow(s));
const editorRpc = new RendererRpc(() => editor?.webContents ?? null);

/** A window that talks to the main process: the user's editor, or the AI Studio. */
interface Workspace {
  kind: 'editor' | 'studio';
  window: BrowserWindow;
  website: WebsiteHost;
  rpc: RendererRpc;
}

function workspaceOf(event: IpcMainEvent | IpcMainInvokeEvent): Workspace | null {
  const isMainFrame = (w: BrowserWindow | null) =>
    !!w && !w.isDestroyed() && event.sender === w.webContents && event.senderFrame === w.webContents.mainFrame;
  if (isMainFrame(editor) && website) return { kind: 'editor', window: editor!, website, rpc: editorRpc };
  if (isMainFrame(studio.win) && studio.website)
    return { kind: 'studio', window: studio.win!, website: studio.website, rpc: studio.rpc };
  return null;
}

/** Which windows may use a channel. The studio never reaches the user's project, files or settings. */
type Allowed = 'editor' | 'studio' | 'both';

function allowed(ws: Workspace | null, who: Allowed): ws is Workspace {
  return !!ws && (who === 'both' || ws.kind === who);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validInputs(v: unknown): v is PageInput[] {
  return (
    Array.isArray(v) &&
    v.length <= 256 &&
    v.every((e) => {
      if (!e || typeof e !== 'object') return false;
      if (e.type === 'text') return typeof e.text === 'string' && e.text.length > 0 && e.text.length <= 64;
      if (e.type === 'key') return (SPECIAL_KEYS as readonly unknown[]).includes(e.key);
      return (
        ['move', 'down', 'up', 'click', 'wheel'].includes(e.type) &&
        isFiniteNumber(e.x) &&
        isFiniteNumber(e.y) &&
        (e.type !== 'wheel' || isFiniteNumber(e.deltaY))
      );
    })
  );
}

/** Object ids come from validated projects; keep them short and plain. */
function validId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 100;
}

function validTimedInputs(v: unknown, max: number): v is TimedInput[] {
  return (
    Array.isArray(v) &&
    v.length <= max &&
    v.every((e) => e && isFiniteNumber(e.time) && e.time >= 0 && validInputs([e.input]))
  );
}

function validViewport(v: unknown): v is { width: number; height: number } {
  const o = v as { width?: unknown; height?: unknown } | null;
  return (
    !!o &&
    Number.isInteger(o.width) &&
    Number.isInteger(o.height) &&
    (o.width as number) >= 320 &&
    (o.width as number) <= 3840 &&
    (o.height as number) >= 240 &&
    (o.height as number) <= 2160
  );
}

function handle<A extends unknown[], R>(
  channel: string,
  fn: (ws: Workspace, ...args: A) => R,
  who: Allowed = 'editor',
) {
  ipcMain.handle(channel, (event, ...args) => {
    const ws = workspaceOf(event);
    if (!allowed(ws, who)) throw new Error('Rejected IPC from unknown sender.');
    return fn(ws, ...(args as A));
  });
}

function on<A extends unknown[]>(channel: string, fn: (ws: Workspace, ...args: A) => void, who: Allowed = 'editor') {
  ipcMain.on(channel, (event, ...args) => {
    const ws = workspaceOf(event);
    if (allowed(ws, who)) fn(ws, ...(args as A));
  });
}

function registerIpc(): void {
  // ---- Website previews: each window has its own pages ----
  on(
    'site:sync',
    (ws, target: unknown) => {
      const t = target as PreviewTarget | null;
      if (
        t &&
        validId(t.websiteId) &&
        typeof t.url === 'string' &&
        isAllowedSiteUrl(t.url, !!selfTestOut && ws.kind === 'editor') &&
        validViewport(t.viewport) &&
        isFiniteNumber(t.time) &&
        t.time >= 0 &&
        validTimedInputs(t.events, 50_000) &&
        (t.hover === null || (isFiniteNumber(t.hover?.x) && isFiniteNumber(t.hover?.y)))
      )
        ws.website.sync(t);
    },
    'both',
  );
  on(
    'site:advance',
    (ws, step: unknown) => {
      const s = step as PreviewAdvance | null;
      if (s && validId(s.websiteId) && isFiniteNumber(s.time) && s.time >= 0 && validTimedInputs(s.inputs, 200)) {
        ws.website.advance(s);
      }
    },
    'both',
  );
  on(
    'site:keep',
    (ws, ids: unknown) => {
      if (Array.isArray(ids) && ids.length <= 64 && ids.every(validId)) ws.website.keep(ids);
    },
    'both',
  );
  // Interact mode (the user's own input) exists only in the editor.
  on('site:interactive', (ws, on: unknown) => ws.website.setInteractive(on === true));
  handle('site:scroll-since-interact', (ws, id: unknown) => {
    if (!validId(id)) throw new Error('Invalid website.');
    return ws.website.scrollSinceInteract(id);
  });
  on('site:input', (ws, id: unknown, events: unknown) => {
    if (validId(id) && validInputs(events)) ws.website.input(id, events);
  });
  on(
    'site:ack',
    (ws, id: unknown) => {
      if (validId(id)) ws.website.ackFrame(id);
    },
    'both',
  );
  on('site:refresh', (ws) => ws.website.refresh(), 'both');
  handle('studio:settle', (ws) => ws.website.settle(), 'studio');

  // ---- Export ----
  handle(
    'export:begin',
    (ws, opts: ExportBeginOptions) => {
      if (
        !opts ||
        typeof opts.project !== 'string' ||
        opts.project.length > MAX_PROJECT_BYTES ||
        !isFiniteNumber(opts.settleMs)
      )
        throw new Error('Invalid export options.');
      // The main process renders from the validated project, never from loose values.
      const project = parseProject(opts.project, { allowFileUrls: !!selfTestOut && ws.kind === 'editor' });
      return ws.website.beginExport(project, Math.min(Math.max(opts.settleMs, 0), 30_000), opts.diagnostics === true);
    },
    'both',
  );
  handle(
    'export:frame',
    (ws, id: unknown, n: unknown) => {
      if (!validId(id) || !Number.isSafeInteger(n) || (n as number) < 0) throw new Error('Invalid frame.');
      return ws.website.exportFrame(id, n as number);
    },
    'both',
  );
  handle('export:end', (ws) => ws.website.endExport(), 'both');
  // Exports stream into a file the user picked up front, so long videos never
  // have to fit in memory and a failed export can't lose an existing file.
  handle(
    'export:create-file',
    async (ws, suggestedName: unknown) => {
      if (typeof suggestedName !== 'string') throw new Error('Invalid file name.');
      const safeName = suggestedName.replace(/[<>:"/\\|?*]/g, '_').trim() || 'video';
      let target: string;
      // Development only: automated tests of the AI connection export without a dialog.
      const aiTestDir = ws.kind === 'studio' && !app.isPackaged ? process.env.LOOIT_AI_TEST_EXPORT_DIR : undefined;
      // Development only: the same for editor exports (end-to-end tests of the Export button).
      const editorTestDir = ws.kind === 'editor' && !app.isPackaged ? process.env.LOOIT_TEST_EXPORT_DIR : undefined;
      if (aiTestDir) {
        await fs.mkdir(aiTestDir, { recursive: true });
        target = path.join(aiTestDir, `${safeName}.mp4`);
      } else if (editorTestDir) {
        await fs.mkdir(editorTestDir, { recursive: true });
        target = path.join(editorTestDir, `${safeName}.mp4`);
      } else if (selfTestOut && ws.kind === 'editor') {
        await fs.mkdir(selfTestOut, { recursive: true });
        target = path.join(selfTestOut, 'export.mp4');
      } else {
        // The user always decides where a video goes, also when an AI asked for it.
        if (ws.kind === 'studio') ws.window.show();
        const result = await dialog.showSaveDialog(ws.window, {
          ...(ws.kind === 'studio' ? { title: 'Save the video made by AI' } : {}),
          defaultPath: path.join(app.getPath('videos'), `${safeName}.mp4`),
          filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
        });
        if (result.canceled || !result.filePath) return null;
        target = result.filePath;
      }
      // Write to a temporary file; it replaces the target only when complete.
      const temp = `${target}.looit-partial`;
      const id = ++exportFileCounter;
      exportFiles.set(id, { handle: await fs.open(temp, 'w'), temp, target, owner: ws.kind });
      return { id, path: target };
    },
    'both',
  );
  handle(
    'export:write',
    async (ws, id: unknown, position: unknown, data: unknown) => {
      const file = exportFiles.get(id as number);
      if (
        !file ||
        file.owner !== ws.kind ||
        !Number.isSafeInteger(position) ||
        (position as number) < 0 ||
        !(data instanceof Uint8Array)
      )
        throw new Error('Invalid export write.');
      await file.handle.write(data, 0, data.byteLength, position as number);
    },
    'both',
  );
  handle(
    'export:close-file',
    async (ws, id: unknown, keep: unknown): Promise<string | null> => {
      const file = exportFiles.get(id as number);
      if (!file || file.owner !== ws.kind) return null;
      exportFiles.delete(id as number);
      await file.handle.close();
      if (keep !== true) {
        await fs.rm(file.temp, { force: true });
        return null;
      }
      await fs.rename(file.temp, file.target);
      if (ws.kind !== 'studio') return null;
      // The studio plays the finished video; only files it exported can be served.
      const token = randomUUID();
      studioVideos.set(token, file.target);
      return `looit-media://video/${token}`;
    },
    'both',
  );

  // ---- The user's project files (editor only) ----
  handle('project:open', async (ws) => {
    const result = await dialog.showOpenDialog(ws.window, {
      filters: [{ name: 'Looit project', extensions: ['looit'] }],
      properties: ['openFile'],
    });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    const { size } = await fs.stat(file);
    if (size > MAX_PROJECT_BYTES) throw new Error('This file is too large to be a Looit project.');
    approvedProjectPaths.add(file);
    return { path: file, text: await fs.readFile(file, 'utf8') };
  });
  handle('project:pick-image', async (ws) => {
    const result = await dialog.showOpenDialog(ws.window, {
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile'],
    });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    const { size } = await fs.stat(file);
    if (size > MAX_IMAGE_BYTES) throw new Error('Background images can be up to 8 MB.');
    const data = await fs.readFile(file);
    // Trust the file's contents, not its extension.
    const type =
      data[0] === 0x89 && data.toString('latin1', 1, 4) === 'PNG'
        ? 'png'
        : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
          ? 'jpeg'
          : data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP'
            ? 'webp'
            : null;
    if (!type) throw new Error('That file is not a PNG, JPEG or WebP image.');
    return `data:image/${type};base64,${data.toString('base64')}`;
  });
  handle('project:save', async (ws, text: unknown, file: unknown, suggestedName: unknown) => {
    if (typeof text !== 'string' || text.length > MAX_PROJECT_BYTES || typeof suggestedName !== 'string')
      throw new Error('Invalid project.');
    let target = typeof file === 'string' && approvedProjectPaths.has(file) ? file : null;
    if (!target) {
      const safeName = suggestedName.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Untitled project';
      const result = await dialog.showSaveDialog(ws.window, {
        defaultPath: path.join(app.getPath('documents'), `${safeName}.looit`),
        filters: [{ name: 'Looit project', extensions: ['looit'] }],
      });
      if (result.canceled || !result.filePath) return null;
      target = result.filePath;
      approvedProjectPaths.add(target);
    }
    // Write to a temp file first so a crash can't leave a half-written project.
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, target);
    return target;
  });
  on('project:dirty', (_ws, dirty: unknown) => {
    projectDirty = dirty === true;
  });

  // ---- The onboarding project library (editor only) ----
  handle('library:list', () => library().snapshot());
  handle('library:create', async (_ws, name: unknown) => {
    if (typeof name !== 'string' || name.length > 200) throw new Error('Invalid project name.');
    const opened = await library().create(name);
    approvedProjectPaths.add(opened.entry.path);
    return opened;
  });
  handle('library:demo', async () => {
    const opened = await library().demo();
    approvedProjectPaths.add(opened.entry.path);
    return opened;
  });
  handle('library:open', async (_ws, id: unknown) => {
    if (!validId(id)) throw new Error('Invalid project id.');
    const opened = await library().open(id);
    if (opened) approvedProjectPaths.add(opened.entry.path);
    return opened;
  });
  handle('library:add', async (_ws, file: unknown, name: unknown) => {
    if (typeof file !== 'string' || file.length > 4096) throw new Error('Invalid file path.');
    if (!file.toLowerCase().endsWith('.looit')) throw new Error('That is not a .looit project.');
    const entry = await library().add(file, typeof name === 'string' ? name : path.basename(file, '.looit'));
    approvedProjectPaths.add(entry.path);
    return entry;
  });
  handle('library:rename', async (_ws, id: unknown, name: unknown) => {
    if (!validId(id) || typeof name !== 'string' || name.length > 200) throw new Error('Invalid rename.');
    const entry = await library().rename(id, name);
    approvedProjectPaths.add(entry.path);
    return entry;
  });
  handle('library:set-pinned', async (_ws, id: unknown, pinned: unknown) => {
    if (!validId(id) || typeof pinned !== 'boolean') throw new Error('Invalid pin request.');
    await library().setPinned(id, pinned);
  });
  handle('library:remove', async (_ws, id: unknown) => {
    if (!validId(id)) throw new Error('Invalid project id.');
    await library().remove(id);
  });
  handle('library:share', async (ws, id: unknown) => {
    if (!validId(id)) throw new Error('Invalid project id.');
    const entry = await library().entry(id);
    const result = await dialog.showSaveDialog(ws.window, {
      title: 'Share a copy of the project',
      defaultPath: path.join(app.getPath('downloads'), `${entry.name}.looit`),
      filters: [{ name: 'Looit project', extensions: ['looit'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return library().copyTo(id, result.filePath);
  });
  handle('library:note-saved', async (_ws, file: unknown, name: unknown) => {
    if (typeof file !== 'string' || typeof name !== 'string') return;
    await library().noteSaved(file, name);
  });
  handle('library:reveal', async (_ws, id: unknown) => {
    if (!validId(id)) throw new Error('Invalid project id.');
    const entry = await library().entry(id);
    if (entry.exists) shell.showItemInFolder(entry.path);
  });

  // ---- Self-test (development, editor only) ----
  handle('selftest:config', async (): Promise<SelfTestConfig | null> => {
    if (!selfTestOut) return null;
    // LOOIT_SELFTEST_PAGE=<name> uses test-pages/<name>.html (default: clock).
    const requested = process.env.LOOIT_SELFTEST_PAGE ?? '';
    const pageName = /^[a-z-]+$/.test(requested) ? `${requested}.html` : 'clock.html';
    const page = path.join(app.getAppPath(), 'test-pages', pageName);
    // LOOIT_SELFTEST_OUTPUT=1920x1080@60 tests other export settings.
    const m = /^(\d+)x(\d+)@(30|60)$/.exec(process.env.LOOIT_SELFTEST_OUTPUT ?? '');
    return {
      // LOOIT_SELFTEST_URL=https://... times an export of a real website.
      url: process.env.LOOIT_SELFTEST_URL?.startsWith('https://')
        ? process.env.LOOIT_SELFTEST_URL
        : pathToFileURL(page).href,
      dumpFrames: process.env.LOOIT_SELFTEST_DUMP === '1',
      secondUrl: process.env.LOOIT_SELFTEST_SECOND_URL?.startsWith('https://')
        ? process.env.LOOIT_SELFTEST_SECOND_URL
        : null,
      lean: process.env.LOOIT_SELFTEST_LEAN === '1',
      projectText: process.env.LOOIT_SELFTEST_PROJECT?.endsWith('.looit')
        ? await fs.readFile(process.env.LOOIT_SELFTEST_PROJECT, 'utf8')
        : null,
      environment:
        process.env.LOOIT_SELFTEST_ENV === 'image'
          ? 'image'
          : process.env.LOOIT_SELFTEST_ENV === '1'
            ? 'gradient'
            : null,
      frames: (process.env.LOOIT_SELFTEST_FRAMES ?? '')
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0),
      width: m ? Number(m[1]) : 1280,
      height: m ? Number(m[2]) : 720,
      fps: m ? Number(m[3]) : 30,
    };
  });
  handle('selftest:write', async (_ws, name: unknown, data: unknown) => {
    if (!selfTestOut || typeof name !== 'string') return;
    if (!(data instanceof Uint8Array) && typeof data !== 'string') return;
    await fs.mkdir(selfTestOut, { recursive: true });
    await fs.writeFile(path.join(selfTestOut, path.basename(name)), data);
  });
  on('selftest:finish', (_ws, ok: unknown) => {
    if (selfTestOut) app.exit(ok ? 0 : 1);
  });

  // ---- AI connection ----
  on('ai:ready', (ws) => ws.rpc.markReady(), 'both');
  on(
    'ai:response',
    (ws, msg: unknown) => {
      const m = msg as AiResponse | null;
      if (m && Number.isSafeInteger(m.id)) ws.rpc.resolve(m);
    },
    'both',
  );
  handle('ai:connection', () => aiConnectionInfo());
  handle('ai:set-enabled', (_ws, enabled: unknown) => setAiAccessEnabled(enabled === true));
  handle('ai:show-config', async (_ws, file: unknown) => {
    const known = (await aiConnectionInfo()).configs.find((c) => c.path === file);
    if (!known) throw new Error('Unknown file.');
    if (known.exists) {
      shell.showItemInFolder(known.path);
      return;
    }
    const folder = path.dirname(known.path);
    await fs.mkdir(folder, { recursive: true });
    await shell.openPath(folder);
  });
}

/** What the user adds to their AI app's config to connect it to Looit. */
async function aiConnectionInfo(): Promise<AiConnectionInfo> {
  // Microsoft Store (MSIX) installs are started through their app execution alias,
  // other installs by their executable, development builds as Electron + the app folder.
  const localAppData = process.env.LOCALAPPDATA ?? path.join(app.getPath('home'), 'AppData', 'Local');
  const command =
    app.isPackaged && process.windowsStore
      ? path.join(localAppData, 'Microsoft', 'WindowsApps', 'Looit.exe')
      : process.execPath;
  const args = app.isPackaged ? ['--mcp'] : [app.getAppPath(), '--mcp'];
  const snippet = JSON.stringify({ mcpServers: { looit: { command, args } } }, null, 2);
  const candidates = [
    {
      label: 'Claude Desktop from the Microsoft Store',
      path: path.join(
        localAppData,
        'Packages',
        'Claude_pzs8sxrjxfjjc',
        'LocalCache',
        'Roaming',
        'Claude',
        'claude_desktop_config.json',
      ),
    },
    {
      label: 'Claude Desktop from claude.ai',
      path: path.join(app.getPath('appData'), 'Claude', 'claude_desktop_config.json'),
    },
  ];
  const exists = (p: string) =>
    fs.access(p).then(
      () => true,
      () => false,
    );
  return {
    enabled: aiAccessEnabled(),
    snippet,
    configs: await Promise.all(candidates.map(async (c) => ({ ...c, exists: await exists(c.path) }))),
    development: !app.isPackaged,
  };
}

/** Serves a video the AI Studio exported to its <video> player, with seeking (byte ranges). */
async function serveStudioVideo(request: Request): Promise<Response> {
  const token = new URL(request.url).pathname.replace(/^\//, '');
  const file = studioVideos.get(token);
  if (!file) return new Response('Not found', { status: 404 });
  const { size } = await fs.stat(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else start = Math.max(0, size - Number(range[2]));
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
  }
  const partial = !!range && (!!range[1] || !!range[2]);
  const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream;
  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: partial ? 206 : 200, headers });
}

function loadRenderer(win: BrowserWindow, hash?: string): void {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(hash ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${hash}` : MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), hash ? { hash } : {});
  }
}

/** The app's windows never navigate away or open windows; https links go to the browser. */
function lockNavigation(win: BrowserWindow): void {
  // Reloading the page itself is allowed (the dev server reloads it after updates).
  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const current = new URL(win.webContents.getURL());
    const sameDocument =
      target.protocol === current.protocol && target.host === current.host && target.pathname === current.pathname;
    if (!sameDocument) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** The AI Studio: shows the AI's project; the user watches but has no controls in it. */
function createStudioWindow(s: Studio): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    title: 'Looit · AI Studio',
    backgroundColor: '#14161c',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  lockNavigation(win);
  s.website = new WebsiteHost(
    {
      frame: (frame) => win.webContents.send('site:frame', frame),
      status: (status) => win.webContents.send('site:status', status),
    },
    false,
  );
  win.webContents.on('did-start-loading', () => s.rpc.reset());
  win.webContents.on('render-process-gone', () => s.rpc.reset());
  win.on('closed', () => s.closed());
  loadRenderer(win, 'studio');
  return win;
}

function createEditor(): void {
  editor = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Looit',
    backgroundColor: '#14161c',
    show: !selfTestOut,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  editor.setMenuBarVisibility(false);
  lockNavigation(editor);
  editor.webContents.on('did-start-loading', () => editorRpc.reset());

  website = new WebsiteHost(
    {
      frame: (frame) => editor?.webContents.send('site:frame', frame),
      status: (status) => editor?.webContents.send('site:status', status),
    },
    !!selfTestOut,
  );

  loadRenderer(editor);

  editor.webContents.on('render-process-gone', (_e, details) => {
    console.error(`Editor renderer gone: ${details.reason} (exit ${details.exitCode})`);
    if (selfTestOut) app.exit(2);
  });

  editor.on('close', (event) => {
    if (!projectDirty || selfTestOut) return;
    const choice = dialog.showMessageBoxSync(editor!, {
      type: 'warning',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail: 'If you close now, your changes since the last save will be lost.',
    });
    if (choice === 1) event.preventDefault();
  });

  editor.on('closed', () => {
    editor = null;
    editorRpc.reset();
    website?.destroy();
    website = null;
    // The AI Studio belongs to this session of the app.
    studio.win?.close();
  });
}

function startApp(): void {
  appendRenderingSwitches();
  protocol.registerSchemesAsPrivileged([
    { scheme: 'looit-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ]);
  app.whenReady().then(() => {
    if (selfTestOut) {
      setTimeout(() => {
        console.error('Self-test timed out.');
        app.exit(3);
      }, 180_000);
    }
    protocol.handle('looit-media', serveStudioVideo);
    registerIpc();
    createEditor();
    // AI apps reach Looit through the MCP bridge (`Looit --mcp`) over a named pipe.
    if (!selfTestOut) new AiService(studio, () => (editor ? editorRpc : null)).listen();
  });
  app.on('window-all-closed', () => app.quit());
}

// `Looit --mcp` is started by an AI app (Claude Desktop): it only relays MCP to the running app.
if (process.argv.includes('--mcp')) runBridge();
else startApp();
