import type { V3 } from './AutoAim';

/** Rotate unit vector `dir` toward `toTarget` by at most `maxTurnRad`; returns a unit vector. */
export function homingStep(dir: V3, toTarget: V3, maxTurnRad: number): V3 {
  const len = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
  if (len < 1e-9) return { ...dir };
  const tx = toTarget.x / len;
  const ty = toTarget.y / len;
  const tz = toTarget.z / len;
  const dot = Math.min(1, Math.max(-1, dir.x * tx + dir.y * ty + dir.z * tz));
  const angle = Math.acos(dot);
  if (angle <= maxTurnRad) return { x: tx, y: ty, z: tz };

  // Component of the target perpendicular to dir gives the rotation plane.
  let px = tx - dir.x * dot;
  let py = ty - dir.y * dot;
  let pz = tz - dir.z * dot;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-9) {
    // Directly opposite: pick any perpendicular axis.
    px = Math.abs(dir.x) < 0.9 ? 1 : 0;
    py = Math.abs(dir.x) < 0.9 ? 0 : 1;
    pz = 0;
    const d = px * dir.x + py * dir.y + pz * dir.z;
    px -= dir.x * d;
    py -= dir.y * d;
    pz -= dir.z * d;
    pl = Math.hypot(px, py, pz);
  }
  px /= pl;
  py /= pl;
  pz /= pl;
  const c = Math.cos(maxTurnRad);
  const s = Math.sin(maxTurnRad);
  return { x: dir.x * c + px * s, y: dir.y * c + py * s, z: dir.z * c + pz * s };
}

/** Linear falloff from full damage at the centre to 0 at `radius`; 0 outside. */
export function splashDamage(baseDamage: number, dist: number, radius: number): number {
  if (dist >= radius || radius <= 0) return 0;
  return baseDamage * (1 - Math.max(0, dist) / radius);
}

export class RocketAmmo {
  count = 0;

  add(n: number): void {
    this.count += n;
  }

  consume(): boolean {
    if (this.count <= 0) return false;
    this.count--;
    return true;
  }
}
