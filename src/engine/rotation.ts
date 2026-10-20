// Rotation helpers. Gizmos produce orientations, but projects store Euler
// degrees that get interpolated component by component, so the stored angles
// must stay continuous with what the user had before (no sudden 360° or
// equivalent-Euler jumps that would make keyframes spin the long way round).

import type { Vec3 } from './animation';

function unwrap(angle: number, near: number): number {
  return angle + 360 * Math.round((near - angle) / 360);
}

function distance(a: Vec3, b: Vec3): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/**
 * Of all XYZ Euler angle sets describing the same orientation as `deg`,
 * returns the one closest to `previous`.
 */
export function closestEuler(deg: Vec3, previous: Vec3): Vec3 {
  // (x, y, z) and (x + 180, 180 - y, z + 180) are the same XYZ orientation.
  const candidates: Vec3[] = [deg, [deg[0] + 180, 180 - deg[1], deg[2] + 180]];
  let best: Vec3 = deg;
  let bestDist = Infinity;
  for (const c of candidates) {
    const u: Vec3 = [unwrap(c[0], previous[0]), unwrap(c[1], previous[1]), unwrap(c[2], previous[2])];
    const d = distance(u, previous);
    if (d < bestDist) {
      best = u;
      bestDist = d;
    }
  }
  return best.map((v) => Math.round(v * 1000) / 1000) as Vec3;
}
