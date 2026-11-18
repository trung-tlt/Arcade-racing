import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/Assets';
import type { TrackDef } from '../core/Data';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import {
  type CentrePoint,
  type CorridorPath,
  corridorCentreline,
  findOpposites,
  leftOf,
  medianSites,
} from './Corridor';
import type { TrackPath } from './TrackPath';

type Rapier = typeof RAPIER;

const P = 'models/props_conghoa/';
const SHOPHOUSES = ['shophouse_a', 'shophouse_b', 'shophouse_c', 'shophouse_d'].map((n) => `${P}${n}.glb`);
const FENCE = `${P}airport_fence.glb`;
const TOWER = `${P}office_tower.glb`;
const MEDIAN = `${P}median_segment.glb`;
const TREES = [`${P}street_tree_a.glb`, `${P}street_tree_b.glb`];
const POLE = `${P}power_pole.glb`;
const BUS_STOP = `${P}bus_stop.glb`;
const SCOOTERS = [`${P}scooter_red.glb`, `${P}scooter_white.glb`];

/** Every GLB this module loads, relative to /assets/. */
export const CONG_HOA_DRESSING_MODELS: string[] = [
  ...SHOPHOUSES,
  FENCE,
  TOWER,
  MEDIAN,
  ...TREES,
  POLE,
  BUS_STOP,
  ...SCOOTERS,
];

// ---------------------------------------------------------------------------------------------
// Pure layout planning (no DOM, no rendering, no assets): deterministic and unit tested.
// ---------------------------------------------------------------------------------------------

/** Kerb stone width the Track builds beyond the carriageway edge. */
export const KERB_M = 0.35;
/** Footprint depth of a shophouse behind its facade (the GLBs are 14 m deep, origin on the facade). */
export const HOUSE_DEPTH_M = 14;
/** Extra clearance to every road for house footprints. */
export const HOUSE_ROAD_CLEARANCE_M = 14;
/** Hard cap on parked scooters (0–4 per house would be ~1000: too many triangles for the budget). */
export const MAX_PARKED_SCOOTERS = 480;

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

export interface Placement {
  x: number;
  z: number;
  /** Rotation about +Y (0 faces +Z). */
  yaw: number;
}

export interface HousePlacement extends Placement {
  kind: number;
  /** Metres along the median centre line. */
  n: number;
  /** +1 = left of the first leg's travel direction (west on the Cong Hoa outbound leg), −1 = right. */
  side: 1 | -1;
  width: number;
}

export interface KindPlacement extends Placement {
  kind: number;
}

export interface PoleSpan {
  /** Indices into DressingPlan.poles. */
  a: number;
  b: number;
}

export interface DressingPlan {
  houses: HousePlacement[];
  fence: Placement[];
  towers: Placement[];
  median: Placement[];
  medianTrees: KindPlacement[];
  poles: Placement[];
  spans: PoleSpan[];
  trees: KindPlacement[];
  busStops: Placement[];
  scooters: KindPlacement[];
}

export interface DressingSpec {
  carriagewayWidthM: number;
  sidewalkWidthM: number;
  frontageOffsetM: number;
  rowsWest: number;
  rowsEast: number;
  fence: { fromN: number; toN: number; offsetM: number };
  towers: { fromN: number; toN: number; count: number };
  medianTileM: number;
  medianTreesEveryM: number;
  poleEveryM: number;
  treeEveryM: number;
  busStopEveryM: number;
  scootersPerShop: [number, number];
}

/** Reads the spec out of the map JSON (`TrackDef.raw`). */
export function specFromTrack(raw: Record<string, unknown>): DressingSpec {
  const r = raw as {
    roadLayout: { carriagewayWidthM: number; sidewalkWidthM: number };
    dressing: {
      shophouseRowsWest: number;
      shophouseRowsEast: number;
      shophouses: { frontageOffsetM: number };
      airportFence: { fromN: number; toN: number; offsetM: number };
      officeTowers: { fromN: number; toN: number; count: number };
      median: { tileM: number; treesEveryM: number };
      sidewalk: {
        powerPolesEveryM: number;
        treesEveryM: number;
        busStopsEveryM: number;
        parkedScootersPerShop: [number, number];
      };
    };
  };
  const d = r.dressing;
  return {
    carriagewayWidthM: r.roadLayout.carriagewayWidthM,
    sidewalkWidthM: r.roadLayout.sidewalkWidthM,
    frontageOffsetM: d.shophouses.frontageOffsetM,
    rowsWest: d.shophouseRowsWest,
    rowsEast: d.shophouseRowsEast,
    fence: d.airportFence,
    towers: d.officeTowers,
    medianTileM: d.median.tileM,
    medianTreesEveryM: d.median.treesEveryM,
    poleEveryM: d.sidewalk.powerPolesEveryM,
    treeEveryM: d.sidewalk.treesEveryM,
    busStopEveryM: d.sidewalk.busStopsEveryM,
    scootersPerShop: d.sidewalk.parkedScootersPerShop,
  };
}

/** Shortest distance from (x, z) to any sample of the racing line (global, O(n)). */
export function minDistToPath(path: CorridorPath, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < path.count; i++) {
    const dx = path.px[i] - x;
    const dz = path.pz[i] - z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Rotates a local (lx, lz) offset by `yaw` about +Y (same convention as three's rotation.y). */
export function rotateLocal(lx: number, lz: number, yaw: number): { x: number; z: number } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: lx * c + lz * s, z: -lx * s + lz * c };
}

/** Points covering a rotated rectangle (corners, edge midpoints, centre and a coarse interior grid). */
export function rectPoints(cx: number, cz: number, hw: number, hd: number, yaw: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (const fx of [-1, -0.5, 0, 0.5, 1]) {
    for (const fz of [-1, -0.5, 0, 0.5, 1]) {
      const o = rotateLocal(fx * hw, fz * hd, yaw);
      out.push({ x: cx + o.x, z: cz + o.z });
    }
  }
  return out;
}

/** Smallest distance from any point of the rectangle to the racing line. */
export function rectClearanceToPath(
  path: CorridorPath,
  cx: number,
  cz: number,
  hw: number,
  hd: number,
  yaw: number,
): number {
  let best = Infinity;
  for (const p of rectPoints(cx, cz, hw, hd, yaw)) best = Math.min(best, minDistToPath(path, p.x, p.z));
  return best;
}

/** Position and direction on the median centre line at distance `n` (clamped to its ends). */
export function interpolateCentre(pts: readonly CentrePoint[], n: number): CentrePoint {
  if (n <= pts[0].n) return pts[0];
  const last = pts[pts.length - 1];
  if (n >= last.n) return last;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].n <= n) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const u = (n - a.n) / (b.n - a.n || 1);
  const tx = a.tx + (b.tx - a.tx) * u;
  const tz = a.tz + (b.tz - a.tz) * u;
  const l = Math.hypot(tx, tz) || 1;
  return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, tx: tx / l, tz: tz / l, n };
}

/** The point `lateral` metres to the left (positive) or right (negative) of the centre line at distance n. */
export function offsetFromCentre(
  pts: readonly CentrePoint[],
  n: number,
  lateral: number,
): { x: number; z: number; tx: number; tz: number } {
  const c = interpolateCentre(pts, n);
  const l = leftOf(c.tx, c.tz);
  return { x: c.x + l.x * lateral, z: c.z + l.z * lateral, tx: c.tx, tz: c.tz };
}

export interface RowOptions {
  side: 1 | -1;
  frontageM: number;
  maxCount: number;
  skip: readonly [number, number] | null;
  gapM: number;
  clearanceM: number;
}

/**
 * One row of shophouses packed edge to edge along the centre line. Houses whose centre falls in `skip`, or whose
 * footprint comes within `clearanceM` of any part of the racing line, are left out (the slot is still consumed so
 * the remaining houses keep their positions).
 */
export function planHouseRow(
  path: CorridorPath,
  centre: readonly CentrePoint[],
  widths: readonly number[],
  rnd: () => number,
  o: RowOptions,
): HousePlacement[] {
  const out: HousePlacement[] = [];
  const total = centre[centre.length - 1].n;
  let n = 1;
  let slots = 0;
  while (slots < o.maxCount && n < total - 1) {
    const kind = Math.floor(rnd() * widths.length);
    const w = widths[kind];
    const nc = n + w / 2;
    n += w + o.gapM;
    slots++;
    if (nc > total - 1) break;
    if (o.skip && nc >= o.skip[0] && nc <= o.skip[1]) continue;
    const f = offsetFromCentre(centre, nc, o.side * o.frontageM);
    const l = leftOf(f.tx, f.tz);
    // Facing = towards the road = against the side the house stands on.
    const fx = -l.x * o.side;
    const fz = -l.z * o.side;
    const yaw = Math.atan2(fx, fz);
    // Footprint: width w, 14 m deep behind the facade (local −Z).
    const hd = HOUSE_DEPTH_M / 2 + 0.7;
    const c = rotateLocal(0, -(HOUSE_DEPTH_M / 2 - 0.7), yaw);
    if (rectClearanceToPath(path, f.x + c.x, f.z + c.z, w / 2, hd, yaw) < o.clearanceM) continue;
    out.push({ kind, n: nc, side: o.side, width: w, x: f.x, z: f.z, yaw });
  }
  return out;
}

export interface RunSample {
  x: number;
  z: number;
  tx: number;
  tz: number;
  /** Which contiguous run of paired road this sample belongs to. */
  run: number;
  /** Metres along the run. */
  arc: number;
}

/** Contiguous runs of the racing line that have a carriageway on the other side (i.e. the boulevard proper). */
export function boulevardRuns(path: CorridorPath, opp: Int32Array): number[][] {
  const n = path.count;
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (opp[i] < 0) {
      start = i;
      break;
    }
  }
  if (start < 0) return [Array.from({ length: n }, (_, i) => i)];
  const runs: number[][] = [];
  let cur: number[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (opp[i] >= 0) cur.push(i);
    else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length > 4);
}

/** Points every `stepM` along each run, starting `phaseM` in, offset to the right of travel (the outer kerb side). */
export function sidewalkSites(
  path: CorridorPath,
  runs: readonly number[][],
  stepM: number,
  phaseM: number,
  lateralM: number,
): RunSample[] {
  const out: RunSample[] = [];
  runs.forEach((run, ri) => {
    let arc = 0;
    let next = phaseM;
    for (let k = 0; k < run.length; k++) {
      const i = run[k];
      if (k > 0) arc += path.spacingM;
      while (arc >= next) {
        const tx = path.tx[i];
        const tz = path.tz[i];
        // Right of travel = −left.
        const l = leftOf(tx, tz);
        out.push({ x: path.px[i] - l.x * lateralM, z: path.pz[i] - l.z * lateralM, tx, tz, run: ri, arc: next });
        next += stepM;
      }
    }
  });
  return out;
}

/** Whole layout of the boulevard dressing, deterministic for a given path and spec. */
export function planCongHoa(
  path: CorridorPath,
  spec: DressingSpec,
  widths: readonly number[] = [6, 4, 5, 5],
): DressingPlan {
  const opp = findOpposites(path);
  const centre = corridorCentreline(path, opp, 2);
  const half = spec.carriagewayWidthM / 2;
  const sidewalkOuter = half + KERB_M + spec.sidewalkWidthM;
  const roadEdge = half + KERB_M;

  // Shophouse rows (west = +left of the outbound travel direction).
  const west = planHouseRow(path, centre, widths, seededRng(0xc0a1), {
    side: 1,
    frontageM: spec.frontageOffsetM,
    maxCount: spec.rowsWest,
    skip: [spec.fence.fromN, spec.fence.toN],
    gapM: 0.3,
    clearanceM: HOUSE_ROAD_CLEARANCE_M,
  });
  const east = planHouseRow(path, centre, widths, seededRng(0xea57), {
    side: -1,
    frontageM: spec.frontageOffsetM,
    maxCount: spec.rowsEast,
    skip: [spec.towers.fromN, spec.towers.toN],
    gapM: 0.3,
    clearanceM: HOUSE_ROAD_CLEARANCE_M,
  });
  const houses = [...west, ...east];

  // Airport fence tiles on the west side.
  const fence: Placement[] = [];
  const total = centre[centre.length - 1].n;
  for (let n = spec.fence.fromN; n <= Math.min(spec.fence.toN, total); n += 10.1) {
    const f = offsetFromCentre(centre, n, spec.fence.offsetM);
    if (minDistToPath(path, f.x, f.z) < sidewalkOuter + 2) continue;
    fence.push({ x: f.x, z: f.z, yaw: Math.atan2(f.tx, f.tz) });
  }

  // Office towers on the east side, evenly spread over their range (footprint 30 x 26 m).
  const towers: Placement[] = [];
  const span = (spec.towers.toN - spec.towers.fromN) / spec.towers.count;
  for (let i = 0; i < spec.towers.count; i++) {
    const n = spec.towers.fromN + (i + 0.5) * span;
    const f = offsetFromCentre(centre, n, -(spec.frontageOffsetM + 13));
    const l = leftOf(f.tx, f.tz);
    const yaw = Math.atan2(l.x, l.z); // front towards the road (the road is on the left of an east-side point)
    if (rectClearanceToPath(path, f.x, f.z, 15, 13, yaw) < HOUSE_ROAD_CLEARANCE_M) continue;
    towers.push({ x: f.x, z: f.z, yaw });
  }

  // Median tiles + trees (the median must sit between the carriageways, never on a road).
  const sites = medianSites(path, opp, spec.medianTileM).filter((s) => minDistToPath(path, s.x, s.z) >= roadEdge + 1.6);
  const median: Placement[] = sites.map((s) => ({ x: s.x, z: s.z, yaw: s.yaw }));
  const treeEvery = Math.max(1, Math.round(spec.medianTreesEveryM / spec.medianTileM));
  const medianTrees: KindPlacement[] = sites
    .filter((_, i) => i % treeEvery === 0)
    .map((s, i) => ({ x: s.x, z: s.z, yaw: s.yaw, kind: i % 2 }));

  // Sidewalk items on the outer kerb side of every boulevard carriageway.
  const runs = boulevardRuns(path, opp);
  const onSidewalk = (x: number, z: number): boolean => minDistToPath(path, x, z) >= roadEdge + 0.4;
  const poleSites = sidewalkSites(path, runs, spec.poleEveryM, 0, roadEdge + 2.6).filter((s) => onSidewalk(s.x, s.z));
  const poles: Placement[] = [];
  const spans: PoleSpan[] = [];
  let prev: { idx: number; run: number; arc: number } | null = null;
  for (const s of poleSites) {
    const idx = poles.length;
    poles.push({ x: s.x, z: s.z, yaw: Math.atan2(s.tx, s.tz) });
    if (prev && prev.run === s.run && Math.abs(s.arc - prev.arc - spec.poleEveryM) < 0.01)
      spans.push({ a: prev.idx, b: idx });
    prev = { idx, run: s.run, arc: s.arc };
  }

  const busSites = sidewalkSites(path, runs, spec.busStopEveryM, spec.busStopEveryM / 2, roadEdge + 1.9).filter((s) =>
    onSidewalk(s.x, s.z),
  );
  const busStops: Placement[] = busSites.map((s) => {
    const l = leftOf(s.tx, s.tz); // front faces the road = left of travel
    return { x: s.x, z: s.z, yaw: Math.atan2(l.x, l.z) };
  });

  const farFrom = (x: number, z: number, list: readonly Placement[], d: number): boolean =>
    list.every((p) => Math.hypot(p.x - x, p.z - z) >= d);
  const trees: KindPlacement[] = sidewalkSites(path, runs, spec.treeEveryM, spec.treeEveryM / 2, roadEdge + 1.5)
    .filter((s) => onSidewalk(s.x, s.z) && farFrom(s.x, s.z, busStops, 4) && farFrom(s.x, s.z, poles, 2.5))
    .map((s, i) => ({ x: s.x, z: s.z, yaw: Math.atan2(s.tx, s.tz), kind: i % 2 }));

  // Parked scooters: 0–4 per shophouse on the sidewalk in front of it.
  const rnd = seededRng(0x5c00);
  const scooters: KindPlacement[] = [];
  const [minS, maxS] = spec.scootersPerShop;
  const obstacles = [...trees, ...poles, ...busStops];
  for (const h of houses) {
    const count = minS + Math.floor(rnd() * (maxS - minS + 1));
    const fx = Math.sin(h.yaw);
    const fz = Math.cos(h.yaw);
    // Distance from the facade to the nearest carriageway centre line (≈ frontage − 9 m on the straight).
    const facadeToRoad = minDistToPath(path, h.x, h.z);
    for (let k = 0; k < count && scooters.length < MAX_PARKED_SCOOTERS; k++) {
      const along = (rnd() - 0.5) * Math.max(0.5, h.width - 1);
      const d = roadEdge + 0.9 + rnd() * (sidewalkOuter - roadEdge - 1.8); // distance from the carriageway centre
      const toRoad = facadeToRoad - d;
      // Along-road direction at the house (perpendicular to its facing).
      const ax = fz;
      const az = -fx;
      const x = h.x + fx * toRoad + ax * along;
      const z = h.z + fz * toRoad + az * along;
      const dist = minDistToPath(path, x, z);
      if (dist < roadEdge + 0.5 || dist > sidewalkOuter - 0.4) continue;
      if (!farFrom(x, z, obstacles, 1.6) || !farFrom(x, z, scooters, 0.9)) continue;
      const parallel = Math.atan2(ax, az) + (rnd() < 0.5 ? 0 : Math.PI);
      const yaw = rnd() < 0.7 ? parallel + (rnd() - 0.5) * 0.4 : h.yaw + (rnd() - 0.5) * 0.5;
      scooters.push({ x, z, yaw, kind: rnd() < 0.5 ? 0 : 1 });
    }
  }

  return { houses, fence, towers, median, medianTrees, poles, spans, trees, busStops, scooters };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const up = new THREE.Vector3(0, 1, 0);

function compose(x: number, y: number, z: number, yaw: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(up, yaw),
    new THREE.Vector3(1, 1, 1),
  );
}

const isShared = (m: THREE.Material): boolean => m.userData.shared === true;

/** Identity of a draw: merged vertex-colour materials by name, others by their look (so clones of one prop share). */
function materialKey(m: THREE.Material): string {
  if (isShared(m)) return m.name;
  const s = m as THREE.MeshStandardMaterial;
  // Each GLB embeds its own copy of the shared sign atlas: key textures by name + size so the copies merge into one draw.
  const tex = s.map
    ? s.map.name
      ? `${s.map.name}:${(s.map.image as { width?: number; height?: number } | null)?.width}x${(s.map.image as { width?: number; height?: number } | null)?.height}`
      : s.map.uuid
    : '';
  return `${m.name}|${tex}|${s.color?.getHex() ?? 0}|${s.emissive?.getHex() ?? 0}|${s.emissiveIntensity ?? 0}`;
}

/**
 * Bakes many placed copies of a few models into one static mesh per material (so e.g. 500 shophouses cost a handful
 * of draw calls and a single frustum sphere). Memory scales with triangles, so only use it for low-count content.
 */
class StaticBatch {
  private readonly buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();

  /** `proto` must have updated world matrices; `world` places the whole model. */
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

  /** Merges every bucket into a mesh. Returns the materials that ended up in use. */
  build(parent: THREE.Object3D, name: string): { meshes: THREE.Mesh[]; materials: Set<THREE.Material> } {
    const meshes: THREE.Mesh[] = [];
    const materials = new Set<THREE.Material>();
    for (const [key, b] of this.buckets) {
      if (!b.geos.length) continue;
      // Merging needs identical attribute sets: keep only the ones every piece has.
      const common = Object.keys(b.geos[0].attributes).filter((a) => b.geos.every((g) => g.getAttribute(a)));
      for (const g of b.geos) for (const a of Object.keys(g.attributes)) if (!common.includes(a)) g.deleteAttribute(a);
      const merged = mergeGeometries(b.geos, false);
      b.geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.name = `${name}:${key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      parent.add(mesh);
      meshes.push(mesh);
      materials.add(b.material);
    }
    this.buckets.clear();
    return { meshes, materials };
  }
}

/** Dressing for the daytime Cong Hoa Boulevard: shophouse rows, airport fence, office towers, median, poles, trees. */
export class CongHoaDressing {
  readonly group = new THREE.Group();
  /** The layout that was built (handy for debugging and tests). */
  readonly plan: DressingPlan;
  private readonly instanced: THREE.InstancedMesh[] = [];
  private readonly baked: THREE.Mesh[] = [];
  private readonly protos: THREE.Object3D[] = [];
  private readonly usedMaterials = new Set<THREE.Material>();
  private cables: THREE.Mesh | null = null;
  private poleProto: THREE.Object3D | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    _R: Rapier,
    _world: RAPIER.World,
    private readonly assets: Assets,
    track: TrackDef,
    path: TrackPath,
  ) {
    this.group.name = 'cong_hoa_dressing';
    const spec = specFromTrack(track.raw);
    const houseProtos = SHOPHOUSES.map((m) => this.prep(m));
    const widths = houseProtos.map((p) => {
      const b = new THREE.Box3().setFromObject(p);
      return Math.max(3, Math.round((b.max.x - b.min.x) * 10) / 10);
    });
    this.plan = planCongHoa(path, spec, widths);
    this.buildStatic(houseProtos);
    this.buildInstanced();
    this.buildCables();
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

  private buildStatic(houseProtos: THREE.Group[]): void {
    const p = this.plan;
    const batch = new StaticBatch();
    for (const h of p.houses) batch.add(houseProtos[h.kind], compose(h.x, 0, h.z, h.yaw));
    const fence = this.prep(FENCE);
    for (const f of p.fence) batch.add(fence, compose(f.x, 0, f.z, f.yaw));
    const tower = this.prep(TOWER);
    for (const t of p.towers) batch.add(tower, compose(t.x, 0, t.z, t.yaw));
    const median = this.prep(MEDIAN);
    for (const m of p.median) batch.add(median, compose(m.x, 0, m.z, m.yaw));
    const bus = this.prep(BUS_STOP);
    for (const b of p.busStops) batch.add(bus, compose(b.x, 0, b.z, b.yaw));
    const { meshes, materials } = batch.build(this.group, 'static');
    this.baked.push(...meshes);
    materials.forEach((m) => this.usedMaterials.add(m));
  }

  /** Per-sub-mesh InstancedMesh for content with many small copies. */
  private instance(model: string, mats: THREE.Matrix4[]): THREE.Object3D | null {
    if (!mats.length) return null;
    const proto = this.prep(model);
    const m = new THREE.Matrix4();
    proto.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      const inst = new THREE.InstancedMesh(o.geometry, o.material, mats.length);
      for (let k = 0; k < mats.length; k++) inst.setMatrixAt(k, m.multiplyMatrices(mats[k], o.matrixWorld));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = false;
      inst.receiveShadow = false;
      inst.computeBoundingSphere();
      this.group.add(inst);
      this.instanced.push(inst);
      this.usedMaterials.add(o.material);
    });
    return proto;
  }

  private buildInstanced(): void {
    const p = this.plan;
    for (let k = 0; k < TREES.length; k++) {
      const mats = [...p.medianTrees, ...p.trees].filter((t) => t.kind === k).map((t) => compose(t.x, 0, t.z, t.yaw));
      this.instance(TREES[k], mats);
    }
    this.poleProto = this.instance(
      POLE,
      p.poles.map((q) => compose(q.x, 0, q.z, q.yaw)),
    );
    for (let k = 0; k < SCOOTERS.length; k++) {
      this.instance(
        SCOOTERS[k],
        p.scooters.filter((s) => s.kind === k).map((s) => compose(s.x, 0, s.z, s.yaw)),
      );
    }
  }

  /** Sagging cables between consecutive poles: every span × 4 wires as thin square tubes, one merged mesh. */
  private buildCables(): void {
    const p = this.plan;
    if (!p.spans.length || !this.poleProto) return;
    const pole = this.poleProto;
    const anchors: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) {
      const a = pole.getObjectByName(`cable_${i}`);
      if (a) anchors.push(new THREE.Vector3().setFromMatrixPosition(a.matrixWorld));
    }
    const pos: number[] = [];
    const idx: number[] = [];
    const SEG = 6;
    const R = 0.025;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const ctrl = new THREE.Vector3();
    const pt = new THREE.Vector3();
    const prev = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const side = new THREE.Vector3();
    const upv = new THREE.Vector3();
    const world = (q: Placement, anchor: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 => {
      const o = rotateLocal(anchor.x, anchor.z, q.yaw);
      return out.set(q.x + o.x, anchor.y, q.z + o.z);
    };
    for (const s of p.spans) {
      for (const anchor of anchors) {
        world(p.poles[s.a], anchor, a);
        world(p.poles[s.b], anchor, b);
        ctrl.copy(a).add(b).multiplyScalar(0.5);
        ctrl.y -= 1.4; // quadratic control point below the chord: ~0.7 m sag at mid span
        for (let k = 0; k <= SEG; k++) {
          const u = k / SEG;
          // Quadratic Bezier.
          pt.set(
            (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * ctrl.x + u * u * b.x,
            (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * ctrl.y + u * u * b.y,
            (1 - u) * (1 - u) * a.z + 2 * (1 - u) * u * ctrl.z + u * u * b.z,
          );
          if (k > 0) {
            dir.copy(pt).sub(prev).normalize();
            side.crossVectors(dir, up).normalize();
            upv.crossVectors(side, dir).normalize();
          } else {
            dir.copy(b).sub(a).normalize();
            side.crossVectors(dir, up).normalize();
            upv.crossVectors(side, dir).normalize();
          }
          const ring: [number, number][] = [
            [R, R],
            [-R, R],
            [-R, -R],
            [R, -R],
          ];
          const start = pos.length / 3;
          for (const [sx, sy] of ring) {
            pos.push(pt.x + side.x * sx + upv.x * sy, pt.y + side.y * sx + upv.y * sy, pt.z + side.z * sx + upv.z * sy);
          }
          if (k > 0) {
            const prevStart = start - 4;
            for (let r = 0; r < 4; r++) {
              const r2 = (r + 1) % 4;
              idx.push(prevStart + r, start + r, start + r2, prevStart + r, start + r2, prevStart + r2);
            }
          }
          prev.copy(pt);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: '#26282B', roughness: 0.9, metalness: 0.1, flatShading: true });
    this.cables = new THREE.Mesh(geo, mat);
    this.cables.name = 'cables';
    this.group.add(this.cables);
  }

  dispose(): void {
    // Geometry of instanced props is owned by Assets / the merge cache (shared between races); baked meshes own theirs.
    for (const m of this.instanced) m.dispose();
    for (const m of this.baked) m.geometry.dispose();
    if (this.cables) {
      this.cables.geometry.dispose();
      (this.cables.material as THREE.Material).dispose();
    }
    // Per-clone materials (not the shared merged ones) are ours to free: used ones once, unused clones too.
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
