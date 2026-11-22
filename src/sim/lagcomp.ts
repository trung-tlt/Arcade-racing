import type { V3 } from '../combat/AutoAim';

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Rotates (x, y, z) by the unit quaternion q (same arithmetic as THREE.Vector3.applyQuaternion). */
export function rotateBy(x: number, y: number, z: number, q: Quat, out: V3): V3 {
  const ix = q.w * x + q.y * z - q.z * y;
  const iy = q.w * y + q.z * x - q.x * z;
  const iz = q.w * z + q.x * y - q.y * x;
  const iw = -q.x * x - q.y * y - q.z * z;
  out.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
  out.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
  out.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
  return out;
}

const tmp: V3 = { x: 0, y: 0, z: 0 };
const o: V3 = { x: 0, y: 0, z: 0 };
const d: V3 = { x: 0, y: 0, z: 0 };

/**
 * Distance along a ray to an oriented box (centre `c` in world space, rotation `q`, half extents `h` along the box's
 * own axes), or null if it misses or is further than `maxT`. The slab method in the box's own frame.
 */
export function rayVsObb(
  origin: V3,
  dir: V3,
  c: V3,
  q: Quat,
  h: readonly [number, number, number],
  maxT: number,
): number | null {
  const inv: Quat = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
  rotateBy(origin.x - c.x, origin.y - c.y, origin.z - c.z, inv, o);
  rotateBy(dir.x, dir.y, dir.z, inv, d);
  let tMin = 0;
  let tMax = maxT;
  const ro = [o.x, o.y, o.z];
  const rd = [d.x, d.y, d.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(rd[i]) < 1e-9) {
      if (Math.abs(ro[i]) > h[i]) return null;
      continue;
    }
    let t1 = (-h[i] - ro[i]) / rd[i];
    let t2 = (h[i] - ro[i]) / rd[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  return tMin;
}

/** World-space centre of a car's collider box at body pose (p, q). */
export function boxCentre(p: V3, q: Quat, localCentre: readonly [number, number, number], out: V3 = tmp): V3 {
  rotateBy(localCentre[0], localCentre[1], localCentre[2], q, out);
  out.x += p.x;
  out.y += p.y;
  out.z += p.z;
  return out;
}

/** Normalised lerp of two unit quaternions (shorter arc), written into `out`. */
export function nlerpQuat(a: Quat, b: Quat, k: number, out: Quat): Quat {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = dot < 0 ? -1 : 1;
  const x = a.x + (s * b.x - a.x) * k;
  const y = a.y + (s * b.y - a.y) * k;
  const z = a.z + (s * b.z - a.z) * k;
  const w = a.w + (s * b.w - a.w) * k;
  const len = Math.hypot(x, y, z, w) || 1;
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  out.w = w / len;
  return out;
}

/** A fixed ring of one car's poses by tick (no allocation after construction). */
export class PoseHistory {
  private readonly buf: Float64Array;
  private readonly keys: Int32Array;

  constructor(private readonly size: number) {
    this.buf = new Float64Array(size * 7);
    this.keys = new Int32Array(size).fill(-1);
  }

  /** Remember the pose reached at tick count `key`. */
  record(key: number, p: V3, q: Quat): void {
    const i = key % this.size;
    const o7 = i * 7;
    this.buf[o7] = p.x;
    this.buf[o7 + 1] = p.y;
    this.buf[o7 + 2] = p.z;
    this.buf[o7 + 3] = q.x;
    this.buf[o7 + 4] = q.y;
    this.buf[o7 + 5] = q.z;
    this.buf[o7 + 6] = q.w;
    this.keys[i] = key;
  }

  has(key: number): boolean {
    return key >= 0 && this.keys[key % this.size] === key;
  }

  /** Read the pose at `key` into p/q; false if it has been overwritten or never recorded. */
  read(key: number, p: V3, q: Quat): boolean {
    if (!this.has(key)) return false;
    const o7 = (key % this.size) * 7;
    p.x = this.buf[o7];
    p.y = this.buf[o7 + 1];
    p.z = this.buf[o7 + 2];
    q.x = this.buf[o7 + 3];
    q.y = this.buf[o7 + 4];
    q.z = this.buf[o7 + 5];
    q.w = this.buf[o7 + 6];
    return true;
  }
}
