// Canvas-generated textures for the cursor, text objects and soft shadows.

import * as THREE from 'three';
import type { CursorStyle } from '../../engine/project';

function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export interface CursorImage {
  texture: THREE.CanvasTexture;
  /** The click point, as a fraction of the image (0,0 = top-left). */
  hotspot: [number, number];
}

/** Draws a cursor style on a 24x24 design grid. */
export function makeCursorTexture(style: CursorStyle): CursorImage {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(size / 24, size / 24);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  let hotspot: [number, number] = [1 / 24, 1 / 24];
  const shape = (path: Path2D, fill: string, stroke: string, width = 1.6) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = stroke;
    ctx.fillStyle = fill;
    ctx.stroke(path);
    ctx.fill(path);
  };
  const arrow = new Path2D('M1 1 L1 18.5 L5.6 14.2 L8.6 21 L11.6 19.7 L8.7 13 L15 13 Z');
  switch (style) {
    case 'arrow':
      shape(arrow, '#111111', '#ffffff');
      break;
    case 'arrow-white':
      shape(arrow, '#ffffff', '#111111', 1.3);
      break;
    case 'hand': {
      // Pointing hand; the fingertip is the click point.
      const hand = new Path2D(
        'M8 2.2 C8 1.2 10.2 1.2 10.2 2.2 L10.2 9.2 C10.4 8.2 12.6 8.2 12.6 9.4 L12.6 10.2 C12.8 9.2 15 9.2 15 10.4 L15 11.2 ' +
          'C15.2 10.2 17.4 10.2 17.4 11.4 L17.4 16 C17.4 19.6 15.2 22 12 22 L10.6 22 C8.6 22 7.2 21 6 19.2 L3.2 14.8 ' +
          'C2.4 13.6 3.8 12.2 5 13.2 L8 15.6 Z',
      );
      shape(hand, '#ffffff', '#111111', 1.2);
      hotspot = [9.1 / 24, 1.4 / 24];
      break;
    }
    case 'ibeam': {
      const beam = new Path2D('M8 3 Q12 3 12 5 Q12 3 16 3 M12 5 L12 19 M8 21 Q12 21 12 19 Q12 21 16 21 M10 12 L14 12');
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke(beam);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#111111';
      ctx.stroke(beam);
      hotspot = [12 / 24, 12 / 24];
      break;
    }
    case 'dot': {
      // Touch-style dot, like screen recordings of phones.
      ctx.beginPath();
      ctx.arc(12, 12, 9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(17, 17, 17, 0.35)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.stroke();
      hotspot = [12 / 24, 12 / 24];
      break;
    }
  }
  return { texture: canvasTexture(canvas), hotspot };
}

type Corners = 'all' | 'top' | 'bottom';

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  corners: Corners,
) {
  const top = corners === 'bottom' ? 0 : r;
  const bottom = corners === 'top' ? 0 : r;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, [top, top, bottom, bottom]);
}

/**
 * A white-on-black rounded rectangle used as an alpha mask (three.js reads the
 * green channel), so the panel and frame get smooth rounded corners.
 * Sizes are in world units.
 */
export function makeRoundedMask(width: number, height: number, radius: number, corners: Corners): THREE.CanvasTexture {
  const ppu = Math.min(160, 2048 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(width * ppu));
  canvas.height = Math.max(2, Math.round(height * ppu));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  roundedRectPath(
    ctx,
    0,
    0,
    canvas.width,
    canvas.height,
    Math.min(radius * ppu, canvas.height / 2, canvas.width / 2),
    corners,
  );
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** A solid rounded rectangle (border/backing), world units. */
export function makeRoundedFill(width: number, height: number, radius: number): THREE.CanvasTexture {
  return makeRoundedMask(width, height, radius, 'all');
}

const FRAME_THEMES = {
  light: { bar: '#e8eaee', field: '#ffffff', text: '#3f4652', muted: '#9aa1ad' },
  dark: { bar: '#2a2d34', field: '#1b1d22', text: '#d7dbe2', muted: '#7d8491' },
};

/**
 * The browser window bar: three window buttons and an address bar with the
 * page address. `pxWidth` is the website viewport width in CSS pixels, so the
 * bar has the proportions of a real browser at that size.
 */
export function makeWindowBarTexture(
  theme: 'light' | 'dark',
  url: string,
  pxWidth: number,
  pxHeight: number,
): THREE.CanvasTexture {
  const scale = Math.min(2, 4096 / pxWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(pxWidth * scale);
  canvas.height = Math.round(pxHeight * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  const c = FRAME_THEMES[theme];
  ctx.fillStyle = c.bar;
  ctx.fillRect(0, 0, pxWidth, pxHeight);
  const mid = pxHeight / 2;
  ['#ff5f57', '#febc2e', '#28c840'].forEach((color, i) => {
    ctx.beginPath();
    ctx.arc(20 + i * 20, mid, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
  // Address field, centred like a modern browser.
  const fieldW = Math.min(pxWidth * 0.5, 640);
  const fieldH = pxHeight * 0.62;
  const fx = (pxWidth - fieldW) / 2;
  const fy = mid - fieldH / 2;
  ctx.fillStyle = c.field;
  ctx.beginPath();
  ctx.roundRect(fx, fy, fieldW, fieldH, fieldH / 2);
  ctx.fill();
  let address = url;
  try {
    const u = new URL(url);
    address = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    // keep as typed
  }
  ctx.font = `500 ${Math.round(fieldH * 0.5)}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  // Padlock
  const lockX = fx + 16;
  ctx.strokeStyle = c.muted;
  ctx.fillStyle = c.muted;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(lockX, mid - 2, 3.2, Math.PI, 0);
  ctx.stroke();
  ctx.fillRect(lockX - 4.5, mid - 2, 9, 7);
  ctx.fillStyle = c.text;
  let text = address;
  const maxW = fieldW - 60;
  while (text.length > 4 && ctx.measureText(text).width > maxW) text = text.slice(0, -2);
  if (text !== address) text = text.slice(0, -1) + '…';
  ctx.fillText(text, pxWidth / 2, mid + 1);
  return canvasTexture(canvas);
}

/** Pixels per world unit for text; high enough to stay sharp at 1080p close-ups. */
const TEXT_PPU = 160;
const MAX_CANVAS = 4096;

export interface TextTexture {
  texture: THREE.CanvasTexture;
  /** Size in world units. */
  width: number;
  height: number;
}

export interface TextStyle {
  /** Rounded pill behind the text, drawn into the same texture. */
  background?: { color: string; opacity: number; padding: number; radius: number } | null;
  /** Drop shadow, drawn into the same texture. */
  shadow?: { color: string; opacity: number; offsetX: number; offsetY: number; blur: number } | null;
}

function withAlpha(color: string, alpha: number): string {
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function makeTextTexture(
  text: string,
  size: number,
  color: string,
  weight: number,
  style: TextStyle = {},
): TextTexture {
  const lines = (text || ' ').split('\n');
  const scale = Math.min(TEXT_PPU, MAX_CANVAS / Math.max(size * lines.length * 1.25, 1));
  const fontPx = size * scale;
  const font = `${weight} ${fontPx}px "Segoe UI", system-ui, sans-serif`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const lineHeight = fontPx * 1.2;
  const pad = Math.ceil(fontPx * 0.15);
  const textWidth = Math.max(...lines.map((l) => measure.measureText(l).width), 1);
  // A pill adds padding around the text; the texture grows to hold it.
  const bg = style.background ?? null;
  const bgPad = bg ? Math.ceil(bg.padding * fontPx) : 0;
  const outer = pad + bgPad;
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(MAX_CANVAS, Math.ceil(textWidth + outer * 2));
  canvas.height = Math.min(MAX_CANVAS, Math.ceil(lineHeight * lines.length + outer * 2));
  const ctx = canvas.getContext('2d')!;
  if (bg) {
    ctx.globalAlpha = bg.opacity;
    ctx.fillStyle = bg.color;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, Math.min(bg.radius * fontPx, canvas.height / 2));
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const sh = style.shadow ?? null;
  if (sh) {
    ctx.shadowColor = withAlpha(sh.color, sh.opacity);
    ctx.shadowBlur = sh.blur * fontPx;
    ctx.shadowOffsetX = sh.offsetX * fontPx;
    ctx.shadowOffsetY = sh.offsetY * fontPx;
  }
  lines.forEach((line, i) => ctx.fillText(line, canvas.width / 2, outer + lineHeight * (i + 0.5)));
  return { texture: canvasTexture(canvas), width: canvas.width / scale, height: canvas.height / scale };
}

/** Pixels per world unit for shadows (they are blurry, so this can be low). */
const SHADOW_PPU = 24;

/**
 * A white, blurred rounded rectangle; tinted and faded by the material.
 * The returned texture covers `margin` world units around the panel on each side.
 */
export function makeShadowTexture(
  width: number,
  height: number,
  blur: number,
): { texture: THREE.CanvasTexture; margin: number } {
  const margin = Math.max(blur * 2, 0.1);
  const w = width + margin * 2;
  const h = height + margin * 2;
  const ppu = Math.min(SHADOW_PPU, 2048 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * ppu);
  canvas.height = Math.ceil(h * ppu);
  const ctx = canvas.getContext('2d')!;
  ctx.filter = `blur(${Math.max(blur * ppu * 0.6, 0.01)}px)`;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(margin * ppu, margin * ppu, width * ppu, height * ppu, 0.15 * ppu);
  ctx.fill();
  const texture = canvasTexture(canvas);
  return { texture, margin };
}
