import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/Assets';
import { roadWidthAt, type TrackDef } from '../core/Data';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import { seededRng } from './CongHoaDressing';
import { type CorridorPath, rightOf } from './Corridor';
import type { TrackPath } from './TrackPath';
import { DistanceCull, drawDistance } from './Windowed';

type Rapier = typeof RAPIER;

const CL = 'models/props_catlai/';
const XP = 'models/props_xalo/';
const BLOCKS = ['container_block_a', 'container_block_b', 'container_block_c'].map((n) => `${CL}${n}.glb`);
const GATE = `${CL}port_gate.glb`;
const MAST = `${CL}flood_mast.glb`;
const SKYLINE = `${CL}cable_stayed_bridge.glb`;
const TRUCKS = ['container_truck_blue', 'container_truck_red'].map((n) => `${XP}${n}.glb`);
const FACTORY = `${XP}factory_shed.glb`;
const LAMP = `${XP}highway_lamp.glb`;

/** Every GLB this module loads, relative to /assets/. */
export const CAT_LAI_YARD_MODELS: string[] = [...BLOCKS, GATE, MAST, SKYLINE, ...TRUCKS, FACTORY, LAMP];

// ---------------------------------------------------------------------------------------------
// Pure layout planning (no DOM, no rendering, no assets): deterministic and unit tested.
// ---------------------------------------------------------------------------------------------

/** Chunk edge for spatial culling. */
export const CHUNK_M = 150;
/** Lane kept clear between container blocks. */
export const BLOCK_LANE_M = 10;
/** Half width of the clear band kept around the Reefer-lane shortcut (its half width + 3 m). */
export const SHORTCUT_MARGIN_M = 3;

/** Footprints read from the GLB bounds (metres). */
export const SIZES = {
  /** container_block_*: origin at the centre of the footprint; width x, length z. */
  block: { hw: 7.5, hd: 31.25, h: 13 },
  /** container_truck_*: nose +Z, origin on the ground at the centre (z -8.33 … 8.07). */
  truck: { hw: 1.1, hd: 8.2, h: 3.9, zOffset: -0.13 },
  /** factory_shed: 60 × 40, origin at the centre; the door face is +Z. */
  factory: { hw: 30, hd: 20, h: 18 },
  /** flood_mast: 6.4 m square base plate. */
  mast: { hw: 3.2, h: 35.85 },
  /** rtg_crane (built by CatLaiQuay): x -12.55…12.75, z -6.1…7.4. */
  rtg: { hw: 13.5, hd: 8 },
  /** sts_quay_crane: x -30…80 (boom over the water), z ±11. */
  sts: { x0: -30, x1: 80, hd: 12 },
};

/** port_gate.glb (40 × 14 m, travel along its local z): six 6 m lanes between seven dividers. */
export const GATE_MODEL = {
  /** Divider centres on the local x axis; the lanes lie between them (centres at ±3, ±9, ±15). */
  dividers: [-18, -12, -6, 0, 6, 12, 18],
  laneCentres: [-15, -9, -3, 3, 9, 15],
  /** Cabin: x ± 1.5 (collider trimmed to ± 0.95: the 3 m roof-height opening is too tight for the APC and AI cars), z -1.66…0.3, y 1.04…7 (resting on a 1.4 m wide island, 3 m long, 2.6 m high). */
  booth: { hx: 0.5, hy: 3, hz: 0.98, cy: 4.04, cz: -0.68 },
  island: { hx: 0.4, hy: 1.3, hz: 1.2, cy: 1.3, cz: 0 },
  depthHalfM: 7,
};

export interface Site {
  x: number;
  z: number;
  /** Rotation about +Y (0 faces +Z). */
  yaw: number;
}

export interface KindSite extends Site {
  kind: number;
}

/** An oriented ground rectangle (half extents `hw` across local x, `hd` along local z). */
export interface Rect {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  yaw: number;
}

export interface YardSpec {
  /** Per-area [x0, x1] and [n0, n1] (N = −z). */
  areas: { x: [number, number]; n: [number, number] }[];
  blockSizeM: [number, number, number];
  gate: { x: number; z: number };
  queue: { fromN: number; toN: number; spacingM: number };
  warehouseSpacingM: number;
  lampEveryM: number;
  mastSpacingM: number;
  skyline: { x: number; z: number; headingDeg: number };
  shortcut: { points: [number, number][]; widthM: number };
  stsZ: number[];
  rtg: [number, number][];
  quay: { edgeX: number; fromN: number; toN: number };
  /** Section A (the truck road) as t range. */
  truckRoad: { fromT: number; toT: number };
  /** Distance of the quay mast row from the quay edge, and of the barrier row from the road edge. */
  barrierOffsetM: number;
}

/** Reads the spec out of the map JSON (`TrackDef.raw`). */
export function specFromTrack(raw: Record<string, unknown>, barrierOffsetM = 0.3): YardSpec {
  const r = raw as {
    sections: { id: string; fromT: number; toT: number }[];
    containerBlocks: { blockSizeM: [number, number, number]; areas: { x: [number, number]; n: [number, number] }[] };
    gate: { position: number[] };
    truckQueue: { fromN: number; toN: number; spacingM: number };
    dressing: { warehouses: { spacingM: number }; lamps: { truckRoadMedianEveryM: number } };
    lighting: { floodMasts: { spacingM: number } };
    skyline: { position: number[]; headingDeg: number };
    shortcut: { widthM: number; points: number[][] };
    cranes: { sts: { positions: number[][] }; rtg: { positions: number[][] } };
    quay: { edgeX: number; fromN: number; toN: number };
  };
  const a = r.sections.find((s) => s.id === 'A');
  if (!a) throw new Error('cat_lai: section A (truck road) missing');
  return {
    areas: r.containerBlocks.areas,
    blockSizeM: r.containerBlocks.blockSizeM,
    gate: { x: r.gate.position[0], z: r.gate.position[2] },
    queue: { fromN: r.truckQueue.fromN, toN: r.truckQueue.toN, spacingM: r.truckQueue.spacingM },
    warehouseSpacingM: r.dressing.warehouses.spacingM,
    lampEveryM: r.dressing.lamps.truckRoadMedianEveryM,
    mastSpacingM: r.lighting.floodMasts.spacingM,
    skyline: { x: r.skyline.position[0], z: r.skyline.position[2], headingDeg: r.skyline.headingDeg },
    shortcut: { points: r.shortcut.points.map((p) => [p[0], p[2]] as [number, number]), widthM: r.shortcut.widthM },
    stsZ: r.cranes.sts.positions.map((p) => p[2]),
    rtg: r.cranes.rtg.positions.map((p) => [p[0], p[2]] as [number, number]),
    quay: r.quay,
    truckRoad: { fromT: a.fromT, toT: a.toT },
    barrierOffsetM,
  };
}

// ---- geometry helpers ---------------------------------------------------------------------

/** Distance from (x, z) to a rotated rectangle (0 when inside). */
export function distToRect(rect: Rect, x: number, z: number): number {
  const c = Math.cos(rect.yaw);
  const s = Math.sin(rect.yaw);
  const dx = x - rect.cx;
  const dz = z - rect.cz;
  // local = R(-yaw) * d, with three's rotation.y convention (+X → (cos, −sin), +Z → (sin, cos)).
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.hypot(Math.max(Math.abs(lx) - rect.hw, 0), Math.max(Math.abs(lz) - rect.hd, 0));
}

/** Local → world offset for a rotation about +Y. */
export function rotateLocal(lx: number, lz: number, yaw: number): { x: number; z: number } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: lx * c + lz * s, z: -lx * s + lz * c };
}

/** Local half-width of the carriageway at path sample `i`. */
export const halfWidthAt =
  (def: TrackDef, count: number) =>
  (i: number): number =>
    roadWidthAt(def, i / count) / 2;

/**
 * How far a rectangle stays from the driving surface: the smallest (distance from a path sample or the middle of
 * a segment to the rectangle) − (the carriageway's half width there). Negative = the rectangle lies on the road.
 */
export function clearanceM(path: CorridorPath, halfAt: (i: number) => number, rect: Rect): number {
  let best = Infinity;
  const n = path.count;
  // Cheap reject: a sample further than this from the rectangle's centre cannot be the closest one.
  const reach = Math.hypot(rect.hw, rect.hd) + 40;
  for (let i = 0; i < n; i++) {
    if (Math.abs(path.px[i] - rect.cx) > reach || Math.abs(path.pz[i] - rect.cz) > reach) continue;
    const j = i + 1 === n ? 0 : i + 1;
    const h = halfAt(i);
    const d0 = distToRect(rect, path.px[i], path.pz[i]) - h;
    const dm = distToRect(rect, (path.px[i] + path.px[j]) / 2, (path.pz[i] + path.pz[j]) / 2) - h;
    best = Math.min(best, d0, dm);
  }
  return best;
}

/** Distance from the racing line (not the road edge) to a rectangle. */
export function lineDistanceM(path: CorridorPath, rect: Rect): number {
  return clearanceM(path, () => 0, rect);
}

/** Centres of as many `len` blocks as fit in [lo, hi] with `gap` between them, centred in the span. */
export function packAxis(lo: number, hi: number, len: number, gap: number): number[] {
  const span = hi - lo;
  if (span < len) return [];
  const n = Math.floor((span + gap) / (len + gap));
  const used = n * len + (n - 1) * gap;
  const start = lo + (span - used) / 2 + len / 2;
  return Array.from({ length: n }, (_, k) => start + k * (len + gap));
}

/** Columns packed from the low edge (columns sit tight to the area's west edge, the lanes between them stay `gap`). */
export function packColumns(lo: number, hi: number, w: number, gap: number): number[] {
  const out: number[] = [];
  for (let c = lo + w / 2; c + w / 2 <= hi + 1e-6; c += w + gap) out.push(c);
  return out;
}

/** Closed intervals of [lo, hi] left after cutting out `bands`. */
export function subtractBands(lo: number, hi: number, bands: readonly [number, number][]): [number, number][] {
  let spans: [number, number][] = [[lo, hi]];
  for (const [b0, b1] of bands) {
    const next: [number, number][] = [];
    for (const [s0, s1] of spans) {
      if (b1 <= s0 || b0 >= s1) next.push([s0, s1]);
      else {
        if (b0 > s0) next.push([s0, b0]);
        if (b1 < s1) next.push([b1, s1]);
      }
    }
    spans = next;
  }
  return spans;
}

// ---- gate ---------------------------------------------------------------------------------

export interface GatePlan {
  x: number;
  z: number;
  yaw: number;
  /** Index (0–5) of the lane the racing line passes through. */
  lane: number;
  /** Local-x offset the gate was slid so the lane centre sits on the racing line (the data position put a divider there). */
  shiftM: number;
  /** Local-x of the racing line before the slide. */
  lineLocalX: number;
  /** Solid parts as world-space boxes. */
  boxes: (Rect & { cy: number; hy: number })[];
}

/** Heading of the racing line through the gate, snapped to a quarter turn so the gate sits square to the road. */
export function gateYaw(path: CorridorPath, gx: number, gz: number): number {
  let tx = 0;
  let tz = 0;
  for (let i = 0; i < path.count; i++) {
    if (Math.hypot(path.px[i] - gx, path.pz[i] - gz) < 12) {
      tx += path.tx[i];
      tz += path.tz[i];
    }
  }
  const a = Math.atan2(tx, tz);
  return Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
}

/**
 * Places the gate: square to the racing line (the sign, on local −z, faces arriving traffic), with the lane the racing
 * line uses centred on it. The model's `x` axis runs across the lanes; world x/z follow from the yaw.
 */
export function planGate(path: CorridorPath, spec: YardSpec): GatePlan {
  const yaw = gateYaw(path, spec.gate.x, spec.gate.z);
  const ax = rotateLocal(1, 0, yaw);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < path.count; i++) {
    const d = rotateLocal(path.px[i] - spec.gate.x, path.pz[i] - spec.gate.z, -yaw); // world → local
    if (Math.abs(d.z) <= GATE_MODEL.depthHalfM && Math.abs(d.x) <= 25) {
      sum += d.x;
      n++;
    }
  }
  const lineLocalX = n > 0 ? sum / n : 0;
  let lane = 0;
  for (let k = 1; k < GATE_MODEL.laneCentres.length; k++) {
    if (Math.abs(GATE_MODEL.laneCentres[k] - lineLocalX) < Math.abs(GATE_MODEL.laneCentres[lane] - lineLocalX))
      lane = k;
  }
  const shiftM = lineLocalX - GATE_MODEL.laneCentres[lane];
  const x = spec.gate.x + ax.x * shiftM;
  const z = spec.gate.z + ax.z * shiftM;
  const boxes: GatePlan['boxes'] = [];
  for (const c of GATE_MODEL.dividers) {
    for (const part of [GATE_MODEL.island, GATE_MODEL.booth]) {
      const o = rotateLocal(c, part.cz, yaw);
      boxes.push({ cx: x + o.x, cz: z + o.z, hw: part.hx, hd: part.hz, yaw, cy: part.cy, hy: part.hy });
    }
  }
  return { x, z, yaw, lane, shiftM, lineLocalX, boxes };
}

// ---- the rest of the layout -----------------------------------------------------------------

export interface YardPlan {
  blocks: KindSite[];
  trucks: KindSite[];
  warehouses: Site[];
  lamps: Site[];
  masts: Site[];
  gate: GatePlan;
  skyline: Site;
  /** Items dropped because they would have sat on the road (should stay empty with the shipped data). */
  dropped: string[];
}

const MIN_CLEARANCE_M = 0.5;
const WAREHOUSE_CLEARANCE_M = 12;
const MAST_CLEARANCE_M = 1.5;

export interface NPoint {
  x: number;
  z: number;
  tx: number;
  tz: number;
}

/**
 * Point and heading on the racing line at northing `n` (−z), interpolated between samples, searching only samples with
 * t in [t0, t1). Null when the line does not reach that northing in the range.
 */
export function pointAtN(path: CorridorPath, n: number, t0: number, t1: number): NPoint | null {
  const a = Math.floor(t0 * path.count);
  const b = Math.min(Math.floor(t1 * path.count), path.count - 1);
  for (let i = a; i < b; i++) {
    const n0 = -path.pz[i];
    const n1 = -path.pz[i + 1];
    if ((n0 - n) * (n1 - n) <= 0 && n0 !== n1) {
      const k = (n - n0) / (n1 - n0);
      const tx = path.tx[i] + (path.tx[i + 1] - path.tx[i]) * k;
      const tz = path.tz[i] + (path.tz[i + 1] - path.tz[i]) * k;
      const l = Math.hypot(tx, tz) || 1;
      return {
        x: path.px[i] + (path.px[i + 1] - path.px[i]) * k,
        z: path.pz[i] + (path.pz[i + 1] - path.pz[i]) * k,
        tx: tx / l,
        tz: tz / l,
      };
    }
  }
  return null;
}

export function planYard(path: CorridorPath, def: TrackDef, spec: YardSpec): YardPlan {
  const halfAt = halfWidthAt(def, path.count);
  const rnd = seededRng(0xca71a1);
  const dropped: string[] = [];
  const keep = (label: string, rect: Rect, minM: number): boolean => {
    if (clearanceM(path, halfAt, rect) >= minM) return true;
    dropped.push(label);
    return false;
  };

  // --- container blocks -------------------------------------------------------------------
  const [bw, , bl] = spec.blockSizeM;
  const scBand = spec.shortcut.points.map((p) => p[1]);
  const bands: [number, number][] = [];
  const reach = spec.shortcut.widthM / 2 + SHORTCUT_MARGIN_M;
  if (scBand.length) bands.push([Math.min(...scBand) - reach, Math.max(...scBand) + reach]);
  const keepOuts: Rect[] = [
    ...spec.rtg.map(([x, z]) => ({ cx: x, cz: z, hw: SIZES.rtg.hw, hd: SIZES.rtg.hd, yaw: 0 })),
  ];
  const blocks: KindSite[] = [];
  for (const area of spec.areas) {
    const zLo = -area.n[1];
    const zHi = -area.n[0];
    const cols = packColumns(area.x[0], area.x[1], bw, BLOCK_LANE_M);
    for (const [s0, s1] of subtractBands(zLo, zHi, bands)) {
      for (const cz of packAxis(s0, s1, bl, BLOCK_LANE_M)) {
        for (const cx of cols) {
          const yaw = rnd() < 0.5 ? 0 : Math.PI;
          const kind = Math.floor(rnd() * BLOCKS.length);
          const rect: Rect = { cx, cz, hw: SIZES.block.hw, hd: SIZES.block.hd, yaw };
          if (keepOuts.some((k) => rectsOverlap(k, rect))) {
            dropped.push(`block@${cx},${cz} (crane)`);
            continue;
          }
          if (keep(`block@${cx},${cz}`, rect, MIN_CLEARANCE_M)) blocks.push({ x: cx, z: cz, yaw, kind });
        }
      }
    }
  }

  // --- parked truck queue (rightmost lane of the truck road) -------------------------------
  const trucks: KindSite[] = [];
  const hwRoad = roadWidthAt(def, spec.truckRoad.fromT + 0.01) / 2;
  const q = spec.queue;
  const count = Math.floor((q.toN - q.fromN) / q.spacingM);
  for (let k = 0; k < count; k++) {
    const n = q.fromN + SIZES.truck.hd + k * q.spacingM;
    const c = pointAtN(path, n, spec.truckRoad.fromT, spec.truckRoad.toT);
    if (!c) continue;
    const r = rightOf(c.tx, c.tz);
    // Parked tight against the right kerb: rivals that drift a metre off their lane still clear the trucks' rear corners.
    const lateral = hwRoad - roadLaneWidth(def) / 2 + 0.35;
    trucks.push({
      x: c.x + r.x * lateral,
      z: c.z + r.z * lateral,
      yaw: Math.atan2(c.tx, c.tz),
      kind: k % TRUCKS.length,
    });
  }

  // --- warehouses both sides of the truck road ---------------------------------------------
  const warehouses: Site[] = [];
  const slots = Math.floor((620 - 40) / spec.warehouseSpacingM);
  for (let k = 0; k < slots; k++) {
    const n = 40 + spec.warehouseSpacingM / 2 + k * spec.warehouseSpacingM;
    const c = pointAtN(path, n, spec.truckRoad.fromT, spec.truckRoad.toT);
    if (!c) continue;
    for (const side of [1, -1]) {
      const r = rightOf(c.tx, c.tz);
      const lateral = side * (hwRoad + WAREHOUSE_CLEARANCE_M + SIZES.factory.hd);
      const x = c.x + r.x * lateral;
      const z = c.z + r.z * lateral;
      // The 60 m side runs along the road (70 m slots → 10 m gaps); the door face (+Z) turns to the road.
      const yaw = Math.atan2(-side * r.x, -side * r.z);
      const rect: Rect = { cx: x, cz: z, hw: SIZES.factory.hw, hd: SIZES.factory.hd, yaw };
      if (keep(`warehouse@${n}/${side}`, rect, WAREHOUSE_CLEARANCE_M - 2)) warehouses.push({ x, z, yaw });
    }
  }

  // --- highway lamps along the truck road's left edge (there is no median: it is one carriageway) ----
  const lamps: Site[] = [];
  for (let n = 20; n <= 620; n += spec.lampEveryM) {
    const c = pointAtN(path, n, spec.truckRoad.fromT, spec.truckRoad.toT);
    if (!c) continue;
    const r = rightOf(c.tx, c.tz);
    const lateral = -(hwRoad + spec.barrierOffsetM + 1.2 + 0.6);
    lamps.push({ x: c.x + r.x * lateral, z: c.z + r.z * lateral, yaw: Math.atan2(c.tx, c.tz) });
  }

  // --- flood masts: along the quay (between the apron and the quay lip) and at the ends of the block fields ----
  const masts: Site[] = [];
  const mastKeepOut = (x: number, z: number): boolean => {
    if (spec.stsZ.some((cz) => Math.abs(z - cz) < SIZES.sts.hd + SIZES.mast.hw)) return true;
    const sx = spec.shortcut.points.map((p) => p[0]);
    if (
      scBand.length &&
      z > Math.min(...scBand) - reach - SIZES.mast.hw &&
      z < Math.max(...scBand) + reach + SIZES.mast.hw
    )
      return x >= Math.min(...sx) - 5;
    return false;
  };
  const mastRect = (x: number, z: number): Rect => ({ cx: x, cz: z, hw: SIZES.mast.hw, hd: SIZES.mast.hw, yaw: 0 });
  const addMast = (x: number, z: number): void => {
    if (mastKeepOut(x, z)) return;
    if (keepOuts.some((k) => rectsOverlap(k, mastRect(x, z)))) return;
    if (
      blocks.some((b) =>
        rectsOverlap({ cx: b.x, cz: b.z, hw: SIZES.block.hw, hd: SIZES.block.hd, yaw: b.yaw }, mastRect(x, z)),
      )
    )
      return;
    if (keep(`mast@${x},${z}`, mastRect(x, z), MAST_CLEARANCE_M)) masts.push({ x, z, yaw: 0 });
  };
  const quayX = spec.quay.edgeX - 8;
  for (let z = -spec.quay.toN + spec.mastSpacingM / 2; z <= -spec.quay.fromN; z += spec.mastSpacingM) addMast(quayX, z);
  // Block-field ends: one mast just beyond each end of every area (dropped where a road or crane is in the way).
  for (const area of spec.areas) {
    const fx = (area.x[0] + area.x[1]) / 2;
    addMast(fx, -area.n[1] - 8);
    addMast(fx, -area.n[0] + 8);
  }

  const gate = planGate(path, spec);
  const skyline: Site = { x: spec.skyline.x, z: spec.skyline.z, yaw: (spec.skyline.headingDeg * Math.PI) / 180 };
  return { blocks, trucks, warehouses, lamps, masts, gate, skyline, dropped };
}

/** Width of one lane of the truck road. */
function roadLaneWidth(def: TrackDef): number {
  return def.roadWidthM / def.laneOffsetsM.length;
}

/** Separating-axis overlap test for two rotated rectangles (touching counts as no overlap). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  const axes = [a.yaw, b.yaw].flatMap((y) => [rotateLocal(1, 0, y), rotateLocal(0, 1, y)]);
  const corners = (r: Rect): { x: number; z: number }[] =>
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sx, sz]) => {
      const o = rotateLocal(sx * r.hw, sz * r.hd, r.yaw);
      return { x: r.cx + o.x, z: r.cz + o.z };
    });
  const ca = corners(a);
  const cb = corners(b);
  for (const ax of axes) {
    const pa = ca.map((p) => p.x * ax.x + p.z * ax.z);
    const pb = cb.map((p) => p.x * ax.x + p.z * ax.z);
    if (Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6) return false;
  }
  return true;
}

/** Chunk key of a world position. */
export function chunkKey(x: number, z: number): string {
  return `${Math.floor(x / CHUNK_M)},${Math.floor(z / CHUNK_M)}`;
}

/** Groups items by chunk. */
export function groupByChunk<T extends { x: number; z: number }>(items: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = chunkKey(it.x, it.z);
    const list = out.get(k);
    if (list) list.push(it);
    else out.set(k, [it]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const up = new THREE.Vector3(0, 1, 0);

function compose(s: Site): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(s.x, 0, s.z),
    new THREE.Quaternion().setFromAxisAngle(up, s.yaw),
    new THREE.Vector3(1, 1, 1),
  );
}

const isShared = (m: THREE.Material): boolean => m.userData.shared === true;

/** Identity of a draw: merged vertex-colour materials by name, others by their look (so clones of one prop share). */
function materialKey(m: THREE.Material): string {
  if (isShared(m)) return m.name;
  const s = m as THREE.MeshStandardMaterial;
  const img = s.map?.image as { width?: number; height?: number } | null | undefined;
  const tex = s.map ? (s.map.name ? `${s.map.name}:${img?.width}x${img?.height}` : s.map.uuid) : '';
  return `${m.name}|${tex}|${s.color?.getHex() ?? 0}|${s.emissive?.getHex() ?? 0}|${s.emissiveIntensity ?? 0}`;
}

/** Adds `meshes` under one DistanceCull around their joint bounds: a chunk past `maxDistM` costs no draw calls. */
function cullGroup(parent: THREE.Object3D, meshes: readonly THREE.Mesh[], maxDistM: number): void {
  if (!meshes.length) return;
  const box = new THREE.Box3();
  for (const m of meshes) {
    m.geometry.computeBoundingBox();
    if (m.geometry.boundingBox) box.union(m.geometry.boundingBox);
  }
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const cull = new DistanceCull(sphere.center, maxDistM, sphere.radius);
  parent.add(cull);
  for (const m of meshes) cull.add(m);
}

/** Bakes placed copies of a few models into one static mesh per material. */
class StaticBatch {
  private readonly buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();

  add(proto: THREE.Object3D, world: THREE.Matrix4): void {
    const m = new THREE.Matrix4();
    proto.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      const key = materialKey(o.material);
      let b = this.buckets.get(key);
      if (!b) {
        b = { material: o.material, geos: [] };
        this.buckets.set(key, b);
      }
      m.multiplyMatrices(world, o.matrixWorld);
      b.geos.push(o.geometry.clone().applyMatrix4(m));
    });
  }

  build(
    parent: THREE.Object3D,
    name: string,
    maxDistM: number,
  ): { meshes: THREE.Mesh[]; materials: Set<THREE.Material> } {
    const meshes: THREE.Mesh[] = [];
    const materials = new Set<THREE.Material>();
    for (const [key, b] of this.buckets) {
      if (!b.geos.length) continue;
      const common = Object.keys(b.geos[0].attributes).filter((a) => b.geos.every((g) => g.getAttribute(a)));
      for (const g of b.geos) for (const a of Object.keys(g.attributes)) if (!common.includes(a)) g.deleteAttribute(a);
      const merged = mergeGeometries(b.geos, false);
      b.geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.name = `${name}:${key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      meshes.push(mesh);
      materials.add(b.material);
    }
    this.buckets.clear();
    cullGroup(parent, meshes, maxDistM);
    return { meshes, materials };
  }
}

/** Night container port: yard blocks, the terminal gate, the truck queue, warehouses, lamps, flood masts, skyline. */
export class CatLaiYard {
  readonly group = new THREE.Group();
  /** The layout that was built (handy for debugging and tests). */
  readonly plan: YardPlan;
  private readonly baked: THREE.Mesh[] = [];
  private readonly protos: THREE.Object3D[] = [];
  private readonly usedMaterials = new Set<THREE.Material>();
  private readonly drawM: number;
  private readonly body: RAPIER.RigidBody;

  constructor(
    private readonly scene: THREE.Scene,
    R: Rapier,
    private readonly world: RAPIER.World,
    private readonly assets: Assets,
    track: TrackDef,
    path: TrackPath,
  ) {
    this.group.name = 'cat_lai_yard';
    this.drawM = drawDistance(track.daylight);
    const spec = specFromTrack(track.raw);
    this.plan = planYard(path, track, spec);
    this.buildStatic();
    this.buildSkyline();
    this.body = this.buildColliders(R);
    scene.add(this.group);
  }

  /** Clones a model and bakes its plain sub-materials into the two shared vertex-colour materials. */
  private prep(model: string): THREE.Group {
    const g = this.assets.cloneModel(model);
    mergePropMaterials(g);
    g.updateMatrixWorld(true);
    this.protos.push(g);
    return g;
  }

  /** Everything static, baked into one merged mesh per material per ~150 m chunk. */
  private buildStatic(): void {
    const p = this.plan;
    const blocks = BLOCKS.map((m) => this.prep(m));
    const trucks = TRUCKS.map((m) => this.prep(m));
    const factory = this.prep(FACTORY);
    const lamp = this.prep(LAMP);
    const mast = this.prep(MAST);
    const gate = this.prep(GATE);
    const batches = new Map<string, StaticBatch>();
    const batchFor = (x: number, z: number): StaticBatch => {
      const k = chunkKey(x, z);
      let b = batches.get(k);
      if (!b) {
        b = new StaticBatch();
        batches.set(k, b);
      }
      return b;
    };
    for (const b of p.blocks) batchFor(b.x, b.z).add(blocks[b.kind], compose(b));
    for (const t of p.trucks) batchFor(t.x, t.z).add(trucks[t.kind], compose(t));
    for (const w of p.warehouses) batchFor(w.x, w.z).add(factory, compose(w));
    for (const l of p.lamps) batchFor(l.x, l.z).add(lamp, compose(l));
    for (const m of p.masts) batchFor(m.x, m.z).add(mast, compose(m));
    batchFor(p.gate.x, p.gate.z).add(gate, compose(p.gate));
    for (const [k, b] of batches) {
      const { meshes, materials } = b.build(this.group, `static:${k}`, this.drawM);
      this.baked.push(...meshes);
      materials.forEach((m) => this.usedMaterials.add(m));
    }
  }

  /** Backdrop: far beyond the fog, so its own materials ignore fog (a lit silhouette on the horizon). */
  private buildSkyline(): void {
    const s = this.plan.skyline;
    const bridge = this.assets.cloneModel(SKYLINE);
    bridge.position.set(s.x, 0, s.z);
    bridge.rotation.y = s.yaw;
    bridge.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.fog = false;
      o.castShadow = false;
      o.receiveShadow = false;
    });
    this.protos.push(bridge);
    this.group.add(bridge);
  }

  private buildColliders(R: Rapier): RAPIER.RigidBody {
    const body = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    const p = this.plan;
    const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw: number): void => {
      this.world.createCollider(
        R.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(cx, cy, cz)
          .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
          .setFriction(0.2)
          .setRestitution(0.2),
        body,
      );
    };
    const s = SIZES;
    for (const b of p.blocks) box(b.x, s.block.h / 2, b.z, s.block.hw, s.block.h / 2, s.block.hd, b.yaw);
    for (const t of p.trucks) {
      const o = rotateLocal(0, s.truck.zOffset, t.yaw);
      box(t.x + o.x, s.truck.h / 2, t.z + o.z, s.truck.hw, s.truck.h / 2, s.truck.hd, t.yaw);
    }
    for (const w of p.warehouses) box(w.x, s.factory.h / 2, w.z, s.factory.hw, s.factory.h / 2, s.factory.hd, w.yaw);
    for (const m of p.masts) box(m.x, 4, m.z, s.mast.hw / 2, 4, s.mast.hw / 2, 0);
    for (const g of p.gate.boxes) box(g.cx, g.cy, g.cz, g.hw, g.hy, g.hd, g.yaw);
    return body;
  }

  dispose(): void {
    this.world.removeRigidBody(this.body);
    for (const m of this.baked) m.geometry.dispose();
    const freed = new Set<THREE.Material>();
    const free = (m: THREE.Material): void => {
      if (isShared(m) || freed.has(m)) return;
      freed.add(m);
      m.dispose();
    };
    this.usedMaterials.forEach(free);
    for (const p of this.protos) {
      p.traverse((o) => {
        if (o instanceof THREE.Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) free(m);
      });
    }
    this.scene.remove(this.group);
  }
}
