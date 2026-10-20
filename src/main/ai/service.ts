// Carries out the MCP tools for AI apps. The AI works only in the AI Studio (a
// separate window with its own project and website pages). The user's editor
// is only ever read, and files are only written where the user chooses.

import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import type { StudioStatus } from '../../shared/ipc';
import { applyCameraPreset, applyObjectPreset, CAMERA_PRESETS, OBJECT_PRESETS } from '../../engine/presets';
import {
  hasTransform,
  newProject,
  websites,
  type CameraObject,
  type CursorObject,
  type Project,
  type SceneObject,
} from '../../engine/project';
import { MAX_DURATION, parseProject, serializeProject } from '../../engine/schema';
import { IMAGE_PLACEHOLDER } from '../mcp/guide';
import type { ToolResult } from '../mcp/bridge';
import { isAllowedSiteUrl, type WebsiteHost } from '../website';
import { aiPipePath, readLines, type PipeRequest, type PipeResponse } from './pipe';
import { RendererRpc } from './renderer-rpc';
import { aiAccessEnabled } from './settings';

const ACCESS_OFF =
  "Looit's AI access is turned off. Ask the user to open Looit and turn it on in Help → Connect an AI app, then try again.";
const NO_STUDIO = 'There is no studio project yet. Call new_project first.';

/** The AI Studio window: its own renderer, project and website pages. */
export class Studio {
  win: BrowserWindow | null = null;
  website: WebsiteHost | null = null;
  readonly rpc = new RendererRpc(() => this.win?.webContents ?? null);
  /** A project has been loaded since the window opened. */
  hasProject = false;

  constructor(private readonly createWindow: (studio: Studio) => BrowserWindow) {}

  open(): void {
    if (!this.win) {
      this.win = this.createWindow(this);
      this.hasProject = false;
    }
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
  }

  closed(): void {
    this.win = null;
    this.website?.destroy();
    this.website = null;
    this.hasProject = false;
    this.rpc.reset();
  }
}

type SaveState =
  | { phase: 'idle' }
  | { phase: 'choosing' }
  | { phase: 'saved'; path: string }
  | { phase: 'cancelled' }
  | { phase: 'failed'; error: string };

export class AiService {
  private saveState: SaveState = { phase: 'idle' };

  constructor(
    private readonly studio: Studio,
    private readonly editorRpc: () => RendererRpc | null,
  ) {}

  /** Listens for the MCP bridge on the named pipe. */
  listen(): net.Server {
    const server = net.createServer((socket) => {
      readLines(socket, (line) => {
        let req: PipeRequest;
        try {
          req = JSON.parse(line) as PipeRequest;
        } catch {
          return;
        }
        void this.handle(req).then((res) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`);
        });
      });
      socket.on('error', () => {});
    });
    server.on('error', (err) => console.error('AI connection unavailable:', err.message));
    server.listen(aiPipePath());
    return server;
  }

  private async handle(req: PipeRequest): Promise<PipeResponse> {
    if (req.method !== 'tool') return { id: req.id, error: `Unknown request ${req.method}` };
    const { name, arguments: args } = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    try {
      return { id: req.id, result: await this.callTool(String(name), args ?? {}) };
    } catch (err) {
      return { id: req.id, result: textResult(err instanceof Error ? err.message : String(err), true) };
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!aiAccessEnabled()) return textResult(ACCESS_OFF, true);
    switch (name) {
      case 'read_user_project':
        return this.readUserProject();
      case 'new_project':
        return this.newProject(args);
      case 'get_project':
        return jsonResult(forAi(await this.studioProject()));
      case 'set_project':
        return this.setProject(args);
      case 'apply_preset':
        return this.applyPreset(args);
      case 'inspect_page':
        return this.inspectPage(args);
      case 'screenshot':
        return this.screenshot(args);
      case 'preview':
        return this.preview(args);
      case 'export_video':
        return this.exportVideo(args);
      case 'save_project':
        return this.saveProject(args);
      case 'get_status':
        return this.getStatus(args);
      default:
        return textResult(`Unknown tool ${name}.`, true);
    }
  }

  // ---- reading -------------------------------------------------------------------

  private async userProject(): Promise<Project> {
    const rpc = this.editorRpc();
    if (!rpc) throw new Error("The user's editor window is closed.");
    return parseProject(await rpc.request<string>('readProject'));
  }

  private async readUserProject(): Promise<ToolResult> {
    const project = await this.userProject();
    return textResult(
      `The user's editor project (read-only):\n${summary(project)}\n\n${JSON.stringify(forAi(project))}`,
    );
  }

  private requireStudio(): void {
    if (!this.studio.win || !this.studio.hasProject) throw new Error(NO_STUDIO);
  }

  private async studioProject(): Promise<Project> {
    this.requireStudio();
    return parseProject(await this.studio.rpc.request<string>('get'));
  }

  private async status(): Promise<StudioStatus> {
    return this.studio.rpc.request<StudioStatus>('status');
  }

  // ---- editing -------------------------------------------------------------------

  private async load(project: Project, time = 0): Promise<void> {
    await this.studio.rpc.request('load', { project: serializeProject(project), time });
    this.studio.hasProject = true;
  }

  private async refuseWhileExporting(): Promise<void> {
    const s = await this.status();
    if (s.export.phase === 'choosing' || s.export.phase === 'exporting')
      throw new Error('An export is running. Wait for it (get_status with wait_seconds) before changing the project.');
  }

  private async newProject(args: Record<string, unknown>): Promise<ToolResult> {
    let project: Project;
    if (args.copy_user_project === true) {
      project = await this.userProject();
    } else {
      const url = typeof args.url === 'string' ? normalizeUrl(args.url) : null;
      if (!url) throw new Error('Give an http(s) url, or copy_user_project: true.');
      project = blankProject(url);
    }
    if (typeof args.name === 'string' && args.name.trim()) project.name = args.name.trim().slice(0, 200);
    if (typeof args.duration === 'number' && Number.isFinite(args.duration))
      project.duration = Math.min(Math.max(args.duration, 1), MAX_DURATION);
    this.studio.open();
    if (this.studio.hasProject) await this.refuseWhileExporting();
    await this.load(project);
    return textResult(`Studio project ready. The website loads in the AI Studio window.\n${summary(project)}`);
  }

  private async setProject(args: Record<string, unknown>): Promise<ToolResult> {
    this.requireStudio();
    await this.refuseWhileExporting();
    const raw = typeof args.project === 'string' ? (JSON.parse(args.project) as unknown) : args.project;
    if (!raw || typeof raw !== 'object') throw new Error('project must be the project JSON object.');
    const env = (raw as { environment?: { image?: unknown } }).environment;
    if (env && env.image === IMAGE_PLACEHOLDER) {
      env.image = (await this.studioProject()).environment?.image ?? null;
    }
    const project = parseProject(JSON.stringify(raw));
    const { time } = await this.status();
    await this.load(project, Math.min(time, project.duration));
    return textResult(`Project updated.\n${summary(project)}`);
  }

  private async applyPreset(args: Record<string, unknown>): Promise<ToolResult> {
    await this.refuseWhileExporting();
    const project = await this.studioProject();
    const obj = project.objects.find((o) => o.id === args.object_id);
    if (!obj) throw new Error(`No object with id ${String(args.object_id)}.`);
    const preset = String(args.preset);
    const start = clamp(Number(args.start ?? 0), 0, project.duration);
    const length = Math.min(clamp(Number(args.length ?? 1), 0.05, 60), project.duration - start);
    if (length < 1 / project.output.fps) throw new Error('The preset would start at the very end of the video.');
    if (obj.kind === 'camera') {
      if (!CAMERA_PRESETS.some((p) => p.value === preset)) throw new Error(`${preset} is not a camera preset.`);
      applyCameraPreset(obj, preset as (typeof CAMERA_PRESETS)[number]['value'], start, length);
    } else if (hasTransform(obj)) {
      if (!OBJECT_PRESETS.some((p) => p.value === preset)) throw new Error(`${preset} is not an object preset.`);
      applyObjectPreset(obj, preset as (typeof OBJECT_PRESETS)[number]['value'], start, length);
    } else {
      throw new Error('Presets work on website panels, text and the camera.');
    }
    const { time } = await this.status();
    await this.load(project, time);
    return textResult(`${preset} added to ${obj.name} from ${start.toFixed(2)} s to ${(start + length).toFixed(2)} s.`);
  }

  // ---- looking -------------------------------------------------------------------

  private async websiteTarget(args: Record<string, unknown>): Promise<{ project: Project; id: string; time: number }> {
    const project = await this.studioProject();
    const panels = websites(project);
    const id = typeof args.website_id === 'string' ? args.website_id : panels[0]?.id;
    if (!id || !panels.some((w) => w.id === id))
      throw new Error(`No website panel with id ${String(args.website_id)}.`);
    const time = clamp(Number(args.time ?? 0), 0, project.duration);
    return { project, id, time };
  }

  private async inspectPage(args: Record<string, unknown>): Promise<ToolResult> {
    const { id, time } = await this.websiteTarget(args);
    await this.studio.rpc.request('seek', { time }, 120_000);
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase().slice(0, 200) : '';
    const limit = clamp(Math.round(Number(args.limit ?? 80)), 1, 300);
    const info = await this.studio.website!.evaluate(id, inspectScript(query, limit));
    return textResult(
      `Website ${id} at ${time.toFixed(2)} s. x/y are cursor coordinates (website px) for elements in view; pageY is the distance from the top of the page.\n${JSON.stringify(info)}`,
    );
  }

  private async screenshot(args: Record<string, unknown>): Promise<ToolResult> {
    const { id, time } = await this.websiteTarget(args);
    if (args.target === 'website') {
      await this.studio.rpc.request('seek', { time }, 120_000);
      const png = await this.studio.website!.capturePng(id);
      return {
        content: [
          { type: 'text', text: `Website ${id} at ${time.toFixed(2)} s:` },
          { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
        ],
      };
    }
    const dataUrl = await this.studio.rpc.request<string>('screenshot', { time }, 120_000);
    const m = /^data:(image\/\w+);base64,(.*)$/.exec(dataUrl);
    if (!m) throw new Error('The studio did not produce an image.');
    return {
      content: [
        { type: 'text', text: `Scene at ${time.toFixed(2)} s:` },
        { type: 'image', data: m[2], mimeType: m[1] },
      ],
    };
  }

  private async preview(args: Record<string, unknown>): Promise<ToolResult> {
    const project = await this.studioProject();
    const time = clamp(Number(args.time ?? 0), 0, project.duration);
    await this.studio.rpc.request(args.play === true ? 'play' : 'seek', { time, show: true }, 120_000);
    this.studio.open();
    return textResult(args.play === true ? `Playing from ${time.toFixed(2)} s.` : `Showing ${time.toFixed(2)} s.`);
  }

  // ---- files (the user chooses where) ------------------------------------------------

  private async exportVideo(args: Record<string, unknown>): Promise<ToolResult> {
    this.requireStudio();
    await this.refuseWhileExporting();
    this.studio.open();
    await this.studio.rpc.request('export', { fileName: safeName(args.file_name, 'video') });
    return textResult(
      'Export started: Looit is asking the user where to save the MP4, then it renders. Call get_status with wait_seconds to follow it.',
    );
  }

  private async saveProject(args: Record<string, unknown>): Promise<ToolResult> {
    const project = await this.studioProject();
    if (this.saveState.phase === 'choosing') throw new Error('The Save dialog is already open.');
    const win = this.studio.win!;
    const name = safeName(args.file_name, project.name || 'AI project');
    this.saveState = { phase: 'choosing' };
    void (async () => {
      try {
        const testDir = !app.isPackaged ? process.env.LOOIT_AI_TEST_SAVE_DIR : undefined;
        let target: string | null;
        if (testDir) {
          target = path.join(testDir, `${name}.looit`);
        } else {
          win.show();
          const result = await dialog.showSaveDialog(win, {
            title: 'Save the AI project',
            defaultPath: path.join(app.getPath('documents'), `${name}.looit`),
            filters: [{ name: 'Looit project', extensions: ['looit'] }],
          });
          target = result.canceled || !result.filePath ? null : result.filePath;
        }
        if (!target) {
          this.saveState = { phase: 'cancelled' };
          return;
        }
        const tmp = `${target}.tmp`;
        await fs.writeFile(tmp, serializeProject(project), 'utf8');
        await fs.rename(tmp, target);
        this.saveState = { phase: 'saved', path: target };
      } catch (err) {
        this.saveState = { phase: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    })();
    return textResult('Asked the user where to save the project. get_status reports the result.');
  }

  private async getStatus(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.studio.win) return jsonResult({ studio: 'closed', save: this.saveState });
    const deadline = Date.now() + clamp(Number(args.wait_seconds ?? 0), 0, 50) * 1000;
    let s = await this.status();
    while (
      Date.now() < deadline &&
      (s.export.phase === 'choosing' || s.export.phase === 'exporting' || this.saveState.phase === 'choosing')
    ) {
      await new Promise((r) => setTimeout(r, 1000));
      s = await this.status();
    }
    return jsonResult({ ...s, save: this.saveState });
  }
}

// ---- helpers ------------------------------------------------------------------------

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value));
}

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : min;
}

function safeName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v : fallback;
  return (
    s
      .replace(/\.(mp4|looit)$/i, '')
      .replace(/[<>:"/\\|?*]/g, '_')
      // Control characters can't be in file names.
      .replace(/\p{Cc}/gu, '')
      .trim()
      .slice(0, 120) || fallback
  );
}

function normalizeUrl(raw: string): string | null {
  let url = raw.trim();
  if (url && !/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
  return isAllowedSiteUrl(url, false) ? url : null;
}

/** A clean starting point: one still panel facing the camera, a resting cursor, no animation. */
function blankProject(url: string): Project {
  const p = newProject(url);
  p.name = 'AI video';
  p.duration = 10;
  for (const o of p.objects) {
    if (o.kind === 'website') {
      o.transform.position = { value: [0, 0, 0], keyframes: [] };
      o.transform.rotation = { value: [0, 0, 0], keyframes: [] };
      o.transform.scale = { value: [1, 1, 1], keyframes: [] };
    } else if (o.kind === 'cursor') {
      o.position = { value: [640, 400], keyframes: [] };
      o.clicks = [];
    }
  }
  return p;
}

/** The project as shown to the AI: an embedded background image becomes a placeholder. */
function forAi(p: Project): Project {
  if (!p.environment?.image) return p;
  return { ...p, environment: { ...p.environment, image: IMAGE_PLACEHOLDER } };
}

function summary(p: Project): string {
  const line = (o: SceneObject): string => {
    if (o.kind === 'website')
      return `- website ${o.id} "${o.name}": ${o.url} (${o.viewport.width}x${o.viewport.height})`;
    if (o.kind === 'cursor') {
      const c = o as CursorObject;
      return `- cursor ${c.id} on ${c.targetId}: ${c.position.keyframes.length} moves, ${c.clicks.length} clicks, ${c.scrolls.length} scrolls, ${c.keys.length} typing/keys`;
    }
    if (o.kind === 'camera') {
      const c = o as CameraObject;
      const keys = c.position.keyframes.length + c.target.keyframes.length + c.zoom.keyframes.length;
      return `- camera ${c.id}: ${keys ? `${keys} keyframes` : 'still'}`;
    }
    return `- text ${o.id}: "${o.text}"`;
  };
  return [
    `"${p.name}", ${p.duration} s, ${p.output.width}x${p.output.height} at ${p.output.fps} fps`,
    ...p.objects.map(line),
  ].join('\n');
}

/** Runs in the website (isolated world): what's on the page and where, in website pixels. */
function inspectScript(query: string, limit: number): string {
  return `(() => {
  const q = ${JSON.stringify(query)};
  const limit = ${limit};
  const vw = innerWidth, vh = innerHeight;
  const se = document.scrollingElement || document.documentElement;
  const scrollY = Math.round(se.scrollTop);
  const pageHeight = Math.round(se.scrollHeight);
  const shown = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 100);
  const pinned = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const p = getComputedStyle(e).position;
      if (p === 'fixed' || p === 'sticky') return true;
    }
    return false;
  };
  const SEL = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=menuitem], [role=tab], [aria-haspopup], [onclick]';
  const found = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (el.parentElement && el.parentElement.closest(SEL)) continue;
    if (!shown(el)) continue;
    const text = label(el);
    const href = el.getAttribute('href') || '';
    if (q && !(text.toLowerCase().includes(q) || href.toLowerCase().includes(q))) continue;
    const r = el.getBoundingClientRect();
    const fixed = pinned(el);
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const item = {
      tag: el.tagName.toLowerCase(), text,
      // In view = its centre is on screen, so the cursor can point at it.
      inView: x >= 0 && x < vw && y >= 0 && y < vh,
      x, y,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    };
    if (href) item.href = href;
    if (el.getAttribute('role')) item.role = el.getAttribute('role');
    if (el.getAttribute('aria-haspopup')) item.dropdown = true;
    if (el.getAttribute('aria-expanded')) item.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') item.field = el.type || 'text';
    if (fixed) item.pinned = true; else item.pageY = Math.round(r.top + scrollY);
    found.push(item);
  }
  found.sort((a, b) => (b.inView - a.inView) || ((a.pageY ?? a.y) - (b.pageY ?? b.y)));
  const headings = [];
  for (const h of document.querySelectorAll('h1, h2, h3')) {
    if (!shown(h)) continue;
    const text = label(h);
    if (!text || (q && !text.toLowerCase().includes(q))) continue;
    const r = h.getBoundingClientRect();
    headings.push({ level: +h.tagName[1], text, pageY: Math.round(r.top + scrollY), inView: r.top >= 0 && r.top < vh });
    if (headings.length >= 60) break;
  }
  return {
    url: location.href, title: document.title, viewport: [vw, vh],
    scrollY, pageHeight, maxScrollY: Math.max(0, pageHeight - vh),
    elements: found.slice(0, limit), moreElements: Math.max(0, found.length - limit), headings,
  };
})()`;
}
