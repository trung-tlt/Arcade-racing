import type { CorridorPath } from '../world/Corridor';

// Cong Hoa Boulevard's ambient-traffic planning and road maths, shared by the browser's scenery and the headless sim.

export interface V2 {
  x: number;
  z: number;
}

/** Left of a heading: +X is left for something facing +Z (matches Track.left). */
export function leftOfHeading(tx: number, tz: number): V2 {
  return { x: tz, z: -tx };
}

/** Right of a heading (the side traffic drives on). */
export function rightOfHeading(tx: number, tz: number): V2 {
  return { x: -tz, z: tx };
}

/** Distance from the racing line (carriageway centre) to the centre of the rightmost lane. */
export function rightLaneOffsetM(roadWidthM: number, lanesPerDirection: number): number {
  return roadWidthM / 2 - roadWidthM / lanesPerDirection / 2;
}

/** Small deterministic PRNG (mulberry32). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PathSample {
  x: number;
  z: number;
  tx: number;
  tz: number;
}

/** Interpolated centre line at loop position t ∈ [0,1) without allocating (fills `out`). */
export function sampleAt(path: CorridorPath, t: number, out: PathSample): PathSample {
  const n = path.count;
  const f = (((t % 1) + 1) % 1) * n;
  const i = Math.floor(f) % n;
  const j = (i + 1) % n;
  const k = f - Math.floor(f);
  out.x = path.px[i] + (path.px[j] - path.px[i]) * k;
  out.z = path.pz[i] + (path.pz[j] - path.pz[i]) * k;
  const tx = path.tx[i] + (path.tx[j] - path.tx[i]) * k;
  const tz = path.tz[i] + (path.tz[j] - path.tz[i]) * k;
  const h = Math.hypot(tx, tz) || 1;
  out.tx = tx / h;
  out.tz = tz / h;
  return out;
}

// --- ambient traffic ---------------------------------------------------------------------------

export interface TrafficKind {
  key: string;
  count: number;
  /** Model files; a kind with none is skipped (no art is invented). */
  models: readonly string[];
  /** Collider half extents (x, y, z) in metres. */
  half: readonly [number, number, number];
}

export interface TrafficSpec {
  kind: number;
  model: number;
  /** Start position along the lap, 0..1. */
  phase: number;
  speedMps: number;
  /** Lateral jitter in metres (+ = further right). */
  jitterM: number;
  /** Per-instance brightness variety. */
  tint: number;
}

/** Evenly spread phases with random offsets, kept out of the starting grid; fully determined by `seed`. */
export function trafficPlan(
  kind: number,
  count: number,
  models: number,
  seed: number,
  speedKmh: readonly [number, number],
  lapLengthM: number,
  avoid: { behindLineM: number; aheadOfLineM: number },
): TrafficSpec[] {
  const rng = seededRng(seed + kind * 7919);
  const lo = (1 - avoid.behindLineM / lapLengthM + 1) % 1; // start of the keep-out zone (just before the line)
  const hi = avoid.aheadOfLineM / lapLengthM; // end of it (just after the line)
  const inZone = (p: number): boolean => p >= lo || p <= hi;
  const out: TrafficSpec[] = [];
  for (let k = 0; k < count; k++) {
    let phase = (k + rng() * 0.8) / count;
    for (let guard = 0; inZone(phase) && guard < 20; guard++) phase = (phase + (hi + 1 - lo) / 2 + 0.013) % 1;
    out.push({
      kind,
      model: models > 0 ? Math.floor(rng() * models) : 0,
      phase,
      speedMps: (speedKmh[0] + rng() * (speedKmh[1] - speedKmh[0])) / 3.6,
      jitterM: (rng() - 0.5) * 0.8,
      tint: 0.85 + rng() * 0.15,
    });
  }
  return out;
}

/** Position along the lap of a traffic participant after `timeSec`. */
export function trafficT(spec: TrafficSpec, timeSec: number, lapLengthM: number): number {
  return (spec.phase + (spec.speedMps * timeSec) / lapLengthM) % 1;
}
