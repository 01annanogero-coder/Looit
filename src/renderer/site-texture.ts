// Turns BGRA website frames from the main process into a Three.js texture.

import * as THREE from 'three';
import type { SiteFrame } from '../shared/ipc';

export class SiteTexture {
  texture: THREE.Texture | null = null;
  private rgba: Uint8Array = new Uint8Array(0);
  private bitmapTexture: THREE.Texture | null = null;

  /**
   * Shows an already-decoded frame (export path). The bitmap must be decoded
   * with imageOrientation 'flipY'. Returns true if the texture object changed.
   */
  updateBitmap(bitmap: ImageBitmap): boolean {
    let created = false;
    if (!this.bitmapTexture) {
      this.bitmapTexture = new THREE.Texture(bitmap);
      this.bitmapTexture.colorSpace = THREE.SRGBColorSpace;
      this.bitmapTexture.flipY = false;
      this.bitmapTexture.minFilter = THREE.LinearMipmapLinearFilter;
      this.bitmapTexture.magFilter = THREE.LinearFilter;
      this.bitmapTexture.anisotropy = 8;
      created = true;
    } else {
      const old = this.bitmapTexture.image as ImageBitmap;
      this.bitmapTexture.image = bitmap;
      // Different size: three.js must reallocate the GPU texture.
      if (old.width !== bitmap.width || old.height !== bitmap.height) {
        this.bitmapTexture.dispose();
      }
      old.close();
    }
    this.bitmapTexture.needsUpdate = true;
    if (this.texture !== this.bitmapTexture) {
      this.texture = this.bitmapTexture;
      created = true;
    }
    return created;
  }

  /** Returns true if a new texture object was created (size changed). */
  update(frame: SiteFrame): boolean {
    const { width, height } = frame;
    let created = false;
    const current = this.texture instanceof THREE.DataTexture ? this.texture : null;
    if (!current || current.image.width !== width || current.image.height !== height) {
      current?.dispose();
      this.rgba = new Uint8Array(width * height * 4);
      const tex = new THREE.DataTexture(this.rgba, width, height, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = 8;
      this.texture = tex;
      created = true;
    } else if (this.texture !== current) {
      this.texture = current;
      created = true;
    }
    convertBgraTopDownToRgbaBottomUp(frame.data, this.rgba, width, height);
    this.texture.needsUpdate = true;
    return created;
  }
}

/**
 * Swaps B/R channels and flips rows so row 0 is the bottom of the image, which
 * is what WebGL texture coordinates expect.
 */
export function convertBgraTopDownToRgbaBottomUp(
  src: Uint8Array,
  dst: Uint8Array,
  width: number,
  height: number,
): void {
  if (src.byteLength < width * height * 4) throw new Error('Website frame is smaller than its reported size.');
  // Uint32Array views need 4-byte alignment; copy if IPC handed us an unaligned view.
  const aligned = src.byteOffset % 4 === 0 ? src : src.slice();
  const s = new Uint32Array(aligned.buffer, aligned.byteOffset, width * height);
  const d = new Uint32Array(dst.buffer, dst.byteOffset, width * height);
  for (let y = 0; y < height; y++) {
    const so = y * width;
    const dOff = (height - 1 - y) * width;
    for (let x = 0; x < width; x++) {
      const p = s[so + x];
      // Little-endian: BGRA bytes read as 0xAARRGGBB; RGBA bytes need 0xAABBGGRR.
      d[dOff + x] = (p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff);
    }
  }
}
