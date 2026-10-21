// Builds the app's icon set from assets/logo.svg: the window icon, the Windows
// .ico used by the packaged executable, and the MSIX tile images.
//   node scripts/make-icons.mjs
//
// It renders the logo with Electron (so the SVG is rasterised exactly as the
// app draws it) on the same white rounded tile at every size.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SVG = path.join(ROOT, 'assets', 'logo.svg');
const OUT = path.join(ROOT, 'build');

const squares = [512, 256, 128, 64, 48, 32, 16];
const jobs = [
  ...squares.map((s) => ({ file: path.join('tmp', `icon-${s}.png`), w: s, h: s, kind: 'tile' })),
  { file: path.join('msix', 'icon.png'), w: 50, h: 50, kind: 'tile' },
  { file: path.join('msix', 'LockScreenLogo.scale-200.png'), w: 48, h: 48, kind: 'tile' },
  { file: path.join('msix', 'Square44x44Logo.png'), w: 88, h: 88, kind: 'tile' },
  { file: path.join('msix', 'Square44x44Logo.scale-200.png'), w: 88, h: 88, kind: 'tile' },
  { file: path.join('msix', 'Square44x44Logo.targetsize-24_altform-unplated.png'), w: 24, h: 24, kind: 'tile' },
  { file: path.join('msix', 'Square150x150Logo.png'), w: 300, h: 300, kind: 'tile' },
  { file: path.join('msix', 'Square150x150Logo.scale-200.png'), w: 300, h: 300, kind: 'tile' },
  { file: path.join('msix', 'Wide310x150Logo.png'), w: 310, h: 150, kind: 'wide' },
  { file: path.join('msix', 'Wide310x150Logo.scale-200.png'), w: 620, h: 300, kind: 'wide' },
  { file: path.join('msix', 'SplashScreen.scale-200.png'), w: 1240, h: 600, kind: 'splash' },
];

const svg = await fs.readFile(SVG, 'utf8');
const scaled = svg.replace('<svg ', '<svg style="width:100%;height:auto;display:block" ');

const html = ({ w, h, kind }) => {
  const ribbon = kind === 'tile' ? w * 0.8 : w * 0.55;
  const radius = kind === 'splash' ? 0 : Math.min(w, h) * 0.225;
  return `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent">
<div style="position:absolute;inset:0;background:#ffffff;border-radius:${radius}px"></div>
<div style="position:absolute;left:50%;top:50%;width:${ribbon}px;transform:translate(-50%,-50%)">${scaled}</div>
</body></html>`;
};

const renderer = path.join(OUT, 'icon-renderer.cjs');
const jobsFile = path.join(OUT, 'icon-jobs.json');
await fs.mkdir(path.join(OUT, 'tmp'), { recursive: true });
await fs.mkdir(path.join(OUT, 'msix'), { recursive: true });
await fs.writeFile(jobsFile, JSON.stringify(jobs.map((job) => ({ ...job, html: html(job) }))), 'utf8');
await fs.writeFile(
  renderer,
  `const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const [out, jobsFile] = process.argv.slice(2);
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
app.disableHardwareAcceleration();
// Each capture closes its window; without this the app would quit after the first.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const job of jobs) {
    const win = new BrowserWindow({
      width: job.w, height: job.h, show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', webPreferences: { offscreen: true },
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(job.html));
    await new Promise((r) => setTimeout(r, 250));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, job.file), image.toPNG());
    win.destroy();
  }
  app.quit();
});
`,
  'utf8',
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
execFileSync(ELECTRON, [renderer, OUT, jobsFile], { env, stdio: 'inherit' });

// The window icon and a PNG for the packaged app.
await fs.copyFile(path.join(OUT, 'tmp', 'icon-512.png'), path.join(ROOT, 'assets', 'icon.png'));
await fs.copyFile(path.join(OUT, 'tmp', 'icon-256.png'), path.join(OUT, 'icon.png'));

// Windows .ico with PNG entries (valid since Vista).
const pngs = [];
for (const size of squares) pngs.push({ size, data: await fs.readFile(path.join(OUT, 'tmp', `icon-${size}.png`)) });
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const entries = pngs.map((p) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(p.size >= 256 ? 0 : p.size, 0);
  entry.writeUInt8(p.size >= 256 ? 0 : p.size, 1);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(p.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += p.data.length;
  return entry;
});
await fs.writeFile(path.join(OUT, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));

await fs.rm(path.join(OUT, 'tmp'), { recursive: true, force: true });
await fs.rm(renderer, { force: true });
await fs.rm(jobsFile, { force: true });
console.log('icons updated from assets/logo.svg');
