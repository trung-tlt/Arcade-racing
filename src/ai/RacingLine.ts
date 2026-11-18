export interface PathSampler {
  readonly lengthM: number;
  pointAt(t: number): { x: number; y: number; z: number };
  tangentAt(t: number): { x: number; y: number; z: number };
  project(x: number, z: number, hintT?: number): number;
}

const wrap01 = (t: number): number => ((t % 1) + 1) % 1;
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
/** Half-width (in samples) of the box filter that smooths raw curvature. */
const SMOOTH = 2;

/** Centreline + precomputed curvature: lookahead targets and corner-speed limits for AI drivers. */
export class RacingLine {
  private readonly n: number;
  private readonly spacing: number;
  private readonly k: Float32Array;

  constructor(
    private readonly path: PathSampler,
    sampleSpacingM: number,
  ) {
    this.n = Math.max(8, Math.ceil(path.lengthM / sampleSpacingM));
    this.spacing = path.lengthM / this.n;
    const h = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const tg = path.tangentAt(i / this.n);
      h[i] = Math.atan2(tg.x, tg.z);
    }
    const raw = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const d = wrapAngle(h[(i + 1) % this.n] - h[(i - 1 + this.n) % this.n]);
      raw[i] = Math.abs(d) / (2 * this.spacing);
    }
    this.k = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      let s = 0;
      for (let j = -SMOOTH; j <= SMOOTH; j++) s += raw[(i + j + this.n) % this.n];
      this.k[i] = s / (2 * SMOOTH + 1);
    }
  }

  private index(t: number): number {
    return Math.floor(wrap01(t) * this.n) % this.n;
  }

  /** Unsigned curvature (1/m) at along-track position t. */
  get lengthM(): number {
    return this.path.lengthM;
  }

  curvatureAt(t: number): number {
    return this.k[this.index(t)];
  }

  /** Centreline point `lookaheadM` ahead of t, shifted `laneOffsetM` to the car's left (left = (tz,0,-tx)). */
  targetPoint(t: number, lookaheadM: number, laneOffsetM: number): { x: number; z: number } {
    const tt = wrap01(t + lookaheadM / this.path.lengthM);
    const p = this.path.pointAt(tt);
    const tg = this.path.tangentAt(tt);
    const h = Math.hypot(tg.x, tg.z) || 1;
    return { x: p.x + (tg.z / h) * laneOffsetM, z: p.z - (tg.x / h) * laneOffsetM };
  }

  /** Slowest safe speed over the next `aheadM` metres: min of sqrt(a / |k|). 1000 on dead-straight road. */
  maxCornerSpeed(t: number, aheadM: number, maxLatAccel: number): number {
    const steps = Math.max(1, Math.ceil(aheadM / this.spacing));
    const i0 = this.index(t);
    let v = 1000;
    for (let s = 0; s <= steps; s++) {
      const k = this.k[(i0 + s) % this.n];
      if (k > 1e-6) v = Math.min(v, Math.sqrt(maxLatAccel / k));
    }
    return v;
  }
}
