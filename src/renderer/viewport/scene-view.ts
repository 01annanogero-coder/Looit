// The 3D stage: the project camera, the environment and one Three.js node per object.
// `sync` sets everything from the project at a given time, so a time always
// produces the same picture in the preview and in the export.

import * as THREE from 'three';
import {
  CAMERA_FOV,
  cameraOf,
  evaluateTransform,
  eventsBetween,
  sample,
  type CursorObject,
  type CursorStyle,
  type Project,
  type TextObject,
  type TransformState,
  type WebsiteObject,
} from '../../engine/project';
import {
  makeCursorTexture,
  makeRoundedFill,
  makeRoundedMask,
  makeShadowTexture,
  makeTextTexture,
  makeWindowBarTexture,
  type CursorImage,
} from './textures';
import { EnvironmentView } from './environment';

/** World-space width of a website panel at scale 1. */
export const PANEL_WIDTH = 16;
const RIPPLE_DURATION = 0.45;
/** Height of the browser window bar, in website CSS pixels. */
const WINDOW_BAR_PX = 40;
const DEG = Math.PI / 180;

const OUTLINE_COLOR = '#6366f1';

type Plane = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

/**
 * A website panel: the page itself (origin at its centre, so cursor
 * coordinates map onto it directly), plus an optional browser window bar
 * above it, a border behind both, a soft shadow, and the selection outline.
 */
interface WebsiteNode {
  kind: 'website';
  group: THREE.Group;
  panel: Plane;
  bar: Plane;
  border: Plane;
  shadow: Plane;
  outline: THREE.LineSegments;
  size: { w: number; h: number };
  /** Settings each part's texture was built from; rebuilt only when they change. */
  keys: { mask: string; bar: string; border: string; shadow: string; outline: string };
}

interface TextNode {
  kind: 'text';
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  outline: THREE.LineSegments;
  key: string;
}

interface CursorNode {
  kind: 'cursor';
  pointer: Plane;
  ripple: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  key: string;
}

type Node = WebsiteNode | TextNode | CursorNode;

export interface SyncOptions {
  selectedId: string | null;
  /** Hide editor-only helpers (selection outline) for export. */
  showHelpers: boolean;
}

function outlineFor(w: number, h: number, centerY = 0): THREE.LineSegments {
  const geo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h).translate(0, centerY, 0));
  const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: OUTLINE_COLOR, depthTest: false }));
  line.renderOrder = 10;
  return line;
}

function applyTransform(obj: THREE.Object3D, s: TransformState): void {
  obj.position.set(...s.position);
  obj.rotation.set(s.rotation[0] * DEG, s.rotation[1] * DEG, s.rotation[2] * DEG, 'XYZ');
  obj.scale.set(...s.scale);
}

function setOpacity(mat: THREE.Material, opacity: number, baseTransparent = false): void {
  const transparent = baseTransparent || opacity < 1;
  if (mat.transparent !== transparent) {
    mat.transparent = transparent;
    mat.needsUpdate = true;
  }
  mat.opacity = opacity;
}

export class SceneView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 400);
  private readonly nodes = new Map<string, Node>();
  private readonly cursorImages = new Map<CursorStyle, CursorImage>();
  /** Live website frames, per website panel. */
  private readonly websiteTextures = new Map<string, THREE.Texture>();
  /** Each panel's current page address, for the window bar (the project URL until known). */
  readonly pageUrls = new Map<string, string>();
  private readonly guides: THREE.Line[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly environment = new EnvironmentView(this.scene);

  constructor() {
    // Axis guide lines for constrained transforms (X red, Y green, Z blue).
    for (const color of ['#ef4444', '#22c55e', '#3b82f6']) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)]);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      line.renderOrder = 20;
      line.visible = false;
      this.guides.push(line);
      this.scene.add(line);
    }
  }

  /** Shows infinite axis lines through `at` for the constrained axis (or the two others when excluded). */
  setGuide(at: readonly number[] | null, constraint: { axis: 0 | 1 | 2; exclude: boolean } | null): void {
    this.guides.forEach((line, i) => {
      const on = !!at && !!constraint && (constraint.exclude ? i !== constraint.axis : i === constraint.axis);
      line.visible = on;
      if (!on || !at) return;
      const dir = [0, 0, 0];
      dir[i] = 1000;
      line.geometry.setFromPoints([
        new THREE.Vector3(at[0] - dir[0], at[1] - dir[1], at[2] - dir[2]),
        new THREE.Vector3(at[0] + dir[0], at[1] + dir[1], at[2] + dir[2]),
      ]);
    });
  }

  /** Hides editor-only helpers (axis guides) for export. */
  hideGuides(): void {
    for (const g of this.guides) g.visible = false;
  }

  /** Raycasts normalized device coordinates against a website panel; returns its UV. */
  raycastWebsite(id: string, ndcX: number, ndcY: number): THREE.Vector2 | null {
    const n = this.nodes.get(id);
    if (!n || n.kind !== 'website') return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    return this.raycaster.intersectObject(n.panel, false)[0]?.uv ?? null;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.environment.setAspect(aspect);
  }

  /** The live website frames shown on a website panel. */
  setWebsiteTexture(websiteId: string, texture: THREE.Texture | null): void {
    if (texture) this.websiteTextures.set(websiteId, texture);
    else this.websiteTextures.delete(websiteId);
  }

  /** The object the gizmo should move for a project object, if it has a transform. */
  object3D(id: string): THREE.Object3D | null {
    const n = this.nodes.get(id);
    return n && n.kind !== 'cursor' ? n.group : null;
  }

  /** Website panel meshes, for raycasting. */
  /** Meshes that select an object when clicked. `page`: the website itself (clicks can go to the site). */
  pickables(): { id: string; mesh: THREE.Mesh; page?: boolean }[] {
    const out: { id: string; mesh: THREE.Mesh; page?: boolean }[] = [];
    for (const [id, n] of this.nodes) {
      if (n.kind === 'website' && n.group.visible) {
        out.push({ id, mesh: n.panel, page: true });
        if (n.bar.visible) out.push({ id, mesh: n.bar });
      }
      if (n.kind === 'text' && n.group.visible) out.push({ id, mesh: n.mesh });
    }
    return out;
  }

  /** Website panel UV -> website CSS pixel. */
  uvToPixel(website: WebsiteObject, uv: THREE.Vector2): [number, number] {
    return [uv.x * website.viewport.width, (1 - uv.y) * website.viewport.height];
  }

  sync(project: Project, time: number, opts: SyncOptions): void {
    this.environment.sync(project);
    this.syncCamera(project, time);
    const alive = new Set<string>();
    // Websites first so cursors can attach to them.
    for (const o of project.objects) if (o.kind === 'website') this.syncWebsite(o, time, opts, alive);
    for (const o of project.objects) {
      if (o.kind === 'text') this.syncText(o, time, opts, alive);
      else if (o.kind === 'cursor') this.syncCursor(o, project, time, alive);
    }
    for (const [id, n] of this.nodes) {
      if (!alive.has(id)) this.removeNode(id, n);
    }
  }

  /** Waits until the environment (background image) is ready to render. */
  prepare(project: Project): Promise<void> {
    return this.environment.ready(project);
  }

  private syncCamera(project: Project, time: number): void {
    const cam = cameraOf(project);
    const [px, py, pz] = sample(cam.position, time);
    const target = new THREE.Vector3(...sample(cam.target, time));
    this.camera.position.set(px, py, pz);
    // Looking straight down/up needs a different "up" to stay well defined.
    const dir = target.clone().sub(this.camera.position);
    const vertical = dir.lengthSq() > 0 && Math.abs(dir.clone().normalize().y) > 0.999;
    this.camera.up.set(0, vertical ? 0 : 1, vertical ? -1 : 0);
    if (dir.lengthSq() > 0) this.camera.lookAt(target);
    const zoom = Math.max(sample(cam.zoom, time), 0.1);
    const fov = (2 * Math.atan(Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180) / zoom) * 180) / Math.PI;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  private syncWebsite(o: WebsiteObject, time: number, opts: SyncOptions, alive: Set<string>): void {
    alive.add(o.id);
    const w = PANEL_WIDTH;
    const h = (PANEL_WIDTH * o.viewport.height) / o.viewport.width;
    let n = this.nodes.get(o.id) as WebsiteNode | undefined;
    if (!n || n.size.w !== w || n.size.h !== h) {
      if (n) this.removeNode(o.id, n);
      const plane = (renderOrder: number, params: THREE.MeshBasicMaterialParameters = {}) => {
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, ...params }),
        );
        m.renderOrder = renderOrder;
        return m;
      };
      const group = new THREE.Group();
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide }),
      );
      const bar = plane(0);
      const border = plane(-1, { transparent: true });
      const shadow = plane(-2, { transparent: true, depthWrite: false, side: THREE.FrontSide });
      const outline = outlineFor(w, h);
      group.add(shadow, border, panel, bar, outline);
      this.scene.add(group);
      n = {
        kind: 'website',
        group,
        panel,
        bar,
        border,
        shadow,
        outline,
        size: { w, h },
        keys: { mask: '', bar: '', border: '', shadow: '', outline: '' },
      };
      this.nodes.set(o.id, n);
    }
    const state = evaluateTransform(o.transform, time);
    applyTransform(n.group, state);
    n.group.visible = o.visible && state.opacity > 0;

    // Window geometry, from website CSS pixels to world units.
    const perPx = w / o.viewport.width;
    const barH = o.frame === 'none' ? 0 : WINDOW_BAR_PX * perPx;
    const radius = o.cornerRadius * perPx;
    const borderW = o.border.width * perPx;
    const winH = h + barH;
    const centerY = barH / 2; // window centre relative to the page centre

    // The page: website frames, rounded at the bottom (or all round without a bar).
    const mat = n.panel.material;
    const pageTexture = this.websiteTextures.get(o.id) ?? null;
    if (mat.map !== pageTexture) {
      mat.map = pageTexture;
      mat.color.set(pageTexture ? '#ffffff' : '#d1d5db');
      mat.needsUpdate = true;
    }
    const maskKey = `${w}|${h}|${radius}|${o.frame !== 'none'}`;
    if (n.keys.mask !== maskKey) {
      mat.alphaMap?.dispose();
      mat.alphaMap = radius > 0 ? makeRoundedMask(w, h, radius, o.frame === 'none' ? 'all' : 'bottom') : null;
      mat.needsUpdate = true;
      n.keys.mask = maskKey;
    }
    setOpacity(mat, state.opacity, !!mat.alphaMap);

    // Browser window bar above the page.
    n.bar.visible = o.frame !== 'none';
    if (o.frame !== 'none') {
      const url = this.pageUrls.get(o.id) ?? o.url;
      const barKey = `${o.frame}|${url}|${o.viewport.width}|${radius}|${w}|${barH}`;
      const bm = n.bar.material;
      if (n.keys.bar !== barKey) {
        bm.map?.dispose();
        bm.alphaMap?.dispose();
        bm.map = makeWindowBarTexture(o.frame, url, o.viewport.width, WINDOW_BAR_PX);
        bm.alphaMap = radius > 0 ? makeRoundedMask(w, barH, radius, 'top') : null;
        bm.needsUpdate = true;
        n.keys.bar = barKey;
      }
      n.bar.scale.set(w, barH, 1);
      n.bar.position.set(0, h / 2 + barH / 2, 0);
      setOpacity(bm, state.opacity, !!bm.alphaMap);
    }

    // Border: a rounded backing plate slightly larger than the window.
    n.border.visible = borderW > 0;
    if (borderW > 0) {
      const bw = w + borderW * 2;
      const bh = winH + borderW * 2;
      const borderKey = `${bw}|${bh}|${radius}`;
      const bmat = n.border.material;
      if (n.keys.border !== borderKey) {
        bmat.alphaMap?.dispose();
        bmat.alphaMap = makeRoundedFill(bw, bh, radius > 0 ? radius + borderW : 0);
        bmat.needsUpdate = true;
        n.keys.border = borderKey;
      }
      n.border.scale.set(bw, bh, 1);
      n.border.position.set(0, centerY, -0.01);
      bmat.color.set(o.border.color);
      setOpacity(bmat, state.opacity, true);
    }

    // Shadow (or glow, when it doesn't drop).
    const sh = o.shadow;
    n.shadow.visible = sh.enabled && sh.opacity > 0;
    if (n.shadow.visible) {
      const sw = w + borderW * 2;
      const shh = winH + borderW * 2;
      const shadowKey = `${sw}|${shh}|${sh.blur}`;
      if (shadowKey !== n.keys.shadow) {
        n.shadow.material.map?.dispose();
        const { texture, margin } = makeShadowTexture(sw, shh, sh.blur);
        n.shadow.material.map = texture;
        n.shadow.material.needsUpdate = true;
        n.shadow.scale.set(sw + margin * 2, shh + margin * 2, 1);
        n.keys.shadow = shadowKey;
      }
      n.shadow.position.set(0, centerY + sh.offsetY, -0.05);
      n.shadow.material.color.set(sh.color);
      n.shadow.material.opacity = sh.opacity * state.opacity;
    }

    // Selection outline around the whole window.
    const outlineKey = `${w}|${winH}`;
    if (n.keys.outline !== outlineKey) {
      n.outline.removeFromParent();
      n.outline.geometry.dispose();
      (n.outline.material as THREE.Material).dispose();
      n.outline = outlineFor(w, winH, centerY);
      n.group.add(n.outline);
      n.keys.outline = outlineKey;
    }
    n.outline.visible = opts.showHelpers && opts.selectedId === o.id;
  }

  private cursorImage(style: CursorStyle): CursorImage {
    let img = this.cursorImages.get(style);
    if (!img) {
      img = makeCursorTexture(style);
      this.cursorImages.set(style, img);
    }
    return img;
  }

  private syncText(o: TextObject, time: number, opts: SyncOptions, alive: Set<string>): void {
    alive.add(o.id);
    const key = `${o.text}|${o.size}|${o.color}|${o.weight}`;
    let n = this.nodes.get(o.id) as TextNode | undefined;
    if (!n || n.key !== key) {
      if (n) this.removeNode(o.id, n);
      const t = makeTextTexture(o.text, o.size, o.color, o.weight);
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(t.width, t.height),
        new THREE.MeshBasicMaterial({ map: t.texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      );
      mesh.renderOrder = 3;
      const outline = outlineFor(t.width, t.height);
      group.add(mesh, outline);
      this.scene.add(group);
      n = { kind: 'text', group, mesh, outline, key };
      this.nodes.set(o.id, n);
    }
    const state = evaluateTransform(o.transform, time);
    applyTransform(n.group, state);
    n.group.visible = o.visible && state.opacity > 0;
    setOpacity(n.mesh.material, state.opacity, true);
    n.outline.visible = opts.showHelpers && opts.selectedId === o.id;
  }

  private syncCursor(o: CursorObject, project: Project, time: number, alive: Set<string>): void {
    const target = this.nodes.get(o.targetId);
    const website = project.objects.find((x): x is WebsiteObject => x.id === o.targetId && x.kind === 'website');
    if (!target || target.kind !== 'website' || !website) return;
    alive.add(o.id);
    let n = this.nodes.get(o.id) as CursorNode | undefined;
    const key = `${o.size}|${o.style}`;
    if (!n || n.key !== key) {
      if (n) this.removeNode(o.id, n);
      // Geometry shifted so the style's click point (hotspot) is the origin.
      const img = this.cursorImage(o.style);
      const [hx, hy] = img.hotspot;
      const geo = new THREE.PlaneGeometry(o.size, o.size);
      geo.translate(o.size / 2 - hx * o.size, -o.size / 2 + hy * o.size, 0);
      const pointer = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ map: img.texture, transparent: true, depthWrite: false }),
      );
      pointer.renderOrder = 5;
      const ripple = new THREE.Mesh(
        new THREE.RingGeometry(o.size * 0.3, o.size * 0.4, 48),
        new THREE.MeshBasicMaterial({ color: '#3b82f6', transparent: true, depthWrite: false }),
      );
      ripple.renderOrder = 4;
      n = { kind: 'cursor', pointer, ripple, key };
      this.nodes.set(o.id, n);
    }
    // Keep the cursor attached to its panel (it may have been rebuilt).
    if (n.pointer.parent !== target.panel) target.panel.add(n.pointer, n.ripple);

    const [px, py] = sample(o.position, time);
    const x = (px / website.viewport.width - 0.5) * target.size.w;
    const y = (0.5 - py / website.viewport.height) * target.size.h;
    n.pointer.position.set(x, y, 0.02);
    n.pointer.visible = o.visible;
    n.pointer.material.opacity = (target.panel.material as THREE.MeshBasicMaterial).opacity;

    // Click ripple: purely a function of the time since the latest click.
    const last = eventsBetween(o.clicks, -Infinity, time).reduce<number | null>(
      (acc, c) => (acc === null || c.time > acc ? c.time : acc),
      null,
    );
    const age = last === null ? Infinity : time - last;
    n.ripple.visible = o.visible && age < RIPPLE_DURATION;
    if (n.ripple.visible) {
      const p = age / RIPPLE_DURATION;
      n.ripple.position.set(x, y, 0.01);
      n.ripple.scale.setScalar(0.4 + p * 1.6);
      n.ripple.material.opacity = 0.9 * (1 - p);
      n.ripple.material.color.set(o.clickColor);
    }
  }

  private removeNode(id: string, n: Node): void {
    const dispose = (o: THREE.Object3D) =>
      o.traverse((c) => {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) {
          c.geometry.dispose();
          const m = c.material as THREE.MeshBasicMaterial;
          const shared = [...this.cursorImages.values()].some((img) => img.texture === m.map);
          const live = [...this.websiteTextures.values()].includes(m.map as THREE.Texture);
          if (m.map && !live && !shared) m.map.dispose();
          m.alphaMap?.dispose();
          m.dispose();
        }
      });
    if (n.kind === 'cursor') {
      n.pointer.removeFromParent();
      n.ripple.removeFromParent();
      dispose(n.pointer);
      dispose(n.ripple);
    } else {
      // Detach cursors first so they survive a panel rebuild.
      if (n.kind === 'website') for (const c of n.panel.children.slice()) c.removeFromParent();
      n.group.removeFromParent();
      dispose(n.group);
    }
    this.nodes.delete(id);
  }
}
