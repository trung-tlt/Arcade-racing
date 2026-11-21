import type { TrackDef } from '../core/Data';

// Ambient-traffic planning and road maths shared by the browser's traffic scenery and the headless sim (no DOM / GL).

export const KIND = { trucks: 0, cars: 1, buses: 2, scooters: 3 } as const;
export type KindKey = keyof typeof KIND;
export const KIND_KEYS: readonly KindKey[] = ['trucks', 'cars', 'buses', 'scooters'];

/** Traffic keeps clear of the start grid: from this far before the line to this far after it (as on Map 2). */
export const KEEP_OUT_BEHIND_LINE_M = 130;
export const KEEP_OUT_AHEAD_OF_LINE_M = 30;
/** The bridge crest launches cars (t ≈ 0.03–0.07): nothing is created there at t = 0. */
export const CREST_FROM_T = 0.025;
export const CREST_TO_T = 0.16; // bridge + descent: no slow bus waiting at the foot of the bridge in the opening seconds
/** Where the carriageway narrows to the frontage road the width blends in over this distance (inside the section). */
export const WIDTH_BLEND_M = 25;
/** Ambient vehicles further than this from the player are not drawn (dusk fog already hazes them out). */
export const TRAFFIC_DRAW_RADIUS_M = 300;

// ---------------------------------------------------------------------------------------------
// Pure helpers (no DOM / GL): all the numbers live here so they can be unit tested.
// ---------------------------------------------------------------------------------------------

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

/** Right of a heading (the side traffic drives on): left = (tz, −tx), so right = (−tz, tx). */
export function rightOfHeading(tx: number, tz: number): { x: number; z: number } {
  return { x: -tz, z: tx };
}

/** Anything shaped like TrackPath's sample arrays. */
export interface RoadPath {
  readonly count: number;
  readonly lengthM: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
}

export interface RoadSample {
  x: number;
  /** Road height. */
  y: number;
  z: number;
  /** Unit horizontal heading. */
  tx: number;
  tz: number;
  /** Rise over horizontal run (dy / dxz) along the heading. */
  slope: number;
}

/** Interpolated centre line, height and slope at loop position t ∈ [0,1) without allocating (fills `out`). */
export function sampleRoad(path: RoadPath, t: number, out: RoadSample): RoadSample {
  const n = path.count;
  const f = (((t % 1) + 1) % 1) * n;
  const i = Math.floor(f) % n;
  const j = (i + 1) % n;
  const k = f - Math.floor(f);
  out.x = path.px[i] + (path.px[j] - path.px[i]) * k;
  out.y = path.py[i] + (path.py[j] - path.py[i]) * k;
  out.z = path.pz[i] + (path.pz[j] - path.pz[i]) * k;
  const tx = path.tx[i] + (path.tx[j] - path.tx[i]) * k;
  const tz = path.tz[i] + (path.tz[j] - path.tz[i]) * k;
  const h = Math.hypot(tx, tz) || 1;
  out.tx = tx / h;
  out.tz = tz / h;
  const run = Math.hypot(path.px[j] - path.px[i], path.pz[j] - path.pz[i]) || 1;
  out.slope = (path.py[j] - path.py[i]) / run;
  return out;
}

/** Nose-up pitch (radians) of a vehicle on a road that rises `slope` metres per horizontal metre. */
export function pitchFromSlope(slope: number): number {
  return Math.atan(slope);
}

/** Shape of what the width / lane helpers need from a TrackDef. */
export interface RoadProfile {
  roadWidthM: number;
  lapLengthM: number;
  widthProfile: readonly { fromT: number; toT: number; widthM: number }[];
  /** Lanes across the main carriageway / across the frontage road. */
  mainLanes: number;
  frontageLanes: number;
}

/** Weight 0..1 of the frontage profile at t: 0 on the main carriageway, 1 once `blendM` inside the section. */
export function frontageWeight(profile: RoadProfile, t: number): number {
  for (const p of profile.widthProfile) {
    if (t < p.fromT || t > p.toT) continue;
    const blend = WIDTH_BLEND_M / profile.lapLengthM;
    return Math.min(1, Math.max(0, Math.min(t - p.fromT, p.toT - t) / blend));
  }
  return 0;
}

/** Carriageway width at t (blends from the main width to the frontage width over WIDTH_BLEND_M). */
export function roadWidthAt(profile: RoadProfile, t: number): number {
  const p = profile.widthProfile.find((x) => t >= x.fromT && t <= x.toT);
  if (!p) return profile.roadWidthM;
  const w = frontageWeight(profile, t);
  return profile.roadWidthM + (p.widthM - profile.roadWidthM) * w;
}

/**
 * Lateral offset (metres, + = to the vehicle's right) of the centre of lane `lane` counted from the right edge
 * (0 = rightmost). Uses the actual width and lane count at t, so a car in lane 2 of 4 slides into lane 1 of 2 on the
 * frontage road.
 */
export function laneOffsetAt(profile: RoadProfile, t: number, lane: number): number {
  const w = frontageWeight(profile, t);
  const width = roadWidthAt(profile, t);
  const frontW = profile.widthProfile.find((x) => t >= x.fromT && t <= x.toT)?.widthM ?? profile.roadWidthM;
  const laneW = (profile.roadWidthM / profile.mainLanes) * (1 - w) + (frontW / profile.frontageLanes) * w;
  const laneEff = lane * (1 - w) + Math.min(lane, profile.frontageLanes - 1) * w;
  return width / 2 - laneW * (laneEff + 0.5);
}

export interface TrafficSpec {
  /** Index into KIND_KEYS. */
  kind: number;
  /** Index into that kind's model list. */
  model: number;
  /** Start position: along the whole lap (0..1), or along the frontage section (0..1) for scooters. */
  phase: number;
  speedMps: number;
  /** Lane from the right edge (0 = rightmost). */
  lane: number;
  /** Lateral jitter in metres (+ = further right). */
  jitterM: number;
  /** Per-instance brightness variety. */
  tint: number;
  /** True when the vehicle loops inside the frontage section instead of the whole lap. */
  inSection: boolean;
}

export interface PlanOptions {
  seed: number;
  lapLengthM: number;
  speedKmh: readonly [number, number];
  /** Frontage section bounds (t); scooters loop inside it. */
  section: { fromT: number; toT: number } | null;
}

/** Keep-out zones (t ranges) for whole-lap vehicles at t = 0: the start grid and the bridge crest. */
export function keepOutZones(lapLengthM: number): { from: number; to: number }[] {
  const behind = 1 - KEEP_OUT_BEHIND_LINE_M / lapLengthM;
  const ahead = KEEP_OUT_AHEAD_OF_LINE_M / lapLengthM;
  return [
    { from: behind, to: 1 },
    { from: 0, to: ahead },
    { from: CREST_FROM_T, to: CREST_TO_T },
  ];
}

const inAnyZone = (p: number, zones: readonly { from: number; to: number }[]): boolean =>
  zones.some((z) => p >= z.from && p <= z.to);

/** Which lane a kind prefers (from the right): trucks, buses and scooters in the rightmost lane, cars in lane 1 or 2. */
function laneFor(kind: KindKey, rng: () => number): number {
  return kind === 'cars' ? 1 + Math.floor(rng() * 2) : 0;
}

/**
 * Deterministic plan for one kind. Whole-lap vehicles get evenly spread phases (kept out of the start grid and the
 * crest); scooters get phases inside the frontage section.
 */
export function trafficPlan(kind: KindKey, count: number, models: number, opts: PlanOptions): TrafficSpec[] {
  const ki = KIND[kind];
  const rng = seededRng(opts.seed + ki * 7919);
  const zones = keepOutZones(opts.lapLengthM);
  const inSection = kind === 'scooters' && opts.section !== null;
  const out: TrafficSpec[] = [];
  for (let k = 0; k < count; k++) {
    let phase = (k + rng() * 0.8) / Math.max(1, count);
    if (!inSection) {
      for (let guard = 0; inAnyZone(phase, zones) && guard < 400; guard++) phase = (phase + 0.0137) % 1;
    }
    out.push({
      kind: ki,
      model: models > 0 ? Math.floor(rng() * models) : 0,
      phase,
      speedMps: (opts.speedKmh[0] + rng() * (opts.speedKmh[1] - opts.speedKmh[0])) / 3.6,
      lane: laneFor(kind, rng),
      jitterM: (rng() - 0.5) * 0.6,
      tint: 0.8 + rng() * 0.2,
      inSection,
    });
  }
  return out;
}

/** Loop position (0..1 of the lap) of a traffic participant after `timeSec`. */
export function trafficT(
  spec: TrafficSpec,
  timeSec: number,
  lapLengthM: number,
  section: { fromT: number; toT: number } | null,
): number {
  const dist = spec.speedMps * timeSec;
  if (spec.inSection && section) {
    const span = section.toT - section.fromT;
    // Wrap inside the section: phase and distance are fractions of the section's own length.
    const frac = (spec.phase + dist / (span * lapLengthM)) % 1;
    return section.fromT + frac * span;
  }
  return (spec.phase + dist / lapLengthM) % 1;
}

export interface RawXaLo {
  roadLayout: {
    mainCarriageway: { widthM: number; lanes: number };
    frontageRoad: { widthM: number; lanes: number };
  };
  sections: { id: string; name: string; fromT: number; toT: number }[];
  ambientTraffic: {
    trucks: number;
    cars: number;
    buses: number;
    scooters: number;
    speedKmh: [number, number];
    models: Record<KindKey, string[]>;
    vehicleSizesM: {
      truck: [number, number, number];
      car: [number, number, number];
      bus: [number, number, number];
      scooter: [number, number, number];
    };
  };
}

/** Section whose lap fraction the frontage scooters loop in (the data's "frontage" section). */
export function frontageSection(raw: Pick<RawXaLo, 'sections'>): { fromT: number; toT: number } | null {
  const s = raw.sections.find((x) => /frontage/i.test(x.name)) ?? raw.sections.find((x) => x.id === 'F');
  return s ? { fromT: s.fromT, toT: s.toT } : null;
}

export function roadProfileOf(track: TrackDef): RoadProfile {
  const raw = track.raw as unknown as RawXaLo;
  return {
    roadWidthM: track.roadWidthM,
    lapLengthM: track.lapLengthM,
    widthProfile: track.widthProfile,
    mainLanes: raw.roadLayout?.mainCarriageway?.lanes ?? 4,
    frontageLanes: raw.roadLayout?.frontageRoad?.lanes ?? 2,
  };
}

export const SIZE_KEY: Record<KindKey, 'truck' | 'car' | 'bus' | 'scooter'> = {
  trucks: 'truck',
  cars: 'car',
  buses: 'bus',
  scooters: 'scooter',
};
export const PLAN_SEED = 1978;
