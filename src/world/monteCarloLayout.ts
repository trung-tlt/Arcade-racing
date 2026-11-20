import type { TrackDef } from '../core/Data';
import { seededRng } from './CongHoaDressing';
import type { TrackPath } from './TrackPath';

/**
 * Pure layout planning for Map 5 (Monte-Carlo Harbour): where every barrier, kerb, building, palm and terrain vertex goes.
 * No DOM, no three.js scene, no assets: deterministic (seeded) and unit tested. Positions are metres in world space,
 * `yaw` rotates about +Y like three's `rotation.y` (0 faces +Z; +X maps to (cos yaw, 0, -sin yaw)).
 */

/** Spacing of the instanced linear pieces (Armco, fence, kerb, tyre wall are all 4 m long). */
export const PIECE_M = 4;
/** Half the carriageway (12 m). */
export const HALF_ROAD_M = 6;
/** Where the quay ends and the harbour begins, measured from the centre line on the harbour side. */
export const QUAY_EDGE_M = 12;
/** Fraction of the lap (t) between which the harbour is on the driver's left. */
export const HARBOUR_T: readonly [number, number] = [0.44, 0.87];

export interface Frame {
  x: number;
  y: number;
  z: number;
  /** Unit tangent (x, z). */
  tx: number;
  tz: number;
  /** Unit vector to the car's left (x, z): (tz, -tx). */
  lx: number;
  lz: number;
}

export function frameAt(path: TrackPath, t: number): Frame {
  const p = path.pointAt(t);
  const tg = path.tangentAt(t);
  const h = Math.hypot(tg.x, tg.z) || 1;
  const tx = tg.x / h;
  const tz = tg.z / h;
  return { x: p.x, y: p.y, z: p.z, tx, tz, lx: tz, lz: -tx };
}

const wrap01 = (t: number): number => ((t % 1) + 1) % 1;

/** Signed curvature (1/m) at distance `s` along the lap: > 0 = turning left. */
export function curvatureAt(path: TrackPath, s: number): number {
  const len = path.lengthM;
  const d = 3;
  const a = frameAt(path, wrap01((s - d) / len));
  const b = frameAt(path, wrap01((s + d) / len));
  const lx = (a.lx + b.lx) / 2;
  const lz = (a.lz + b.lz) / 2;
  return ((b.tx - a.tx) * lx + (b.tz - a.tz) * lz) / (2 * d);
}

/** Yaw that turns a model's local +X to the world direction (dx, dz). */
export const yawForX = (dx: number, dz: number): number => Math.atan2(-dz, dx);
/** Yaw that turns a model's local +Z to the world direction (dx, dz). */
export const yawForZ = (dx: number, dz: number): number => Math.atan2(dx, dz);

export interface Piece {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Which sponsor panel (0..3) an Armco piece carries; -1 = plain. */
  ad: number;
}

export interface Obstacle {
  x: number;
  z: number;
  r: number;
}

export interface TunnelRange {
  fromT: number;
  toT: number;
}

/** Tunnel stretch from the track JSON (`tunnel.fromT/toT`), or null on maps without one. */
export function tunnelRange(def: TrackDef): TunnelRange | null {
  const tn = def.raw.tunnel as { fromT: number; toT: number } | undefined;
  return tn ? { fromT: tn.fromT, toT: tn.toT } : null;
}

export const inRange = (r: TunnelRange | null, t: number, margin = 0): boolean =>
  !!r && wrap01(t) >= r.fromT - margin && wrap01(t) <= r.toT + margin;

/** One of the 4 m linear pieces along one side of the road. `side`: +1 = left, -1 = right. */
function sidePiece(path: TrackPath, s: number, side: number, lateral: number): Piece {
  const f = frameAt(path, wrap01(s / path.lengthM));
  // +X faces the road: inward = -side * left.
  const dx = -side * f.lx;
  const dz = -side * f.lz;
  return {
    x: f.x + side * f.lx * lateral,
    y: f.y,
    z: f.z + side * f.lz * lateral,
    yaw: yawForX(dx, dz),
    ad: -1,
  };
}

export interface TyreWallDef {
  s: number;
  t: number;
  side: string;
  count: number;
}

export interface BarrierPlan {
  armco: Piece[];
  fence: Piece[];
  tyres: Piece[];
}

/**
 * Armco on both sides of the whole lap (every 4 m), a catch fence behind it, tyre stacks at the outside of the slow
 * corners. No barrier model in the tunnel (its walls are the barrier). `armco.adEvery`-th piece carries a sponsor panel.
 */
export function planBarriers(path: TrackPath, def: TrackDef, stands: readonly Obstacle[]): BarrierPlan {
  const b = def.raw.barriers as {
    armco: { lateralM: number; adEvery: number; adModels: string[] };
    catchFence: { lateralM: number };
    tyreWalls: TyreWallDef[];
  };
  const tunnel = tunnelRange(def);
  const len = path.lengthM;
  const n = Math.floor(len / PIECE_M);
  const tyreSpans: { side: number; from: number; to: number }[] = [];
  const tyres: Piece[] = [];
  for (const w of b.tyreWalls) {
    // "outside" = the side opposite to the turn.
    const outside = curvatureAt(path, w.s) > 0 ? -1 : 1;
    const start = w.s - (w.count * PIECE_M) / 2;
    tyreSpans.push({ side: outside, from: start, to: start + w.count * PIECE_M });
    for (let k = 0; k < w.count; k++) {
      // Inner face (the model's +X side) at 6.5 m: flush with the Armco it replaces.
      const piece = sidePiece(path, start + (k + 0.5) * PIECE_M, outside, b.armco.lateralM - 0.2);
      tyres.push(piece);
    }
  }
  const armco: Piece[] = [];
  const fence: Piece[] = [];
  const ads = b.armco.adModels.length;
  for (let side = 1; side >= -1; side -= 2) {
    for (let j = 0; j < n; j++) {
      const s = (j + 0.5) * PIECE_M;
      if (inRange(tunnel, s / len, 0.0008)) continue;
      if (tyreSpans.some((w) => w.side === side && s >= w.from && s <= w.to)) continue;
      const a = sidePiece(path, s, side, b.armco.lateralM);
      if (b.armco.adEvery > 0 && j % b.armco.adEvery === 0) a.ad = Math.floor(j / b.armco.adEvery) % ads;
      armco.push(a);
      if (stands.some((o) => Math.hypot(o.x - a.x, o.z - a.z) < o.r)) continue;
      fence.push(sidePiece(path, s, side, b.catchFence.lateralM));
    }
  }
  return { armco, fence, tyres };
}

interface CornerDef {
  id: string;
  t: number;
}

/** Red/white kerbs on the inside of every corner from turn-in to apex and on the outside of the exit. */
export function planKerbs(path: TrackPath, def: TrackDef): Piece[] {
  const corners = (def.raw.corners as CornerDef[] | undefined) ?? [];
  const len = path.lengthM;
  const out: Piece[] = [];
  const seen = new Set<number>();
  const minK = 1 / 260;
  for (const c of corners) {
    const apex = c.t * len;
    for (let s = apex - 48; s <= apex + 36; s += PIECE_M) {
      const key = Math.round(s / PIECE_M);
      const k = curvatureAt(path, s);
      if (Math.abs(k) < minK) continue;
      // Inside of the turn up to the apex, outside of it on the way out.
      const inside = s <= apex + 8;
      const side = (k > 0 ? 1 : -1) * (inside ? 1 : -1);
      const id = key * 2 + (side > 0 ? 1 : 0);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(sidePiece(path, s, side, HALF_ROAD_M - 0.55));
    }
  }
  return out;
}

export interface Footprint {
  x: number;
  z: number;
  yaw: number;
  /** Half extents across the facade (local X) and in depth (local Z). */
  hw: number;
  hd: number;
}

/** Separating-axis overlap test of two oriented rectangles with a margin. */
export function footprintsOverlap(a: Footprint, b: Footprint, margin = 0): boolean {
  const axes: [number, number][] = [
    [Math.cos(a.yaw), -Math.sin(a.yaw)],
    [Math.sin(a.yaw), Math.cos(a.yaw)],
    [Math.cos(b.yaw), -Math.sin(b.yaw)],
    [Math.sin(b.yaw), Math.cos(b.yaw)],
  ];
  const radius = (f: Footprint, ax: number, az: number): number => {
    const ux = Math.cos(f.yaw);
    const uz = -Math.sin(f.yaw);
    const vx = Math.sin(f.yaw);
    const vz = Math.cos(f.yaw);
    return f.hw * Math.abs(ux * ax + uz * az) + f.hd * Math.abs(vx * ax + vz * az);
  };
  for (const [ax, az] of axes) {
    const d = Math.abs((b.x - a.x) * ax + (b.z - a.z) * az);
    if (d > radius(a, ax, az) + radius(b, ax, az) + margin) return false;
  }
  return true;
}

/** Corners and edge midpoints of a footprint, for distance tests against the road. */
export function footprintPoints(f: Footprint): [number, number][] {
  const ux = Math.cos(f.yaw);
  const uz = -Math.sin(f.yaw);
  const vx = Math.sin(f.yaw);
  const vz = Math.cos(f.yaw);
  const pts: [number, number][] = [];
  for (const a of [-1, 0, 1]) {
    for (const b of [-1, 0, 1]) pts.push([f.x + ux * f.hw * a + vx * f.hd * b, f.z + uz * f.hw * a + vz * f.hd * b]);
  }
  return pts;
}

export interface StandRules {
  /** Nearest allowed distance from any part of the stand to the road centre line. */
  clearanceM: number;
  /** Footprint in the model's local frame: behind (-x) and in front of (+x) its origin, half its length along z. */
  backM: number;
  frontM: number;
  halfLengthM: number;
  maxShiftM: number;
}

/**
 * Pushes grandstands that crowd the road (a 40 m stand on a bend swings its ends over the tarmac) straight away from
 * it until the whole footprint clears. A stand that can't clear within `maxShiftM` is dropped.
 */
export function clearStandSites(
  sites: readonly [number, number, number][],
  index: RoadIndex,
  rules: StandRules,
  stepM = 2,
): [number, number, number][] {
  const out: [number, number, number][] = [];
  const clearAt = (x: number, z: number): { ok: boolean; away: [number, number] } => {
    const { i } = index.nearest(x, z, 300);
    const th = yawForX(index.xs[i] - x, index.zs[i] - z);
    const c = Math.cos(th);
    const s = Math.sin(th);
    let ok = true;
    // Sample the footprint edge to edge (corners included).
    const nx = Math.ceil((rules.backM + rules.frontM) / 1.5);
    const nz = Math.ceil((2 * rules.halfLengthM) / 2);
    for (let a = 0; a <= nx && ok; a++) {
      const lx = -rules.backM + ((rules.backM + rules.frontM) * a) / nx;
      for (let b = 0; b <= nz; b++) {
        const lz = -rules.halfLengthM + (2 * rules.halfLengthM * b) / nz;
        if (index.nearest(x + lx * c + lz * s, z - lx * s + lz * c, 300).d < rules.clearanceM) {
          ok = false;
          break;
        }
      }
    }
    const dx = x - index.xs[i];
    const dz = z - index.zs[i];
    const dl = Math.hypot(dx, dz) || 1;
    return { ok, away: [dx / dl, dz / dl] };
  };
  for (const p of sites) {
    const first = clearAt(p[0], p[2]);
    if (first.ok) {
      out.push(p);
      continue;
    }
    for (let shift = stepM; shift <= rules.maxShiftM; shift += stepM) {
      const x = p[0] + first.away[0] * shift;
      const z = p[2] + first.away[1] * shift;
      if (clearAt(x, z).ok) {
        out.push([x, p[1], z]);
        break;
      }
    }
  }
  return out;
}

/** Uniform-grid index of road samples: nearest-distance queries in O(1). */
export class RoadIndex {
  private readonly cell = 40;
  private readonly cells = new Map<number, number[]>();
  readonly xs: Float32Array;
  readonly zs: Float32Array;
  readonly ys: Float32Array;
  readonly ts: Float32Array;
  readonly lxs: Float32Array;
  readonly lzs: Float32Array;
  readonly count: number;

  /** `stepM` spaces the samples; coarse (8 m) is plenty for clearance tests and terrain. */
  constructor(path: TrackPath, stepM = 8) {
    const n = Math.max(8, Math.round(path.lengthM / stepM));
    this.count = n;
    this.xs = new Float32Array(n);
    this.zs = new Float32Array(n);
    this.ys = new Float32Array(n);
    this.ts = new Float32Array(n);
    this.lxs = new Float32Array(n);
    this.lzs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = frameAt(path, i / n);
      this.xs[i] = f.x;
      this.zs[i] = f.z;
      this.ys[i] = f.y;
      this.ts[i] = i / n;
      this.lxs[i] = f.lx;
      this.lzs[i] = f.lz;
      const k = this.key(f.x, f.z);
      const list = this.cells.get(k);
      if (list) list.push(i);
      else this.cells.set(k, [i]);
    }
  }

  private key(x: number, z: number): number {
    return Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell);
  }

  /** Index of the nearest sample and its distance, searching rings of cells out to `maxM`. */
  nearest(x: number, z: number, maxM = 400): { i: number; d: number } {
    let best = -1;
    let bestD = Infinity;
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const rings = Math.ceil(maxM / this.cell);
    for (let r = 0; r <= rings; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const list = this.cells.get((cx + dx) * 100003 + (cz + dz));
          if (!list) continue;
          for (const i of list) {
            const d = Math.hypot(this.xs[i] - x, this.zs[i] - z);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // Nothing in a ring can beat what a closer ring already found.
      if (best >= 0 && bestD <= r * this.cell) break;
    }
    return { i: best, d: bestD };
  }

  /** Signed offset from the centre line: > 0 on the driver's left. */
  lateral(i: number, x: number, z: number): number {
    return (x - this.xs[i]) * this.lxs[i] + (z - this.zs[i]) * this.lzs[i];
  }

  /** Distance to the nearest sample (centre line). */
  distance(x: number, z: number): number {
    return this.nearest(x, z).d;
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Terrain
// -----------------------------------------------------------------------------------------------------------------

export const SEA_FLOOR_Y = -6;
/** The land is shaved this far under the road surface so the carriageway never z-fights with it. */
export const SHOULDER_DROP_M = 0.3;
/** Within this distance of the road the terrain follows the road height; beyond `FAR_M` it follows the hills. */
export const NEAR_M = 55;
export const FAR_M = 260;

const smoothstep = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

export interface TerrainField {
  heightAt(x: number, z: number): number;
  /** 0 = land, 1 = open water. */
  seaAt(x: number, z: number): number;
  /** Nearest road sample distance. */
  roadDistance(x: number, z: number): number;
}

/**
 * The land under the circuit: it follows the road height near the road (hillside terraces for the villas, the quay on
 * the harbour), blends to rising hills to the north, and drops to the sea floor on the harbour side of the quay.
 */
export function makeTerrain(index: RoadIndex): TerrainField {
  const far = (x: number, z: number): number => {
    const hills = 3 + 0.16 * Math.max(0, -z - 60) + 0.04 * Math.max(0, x - 950);
    return Math.min(70, hills);
  };
  const idw = (x: number, z: number): number => {
    let sw = 0;
    let sh = 0;
    for (let i = 0; i < index.count; i++) {
      const dx = index.xs[i] - x;
      const dz = index.zs[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 400 * 400) continue;
      const w = 1 / (d2 * d2 + 1);
      sw += w;
      sh += w * index.ys[i];
    }
    return sw > 0 ? sh / sw : 3;
  };
  return {
    roadDistance: (x, z) => index.distance(x, z),
    seaAt: (x, z) => {
      let sea = 0;
      if (z > 640) sea = 1;
      const { i, d } = index.nearest(x, z, 300);
      if (i < 0) return sea;
      const t = index.ts[i];
      if (t >= HARBOUR_T[0] && t <= HARBOUR_T[1]) {
        const lat = index.lateral(i, x, z);
        if (lat > QUAY_EDGE_M && d > QUAY_EDGE_M) sea = Math.max(sea, smoothstep(QUAY_EDGE_M, QUAY_EDGE_M + 5, lat));
      }
      // West of the Rascasse hairpin the basin wraps round the end of the quay.
      if (x < -255 && z > 330) sea = Math.max(sea, smoothstep(330, 350, z) * smoothstep(-255, -275, x));
      return sea;
    },
    heightAt(x, z) {
      const { i, d } = index.nearest(x, z, 400);
      const land = ((): number => {
        if (i < 0) return far(x, z);
        const w = 1 - smoothstep(NEAR_M, FAR_M, d);
        const near = idw(x, z) - SHOULDER_DROP_M;
        return far(x, z) * (1 - w) + near * w;
      })();
      return land;
    },
  };
}

// -----------------------------------------------------------------------------------------------------------------
// Buildings and dressing
// -----------------------------------------------------------------------------------------------------------------

/** Footprints of the Belle Époque models (`belle_epoque_{a,b,c,d}`): width along the facade, depth, height. */
export const BELLE_EPOQUE_SIZES: readonly { w: number; d: number }[] = [
  { w: 24.4, d: 16.4 },
  { w: 43, d: 25.8 },
  { w: 20.4, d: 14.4 },
  { w: 34.4, d: 20.4 },
];

export interface Placed extends Footprint {
  y: number;
  model: number;
}

interface RowDef {
  fromT: number;
  toT: number;
  side: 'both' | 'left' | 'right';
  setbackM: number;
  gapM: number;
}

/** Continuous terraces along the climb, Casino Square and the Rascasse / Noghès stretch. */
export function planBelleEpoque(
  path: TrackPath,
  def: TrackDef,
  index: RoadIndex,
  blocked: readonly Obstacle[],
  seed = 5,
): Placed[] {
  const rows = (def.raw.buildings as { belleEpoque: { rows: RowDef[] } }).belleEpoque.rows;
  const rnd = seededRng(seed);
  const len = path.lengthM;
  const placed: Placed[] = [];
  const clearM = HALF_ROAD_M + 8;
  for (const row of rows) {
    const sides = row.side === 'both' ? [1, -1] : [row.side === 'left' ? 1 : -1];
    for (const side of sides) {
      let s = row.fromT * len;
      const end = row.toT * len;
      while (s < end) {
        const m = Math.floor(rnd() * BELLE_EPOQUE_SIZES.length);
        const { w, d } = BELLE_EPOQUE_SIZES[m];
        const f0 = frameAt(path, wrap01(s / len));
        const f1 = frameAt(path, wrap01((s + w) / len));
        const fm = frameAt(path, wrap01((s + w / 2) / len));
        // The facade follows the chord between the two ends; the building sits behind it.
        const cx = (f0.x + f1.x) / 2 + side * fm.lx * (HALF_ROAD_M + row.setbackM + d / 2);
        const cz = (f0.z + f1.z) / 2 + side * fm.lz * (HALF_ROAD_M + row.setbackM + d / 2);
        const dx = f1.x - f0.x;
        const dz = f1.z - f0.z;
        const dl = Math.hypot(dx, dz) || 1;
        const yaw = yawForX(dx / dl, dz / dl);
        // Local +X runs along the road and +Z (the facade) faces it: that is right of travel, so flip on the right side.
        const fpf: Footprint = { x: cx, z: cz, yaw: side > 0 ? yaw : yaw + Math.PI, hw: w / 2, hd: d / 2 };
        const ok =
          footprintPoints(fpf).every(([x, z]) => index.distance(x, z) >= clearM) &&
          !placed.some((p) => footprintsOverlap(p, fpf, row.gapM - 0.01)) &&
          !blocked.some((o) => Math.hypot(o.x - cx, o.z - cz) < o.r + Math.max(w, d) / 2);
        if (ok) {
          placed.push({ ...fpf, y: Math.min(f0.y, f1.y) - 0.3, model: m });
          s += w + row.gapM;
        } else s += PIECE_M;
      }
    }
  }
  return placed;
}

export interface PalmSite {
  x: number;
  y: number;
  z: number;
  yaw: number;
  model: number;
}

/** Palms every `everyM` metres along one side of a stretch of the lap at `lateralM`, skipping blocked spots. */
export function alongSide(
  path: TrackPath,
  fromT: number,
  toT: number,
  everyM: number,
  side: number,
  lateralM: number,
  blocked: readonly Obstacle[],
  rnd: () => number,
  models: number,
): PalmSite[] {
  const len = path.lengthM;
  const out: PalmSite[] = [];
  for (let s = fromT * len; s < toT * len; s += everyM) {
    const f = frameAt(path, wrap01(s / len));
    const x = f.x + side * f.lx * lateralM;
    const z = f.z + side * f.lz * lateralM;
    if (blocked.some((o) => Math.hypot(o.x - x, o.z - z) < o.r)) continue;
    out.push({ x, y: f.y, z, yaw: rnd() * Math.PI * 2, model: Math.floor(rnd() * models) });
  }
  return out;
}

/** Palms in a ring round the Casino fountain, and flower beds closer in. */
export function planGardens(
  fountain: [number, number, number],
  palms: number,
  beds: number,
  rnd: () => number,
): { palms: PalmSite[]; beds: { x: number; y: number; z: number }[] } {
  const p: PalmSite[] = [];
  for (let i = 0; i < palms; i++) {
    const a = (i / palms) * Math.PI * 2 + rnd() * 0.2;
    const r = 15 + (i % 2) * 7 + rnd() * 3;
    p.push({
      x: fountain[0] + Math.cos(a) * r,
      y: fountain[1],
      z: fountain[2] + Math.sin(a) * r,
      yaw: rnd() * 6.28,
      model: i % 2,
    });
  }
  const b: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < beds; i++) {
    const a = ((i + 0.5) / beds) * Math.PI * 2;
    b.push({ x: fountain[0] + Math.cos(a) * 9.5, y: fountain[1] - 0.05, z: fountain[2] + Math.sin(a) * 9.5 });
  }
  return { palms: p, beds: b };
}

export interface TowerSite {
  x: number;
  z: number;
  yaw: number;
  model: number;
}

/** Scattered glass towers on the hillside: never closer than 40 m to the track, on land, away from other dressing. */
export function planTowers(
  count: number,
  field: TerrainField,
  blocked: readonly Obstacle[],
  rnd: () => number,
  minRoadM = 45,
): TowerSite[] {
  const out: TowerSite[] = [];
  for (let tries = 0; tries < 6000 && out.length < count; tries++) {
    const x = -50 + rnd() * 1000;
    const z = -420 + rnd() * 720;
    if (field.seaAt(x, z) > 0) continue;
    if (field.roadDistance(x, z) < minRoadM) continue;
    if (blocked.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 22)) continue;
    if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 70)) continue;
    out.push({ x, z, yaw: rnd() * Math.PI * 2, model: out.length % 2 });
  }
  return out;
}
