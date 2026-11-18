import * as THREE from 'three';
import type { TrackSampler } from '../race/Respawn';

/** Closed Catmull-Rom centreline with arc-length samples for fast projection. t ∈ [0,1) from the start line. */
export class TrackPath implements TrackSampler {
  readonly curve: THREE.CatmullRomCurve3;
  readonly lengthM: number;
  readonly count: number;
  /** Per-sample centre (x,z) and unit tangent (x,z); y is always the curve's y. */
  readonly px: Float32Array;
  readonly pz: Float32Array;
  /** Per-sample road height (spline Y). */
  readonly py: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  private readonly tmp = new THREE.Vector3();

  constructor(
    points: readonly (readonly number[])[],
    spacingM: number,
    private readonly searchWindow: number,
  ) {
    this.curve = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
      true,
      'catmullrom',
      0.5,
    );
    // A relaxed path is thousands of control points: keep the arc-length table as fine as the curve itself.
    this.curve.arcLengthDivisions = Math.max(200, points.length * 4);
    this.lengthM = this.curve.getLength();
    this.count = Math.ceil(this.lengthM / spacingM);
    this.px = new Float32Array(this.count);
    this.pz = new Float32Array(this.count);
    this.py = new Float32Array(this.count);
    this.tx = new Float32Array(this.count);
    this.tz = new Float32Array(this.count);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    for (let i = 0; i < this.count; i++) {
      this.curve.getPointAt(i / this.count, p);
      this.curve.getTangentAt(i / this.count, t);
      this.px[i] = p.x;
      this.pz[i] = p.z;
      this.py[i] = p.y;
      const h = Math.hypot(t.x, t.z) || 1;
      this.tx[i] = t.x / h;
      this.tz[i] = t.z / h;
    }
  }

  /** Road height at along-track t (linear between samples). */
  yAt(t: number): number {
    const f = this.wrap(t) * this.count;
    const i = Math.floor(f) % this.count;
    const k = f - Math.floor(f);
    return this.py[i] + (this.py[(i + 1) % this.count] - this.py[i]) * k;
  }

  get spacingM(): number {
    return this.lengthM / this.count;
  }

  private wrap(t: number): number {
    return ((t % 1) + 1) % 1;
  }

  pointAt(t: number): { x: number; y: number; z: number } {
    this.curve.getPointAt(this.wrap(t), this.tmp);
    return { x: this.tmp.x, y: this.tmp.y, z: this.tmp.z };
  }

  tangentAt(t: number): { x: number; y: number; z: number } {
    this.curve.getTangentAt(this.wrap(t), this.tmp);
    return { x: this.tmp.x, y: this.tmp.y, z: this.tmp.z };
  }

  /** Nearest along-track position to (x,z). With a hint only a window of samples is searched. */
  project(x: number, z: number, hintT?: number): number {
    const n = this.count;
    let from = 0;
    let span = n;
    if (hintT !== undefined) {
      from = Math.floor(this.wrap(hintT) * n) - this.searchWindow;
      span = this.searchWindow * 2 + 1;
    }
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < span; k++) {
      const i = (((from + k) % n) + n) % n;
      const dx = x - this.px[i];
      const dz = z - this.pz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // Refine on the two neighbouring segments so t advances smoothly between samples.
    const seg = (a: number): { s: number; d: number } => {
      const b = (a + 1) % n;
      const sx = this.px[b] - this.px[a];
      const sz = this.pz[b] - this.pz[a];
      const l2 = sx * sx + sz * sz || 1;
      const s = Math.min(1, Math.max(0, ((x - this.px[a]) * sx + (z - this.pz[a]) * sz) / l2));
      const dx = x - (this.px[a] + sx * s);
      const dz = z - (this.pz[a] + sz * s);
      return { s, d: dx * dx + dz * dz };
    };
    const prev = (best - 1 + n) % n;
    const a = seg(prev);
    const b = seg(best);
    return a.d < b.d ? this.wrap((prev + a.s) / n) : this.wrap((best + b.s) / n);
  }
}
