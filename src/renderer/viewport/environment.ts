// The stage around the panels: background (solid, gradient or image) and an
// optional floor (a soft reflection or a grid). Everything is a function of
// the project only, so preview and export look the same.

import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { environmentOf, type Environment, type Project } from '../../engine/project';

/** Half the side length of the floor, in world units. */
const FLOOR_HALF = 150;
/** Height of the reflection render target in pixels (width follows the aspect). */
const REFLECTION_HEIGHT = 1080;

interface BackgroundImage {
  url: string;
  texture: THREE.Texture | null;
  ready: Promise<void>;
}

export class EnvironmentView {
  private aspect = 16 / 9;
  private backgroundKey = '';
  private gradient: THREE.CanvasTexture | null = null;
  private image: BackgroundImage | null = null;
  private floorKey = '';
  private floor: THREE.Group | null = null;
  private reflector: Reflector | null = null;

  constructor(private readonly scene: THREE.Scene) {}

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.backgroundKey = ''; // gradient and image cover-fit depend on the aspect
    this.reflector?.getRenderTarget().setSize(Math.round(REFLECTION_HEIGHT * aspect), REFLECTION_HEIGHT);
  }

  sync(project: Project): void {
    const env = environmentOf(project);
    this.syncBackground(project.background, env);
    this.syncFloor(env);
  }

  /** Resolves once the background image (if any) is decoded and showing. */
  async ready(project: Project): Promise<void> {
    this.sync(project);
    if (environmentOf(project).background === 'image' && this.image) await this.image.ready;
    this.sync(project);
  }

  private syncBackground(color: string, env: Environment): void {
    // The image itself is compared by reference below; a loaded texture clears the key.
    const key = [env.background, color, env.gradientTo, env.gradientAngle, this.aspect].join('|');
    if (key === this.backgroundKey && (env.background !== 'image' || this.image?.url === env.image)) return;
    this.backgroundKey = key;

    if (env.background === 'gradient') {
      this.gradient?.dispose();
      this.gradient = makeGradient(color, env.gradientTo, env.gradientAngle, this.aspect);
      this.scene.background = this.gradient;
      return;
    }
    if (env.background === 'image' && env.image) {
      if (this.image?.url !== env.image) this.loadImage(env.image);
      const tex = this.image!.texture;
      if (tex) {
        coverFit(tex, this.aspect);
        this.scene.background = tex;
        return;
      }
      // Until the image is decoded, show the solid colour.
    }
    this.scene.background = new THREE.Color(color);
  }

  private loadImage(url: string): void {
    this.image?.texture?.dispose();
    const entry: BackgroundImage = { url, texture: null, ready: Promise.resolve() };
    entry.ready = (async () => {
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        if (this.image !== entry) return;
        const tex = new THREE.Texture(img);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        entry.texture = tex;
        this.backgroundKey = '';
      } catch {
        // A broken image leaves the solid colour showing.
      }
    })();
    this.image = entry;
  }

  private syncFloor(env: Environment): void {
    const key = [env.floor, env.floorY, env.floorColor].join('|');
    if (key === this.floorKey) return;
    this.floorKey = key;
    this.disposeFloor();
    if (env.floor === 'none') return;

    const group = new THREE.Group();
    group.position.y = env.floorY;
    if (env.floor === 'grid') {
      const grid = new THREE.GridHelper(FLOOR_HALF * 2, FLOOR_HALF, env.floorColor, env.floorColor);
      const mat = grid.material as THREE.LineBasicMaterial;
      mat.transparent = true;
      mat.opacity = 0.35;
      mat.depthWrite = false;
      group.add(grid);
    } else {
      const size = FLOOR_HALF * 2;
      const reflector = new Reflector(new THREE.PlaneGeometry(size, size), {
        textureWidth: Math.round(REFLECTION_HEIGHT * this.aspect),
        textureHeight: REFLECTION_HEIGHT,
        clipBias: 0.003,
        color: 0x888888,
      });
      reflector.rotation.x = -Math.PI / 2;
      group.add(reflector);
      this.reflector = reflector;
      // Tint over the mirror: mostly see-through near the middle, solid at the edges.
      const tint = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          color: env.floorColor,
          transparent: true,
          alphaMap: makeRadialAlpha(),
          depthWrite: false,
        }),
      );
      tint.rotation.x = -Math.PI / 2;
      tint.position.y = 0.002;
      group.add(tint);
      // The tint lies on the mirror; keep it out of the reflection pass.
      const renderReflection = reflector.onBeforeRender.bind(reflector);
      reflector.onBeforeRender = (...args) => {
        tint.visible = false;
        renderReflection(...args);
        tint.visible = true;
      };
    }
    this.scene.add(group);
    this.floor = group;
  }

  private disposeFloor(): void {
    if (!this.floor) return;
    this.floor.removeFromParent();
    this.floor.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        const m = o.material as THREE.MeshBasicMaterial;
        m.alphaMap?.dispose();
        m.dispose();
      }
    });
    this.reflector?.dispose();
    this.reflector = null;
    this.floor = null;
  }
}

/** Screen-filling linear gradient; angle 0 = left to right, 90 = top to bottom. */
function makeGradient(from: string, to: string, angle: number, aspect: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = Math.max(1, Math.round(1024 / aspect));
  const ctx = canvas.getContext('2d')!;
  const a = (angle * Math.PI) / 180;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  // Half the gradient length so the colours reach the corners.
  const r = (Math.abs(Math.cos(a)) * canvas.width + Math.abs(Math.sin(a)) * canvas.height) / 2;
  const g = ctx.createLinearGradient(
    cx - Math.cos(a) * r,
    cy - Math.sin(a) * r,
    cx + Math.cos(a) * r,
    cy + Math.sin(a) * r,
  );
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Crops the texture (via its UV transform) so it covers the view without stretching. */
function coverFit(tex: THREE.Texture, aspect: number): void {
  const img = tex.image as { width: number; height: number };
  const imageAspect = img.width / img.height;
  if (imageAspect > aspect) {
    tex.repeat.set(aspect / imageAspect, 1);
    tex.offset.set((1 - tex.repeat.x) / 2, 0);
  } else {
    tex.repeat.set(1, imageAspect / aspect);
    tex.offset.set(0, (1 - tex.repeat.y) / 2);
  }
}

/** Alpha 0.72 in the middle rising to 1 at the floor's edge (alphaMap reads the green channel). */
function makeRadialAlpha(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgb(184,184,184)');
  g.addColorStop(0.35, 'rgb(200,200,200)');
  g.addColorStop(1, 'rgb(255,255,255)');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(128, 128, 128, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(canvas);
}
