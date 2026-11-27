import type { TrackDef } from '../core/Data';
import type { TrackPath } from './TrackPath';
import { PIECE_M, RoadIndex, curvatureAt, frameAt, yawForX, type Obstacle, type Piece } from './monteCarloLayout';

/**
 * Pure layout planning for Map 6 (Ardennes Forest Circuit): the heightmap decode, the 16 m terrain grid shaved under the
 * road ribbon, its splat colours, the deterministic forest and ground-scatter sampling, the placement list and the
 * barrier / sign / bridge planning. No DOM, no three.js scene, no assets: unit tested. Positions are world metres
 * (x east, z = -north); `yaw` rotates about +Y like three's `rotation.y`.
 *
 * Model frames (Map 5 and Map 6 GLBs alike): a linear piece lies along local Z with its front (the face that meets the
 * road) at local +X, so `yawForX(towards the road)` aims a stand, an Armco piece or a sign at the track.
 * The JSON's `lat` / `lateralM` is metres to the RIGHT of the driving direction (generator convention).
 */

// ------------------------------------------------------------------------------------------------ heightmap

export interface TerrainMeta {
  bounds: { xMin: number; xMax: number; nMin: number; nMax: number };
  size: [number, number];
  height: { min: number; max: number };
}

/** RGBA pixels as `getImageData` returns them (row 0 = the north edge). */
export interface Pixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/** `height = (R * 256 + G) / 65535 * (max - min) + min` (16 bit in R + G; -30..230 m for Map 6). */
export function decodeHeight(r: number, g: number, meta: Pick<TerrainMeta, 'height'>): number {
  return ((r * 256 + g) / 65535) * (meta.height.max - meta.height.min) + meta.height.min;
}

/** Bilinear sampling of the heightmap, forest mask and splat map by world position. */
export class HeightField {
  constructor(
    readonly meta: TerrainMeta,
    private readonly heightPx: Pixels,
    private readonly maskPx: Pixels,
    private readonly splatPx: Pixels | null = null,
  ) {}

  private bilinear(px: Pixels, x: number, z: number, at: (d: ArrayLike<number>, k: number) => number): number {
    const { bounds: b } = this.meta;
    const { width: w, height: h, data } = px;
    const u = Math.min(w - 1, Math.max(0, ((x - b.xMin) / (b.xMax - b.xMin)) * (w - 1)));
    const v = Math.min(h - 1, Math.max(0, ((b.nMax + z) / (b.nMax - b.nMin)) * (h - 1)));
    const i = Math.min(w - 2, Math.floor(u));
    const j = Math.min(h - 2, Math.floor(v));
    const fu = u - i;
    const fv = v - j;
    const g = (ii: number, jj: number): number => at(data, (jj * w + ii) * 4);
    return (g(i, j) * (1 - fu) + g(i + 1, j) * fu) * (1 - fv) + (g(i, j + 1) * (1 - fu) + g(i + 1, j + 1) * fu) * fv;
  }

  /** Natural ground height (m) at world (x, z), before the road shaves it. */
  heightAt(x: number, z: number): number {
    return this.bilinear(this.heightPx, x, z, (d, k) => decodeHeight(d[k], d[k + 1], this.meta));
  }

  /** Forest mask 0..1 (the R channel). */
  forestAt(x: number, z: number): number {
    return this.bilinear(this.maskPx, x, z, (d, k) => d[k] / 255);
  }

  /** Map 7's landcover: channel 0 forest, 1 paddy, 2 built-up, 3 inverted water (alpha), each 0..1. */
  channelAt(x: number, z: number, channel: number): number {
    return this.bilinear(this.maskPx, x, z, (d, k) => d[k + channel] / 255);
  }

  /** Splat R: 1 on the verge ring along the road, 0 elsewhere (G is the forest floor). */
  splatAt(x: number, z: number): number {
    return this.splatPx ? this.bilinear(this.splatPx, x, z, (d, k) => d[k] / 255) : 0;
  }
}

// ------------------------------------------------------------------------------------------------ ground under the road

/** The land is shaved this far under the road surface so the carriageway never z-fights with it. */
export const ROAD_DROP_M = 0.35;
/** Within `NEAR_M` of the centre line the ground follows the road; it blends to the natural hills by `FAR_M`. */
export const GROUND_NEAR_M = 24;
export const GROUND_FAR_M = 52;

const smoothstep = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

export interface RoadHit {
  /** Distance to the centre line (m). */
  d: number;
  /** Road height at the foot of the perpendicular. */
  y: number;
  /** Lap fraction of the foot. */
  t: number;
}

/** Nearest point on the centre-line polyline (not just the nearest sample) so the height follows the slope exactly. */
export function projectRoad(index: RoadIndex, x: number, z: number, maxM: number): RoadHit | null {
  const { i, d } = index.nearest(x, z, maxM);
  if (i < 0 || d > maxM) return null;
  const n = index.count;
  let best: RoadHit | null = null;
  for (const a of [(i + n - 1) % n, i]) {
    const b = (a + 1) % n;
    const ax = index.xs[a];
    const az = index.zs[a];
    const dx = index.xs[b] - ax;
    const dz = index.zs[b] - az;
    const len2 = dx * dx + dz * dz || 1;
    const k = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2));
    const dist = Math.hypot(x - (ax + dx * k), z - (az + dz * k));
    if (!best || dist < best.d) {
      const ta = index.ts[a];
      const tb = b === 0 ? 1 : index.ts[b];
      best = { d: dist, y: index.ys[a] + (index.ys[b] - index.ys[a]) * k, t: ta + (tb - ta) * k };
    }
  }
  return best;
}

/** Ground height: the road's own height (minus the drop) next to it, the natural hills away from it. */
export function carvedHeight(natural: number, roadY: number, d: number): number {
  const w = smoothstep(GROUND_NEAR_M, GROUND_FAR_M, d);
  return (roadY - ROAD_DROP_M) * (1 - w) + natural * w;
}

export interface GroundSample {
  y: number;
  /** Distance to the road centre line, `Infinity` beyond `GROUND_FAR_M`. */
  roadD: number;
}

/** The land as the game sees it: heightmap + road carving. Shared by the mesh, the collider and every placement. */
export class GroundField {
  constructor(
    readonly height: HeightField,
    readonly index: RoadIndex,
  ) {}

  sample(x: number, z: number, out: GroundSample = { y: 0, roadD: Infinity }): GroundSample {
    const natural = this.height.heightAt(x, z);
    const hit = projectRoad(this.index, x, z, GROUND_FAR_M);
    out.roadD = hit ? hit.d : Infinity;
    out.y = hit ? carvedHeight(natural, hit.y, hit.d) : natural;
    return out;
  }

  heightAt(x: number, z: number): number {
    return this.sample(x, z).y;
  }
}

// ------------------------------------------------------------------------------------------------ terrain grid

export interface TerrainGrid {
  x0: number;
  z0: number;
  cell: number;
  /** Vertices per row / column. */
  nx: number;
  nz: number;
  heights: Float32Array;
  /** Distance to the road per vertex (`Infinity` far away). */
  roadD: Float32Array;
}

/** The terrain grid (~16 m cells) over the whole heightmap, lowered under the road ribbon. */
export function buildTerrainGrid(ground: GroundField, cellM = 16): TerrainGrid {
  const { bounds: b } = ground.height.meta;
  const x0 = b.xMin;
  const z0 = -b.nMax;
  const nx = Math.ceil((b.xMax - b.xMin) / cellM) + 1;
  const nz = Math.ceil((b.nMax - b.nMin) / cellM) + 1;
  const heights = new Float32Array(nx * nz);
  const roadD = new Float32Array(nx * nz);
  const s: GroundSample = { y: 0, roadD: 0 };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      ground.sample(x0 + i * cellM, z0 + j * cellM, s);
      heights[j * nx + i] = s.y;
      roadD[j * nx + i] = s.roadD;
    }
  }
  return { x0, z0, cell: cellM, nx, nz, heights, roadD };
}

/** Smooth vertex normals from central differences (no seams between chunks). */
export function gridNormal(grid: TerrainGrid, i: number, j: number, out: [number, number, number]): void {
  const { nx, nz, heights, cell } = grid;
  const h = (a: number, b: number): number =>
    heights[Math.min(nz - 1, Math.max(0, b)) * nx + Math.min(nx - 1, Math.max(0, a))];
  const dx = (h(i + 1, j) - h(i - 1, j)) / (2 * cell);
  const dz = (h(i, j + 1) - h(i, j - 1)) / (2 * cell);
  const l = Math.hypot(dx, 1, dz);
  out[0] = -dx / l;
  out[1] = 1 / l;
  out[2] = -dz / l;
}

/** Cell index ranges [i0, i1) x [j0, j1) of `chunk` x `chunk` cell tiles covering the grid. */
export function gridChunks(grid: TerrainGrid, chunk = 64): { i0: number; i1: number; j0: number; j1: number }[] {
  const out: { i0: number; i1: number; j0: number; j1: number }[] = [];
  for (let j0 = 0; j0 < grid.nz - 1; j0 += chunk) {
    for (let i0 = 0; i0 < grid.nx - 1; i0 += chunk) {
      out.push({ i0, i1: Math.min(grid.nx - 1, i0 + chunk), j0, j1: Math.min(grid.nz - 1, j0 + chunk) });
    }
  }
  return out;
}

/**
 * Triangle mesh of the cells whose nearest corner lies within `maxRoadM` of the road: the part of the land a car can
 * reach (the side walls stand ~19 m out), kept small so the baked server collider stays light.
 */
export function terrainBand(grid: TerrainGrid, maxRoadM: number): { positions: Float32Array; indices: Uint32Array } {
  const { nx, nz, cell, x0, z0, heights, roadD } = grid;
  const remap = new Int32Array(nx * nz).fill(-1);
  const pos: number[] = [];
  const idx: number[] = [];
  const vert = (i: number, j: number): number => {
    const k = j * nx + i;
    if (remap[k] < 0) {
      remap[k] = pos.length / 3;
      pos.push(x0 + i * cell, heights[k], z0 + j * cell);
    }
    return remap[k];
  };
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i;
      if (Math.min(roadD[k], roadD[k + 1], roadD[k + nx], roadD[k + nx + 1]) > maxRoadM) continue;
      const a = vert(i, j);
      const b = vert(i + 1, j);
      const c = vert(i, j + 1);
      const d = vert(i + 1, j + 1);
      // Wound so the face normal points up (+Y).
      idx.push(a, c, b, b, c, d);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

// ------------------------------------------------------------------------------------------------ colours

/** Low-frequency value noise stand-in: smooth, deterministic, no allocation. */
export function groundNoise(x: number, z: number): [number, number] {
  return [
    (Math.sin(x * 0.05) * Math.cos(z * 0.043) + 1) * 0.5,
    (Math.sin(x * 0.013 + 1) * Math.cos(z * 0.017) + 1) * 0.5,
  ];
}

const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];
const GRASS = hex('#5D8A3A');
const FLOOR = hex('#26331F');
const MEADOW = hex('#7A8A4A');
const DRY = hex('#8A7A52');

/**
 * Terrain vertex colour (sRGB 0..1) multiplying the tiled grass texture: bright grass, meadow and dry patches in the
 * open, dark forest floor where the mask is high. `splatR` pulls the road-side verge back to clean grass.
 */
export function terrainColor(
  forest: number,
  splatR: number,
  noiseA: number,
  noiseB: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const mix = (a: number, b: number, k: number): number => a + (b - a) * k;
  const m = noiseA * 0.55;
  const dry = Math.max(0, noiseB - 0.7) * 0.8;
  const f = Math.min(1, forest * 1.15) * (1 - splatR * 0.85);
  for (let c = 0; c < 3; c++) {
    let v = mix(GRASS[c], MEADOW[c], m);
    v = mix(v, DRY[c], dry);
    out[c] = mix(v, FLOOR[c], f);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ deterministic sampling

/** Integer hash to [0, 1): the same cell always gives the same tree, however the camera moves. */
export function hash2(i: number, j: number, salt = 0): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul((j | 0) + salt * 0x9e3779b1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Circle footprints the forest and the scatter keep clear of (villages, campsite, stands, pits, pasture). */
export class ExclusionGrid {
  private readonly cells = new Map<number, [number, number, number][]>();
  constructor(
    sites: readonly Obstacle[],
    private readonly cell = 32,
  ) {
    for (const s of sites) {
      const i0 = Math.floor((s.x - s.r) / cell);
      const i1 = Math.floor((s.x + s.r) / cell);
      const j0 = Math.floor((s.z - s.r) / cell);
      const j1 = Math.floor((s.z + s.r) / cell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = i * 100003 + j;
          const list = this.cells.get(k);
          if (list) list.push([s.x, s.z, s.r]);
          else this.cells.set(k, [[s.x, s.z, s.r]]);
        }
      }
    }
  }

  hit(x: number, z: number): boolean {
    const list = this.cells.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!list) return false;
    for (const [cx, cz, r] of list) if ((x - cx) * (x - cx) + (z - cz) * (z - cz) < r * r) return true;
    return false;
  }
}

export interface Tree {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** Which model variant (0..variants-1). */
  variant: number;
  /** Per-instance tint as HSL (hue 0.24-0.30, saturation 0.25-0.55, lightness 0.42-0.64). */
  tint: [number, number, number];
}

export interface ForestRules {
  /** Grid cell (m): one candidate per cell, so the density is 1 / cell² (9 m = one per ~80 m²). */
  cellM: number;
  /** Nothing grows nearer than this to the centre line (the Armco stands at 19.5 m). */
  roadClearM: number;
  /** Forest mask threshold. */
  maskMin: number;
  /** Chance that a qualifying cell actually has a tree. */
  keep: number;
  variants: number;
  salt: number;
}

export const FOREST: ForestRules = { cellM: 9, roadClearM: 23, maskMin: 0.5, keep: 0.85, variants: 4, salt: 1 };

/**
 * Trees of the cells whose jittered centre falls between `innerM` and `outerM` of (cx, cz): wherever the forest mask is
 * above `maskMin`, off the road and clear of `skip`. A pure function of the cell grid, so re-centring never reshuffles
 * the forest.
 */
export function forestTrees(
  ground: GroundField,
  skip: ExclusionGrid | null,
  cx: number,
  cz: number,
  innerM: number,
  outerM: number,
  rules: ForestRules = FOREST,
): Tree[] {
  const out: Tree[] = [];
  const c = rules.cellM;
  const i0 = Math.floor((cx - outerM) / c);
  const i1 = Math.ceil((cx + outerM) / c);
  const j0 = Math.floor((cz - outerM) / c);
  const j1 = Math.ceil((cz + outerM) / c);
  const s: GroundSample = { y: 0, roadD: 0 };
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (hash2(i, j, rules.salt) > rules.keep) continue;
      const x = (i + hash2(i, j, rules.salt + 11)) * c;
      const z = (j + hash2(i, j, rules.salt + 12)) * c;
      const dc2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (dc2 < innerM * innerM || dc2 > outerM * outerM) continue;
      if (ground.height.forestAt(x, z) < rules.maskMin) continue;
      ground.sample(x, z, s);
      if (s.roadD < rules.roadClearM) continue;
      if (skip?.hit(x, z)) continue;
      out.push({
        x,
        y: s.y - 0.3,
        z,
        yaw: hash2(i, j, rules.salt + 13) * Math.PI * 2,
        scale: 0.8 + hash2(i, j, rules.salt + 14) * 0.45,
        variant: Math.floor(hash2(i, j, rules.salt + 15) * rules.variants) % rules.variants,
        tint: [
          0.24 + hash2(i, j, rules.salt + 16) * 0.06,
          0.25 + hash2(i, j, rules.salt + 17) * 0.3,
          0.42 + hash2(i, j, rules.salt + 18) * 0.22,
        ],
      });
    }
  }
  return out;
}

export interface Scatter {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** 0 = grass tuft A, 1 = tuft B, 2 = rock cluster. */
  kind: number;
}

/** Grass tufts and the odd rock within `radiusM` of the camera: > 10 m off the road, sparse inside the forest. */
export function groundScatter(
  ground: GroundField,
  skip: ExclusionGrid | null,
  cx: number,
  cz: number,
  radiusM: number,
  cellM: number,
  rockEvery = 25,
): Scatter[] {
  const out: Scatter[] = [];
  const i0 = Math.floor((cx - radiusM) / cellM);
  const i1 = Math.ceil((cx + radiusM) / cellM);
  const j0 = Math.floor((cz - radiusM) / cellM);
  const j1 = Math.ceil((cz + radiusM) / cellM);
  const s: GroundSample = { y: 0, roadD: 0 };
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = (i + hash2(i, j, 31)) * cellM;
      const z = (j + hash2(i, j, 32)) * cellM;
      if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > radiusM * radiusM) continue;
      if (ground.height.forestAt(x, z) > 0.6 && hash2(i, j, 33) < 0.6) continue;
      ground.sample(x, z, s);
      if (s.roadD < 10) continue;
      if (skip?.hit(x, z)) continue;
      const r = hash2(i, j, 34);
      out.push({
        x,
        y: s.y - 0.05,
        z,
        yaw: hash2(i, j, 35) * Math.PI * 2,
        scale: 0.45 + hash2(i, j, 36) * 0.6,
        kind: r < 1 / rockEvery ? 2 : r < 0.5 + 0.5 / rockEvery ? 0 : 1,
      });
    }
  }
  return out;
}

/** True when (x, z) lies in front of the camera: inside `nearM`, or within the wedge of half-angle acos(cosHalf). */
export function inViewWedge(
  dx: number,
  dz: number,
  dirX: number,
  dirZ: number,
  cosHalf: number,
  nearM: number,
): boolean {
  const d2 = dx * dx + dz * dz;
  if (d2 < nearM * nearM) return true;
  return dx * dirX + dz * dirZ >= cosHalf * Math.sqrt(d2);
}

// ------------------------------------------------------------------------------------------------ placements

export interface PlacementRow {
  model: string;
  x: number;
  z: number;
  rotY: number;
  t?: number;
  lat?: number;
  scale?: number;
  yOff?: number;
  /** 'road': the road height at `t`; otherwise the ground height at (x, z). */
  y?: string;
  label?: string;
}

export interface PlacementData {
  models: Record<string, string>;
  groups: Record<string, PlacementRow[]>;
}

export interface PlacementInstance {
  group: string;
  /** GLB path (the row's model key resolved through `models`). */
  model: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
}

/** How far from the camera (m) each placement group is still drawn. */
export const PLACEMENT_WINDOW_M: Record<string, number> = {
  kerbs: 450,
  grass: 150,
  marshals: 450,
  paddock: 700,
  landmarks: 700,
  crowd: 160,
  campsite: 500,
  villages: 900,
  pasture: 450,
  broadcast: 900,
};

/** Groups that stay clear of the forest and scatter: footprints (radius m) around their objects. */
export const PLACEMENT_CLEAR_M: Record<string, number> = {
  paddock: 12,
  landmarks: 14,
  campsite: 14,
  villages: 16,
  pasture: 8,
  broadcast: 10,
};

/** Resolves every row to a world pose: Y from the road at `t` (`y: "road"`) or the ground, plus `yOff`. */
export function planPlacements(
  data: PlacementData,
  ground: GroundField,
  roadYAt: (t: number) => number,
): PlacementInstance[] {
  const out: PlacementInstance[] = [];
  for (const [group, rows] of Object.entries(data.groups)) {
    for (const r of rows) {
      const model = data.models[r.model];
      if (!model) continue;
      const base = r.y === 'road' && r.t !== undefined ? roadYAt(r.t) : ground.heightAt(r.x, r.z) - 0.05;
      out.push({ group, model, x: r.x, y: base + (r.yOff ?? 0), z: r.z, rotY: r.rotY, scale: r.scale ?? 1 });
    }
  }
  return out;
}

/** Groups and models that belong at the road edge (or on it): everything else must stand clear of the carriageway. */
const ROADSIDE_GROUPS = new Set(['kerbs', 'grass', 'landmarks', 'marshals']);
const ROADSIDE_MODEL = /marshal_hut|brook_culvert/;
const PIT_WALL = /pit_wall/;
/** The pit wall is 40 m long: it stays only where every point along it keeps this far from the carriageway. */
const PIT_WALL_CLEAR_M = 8;
/** Rough footprint radius (m) per model family, for keeping props off the road. */
const FOOTPRINT_M: [RegExp, number][] = [
  [/hospitality_/, 9],
  [/transporter_/, 6],
  [/race_control|customs_house|ardennes_house_|village_church/, 9],
  [/big_screen|tv_tower/, 4],
  [/spectators_|campervan_|tent_/, 3.5],
];
/** Carriageway half width (15 m road) plus its kerbs. */
export const ROAD_CLEAR_M = 9.5;

/**
 * Drops the props whose footprint reaches onto the carriageway. The design placements were authored against the
 * spline, but a few paddock rows (hospitality, transporters, spectators) land on the La Source return leg.
 */
export function dropOnRoad(
  items: readonly PlacementInstance[],
  roadDistance: (x: number, z: number) => number,
): PlacementInstance[] {
  return items.filter((it) => {
    if (ROADSIDE_GROUPS.has(it.group) || ROADSIDE_MODEL.test(it.model)) return true;
    if (PIT_WALL.test(it.model)) {
      // Its long axis is local Z: a wall that runs on past the end of the straight would cut across La Source.
      const ax = Math.sin(it.rotY);
      const az = Math.cos(it.rotY);
      return [-20, -10, 0, 10, 20].every((k) => roadDistance(it.x + ax * k, it.z + az * k) >= PIT_WALL_CLEAR_M);
    }
    const r = FOOTPRINT_M.find(([re]) => re.test(it.model))?.[1] ?? 3;
    return roadDistance(it.x, it.z) >= ROAD_CLEAR_M + r;
  });
}

/** Crowds are 3,000+ triangles a group: only worth drawing close up, whichever group places them. */
export const CROWD_WINDOW_M = 160;

/**
 * Static props are baked into one mesh per material per square chunk of this size (m). The grid is offset so the
 * pit straight, paddock and La Source (x -450..150, z -200..400) sit inside ONE chunk: at the start the camera sees
 * one chunk's few materials instead of four chunks' worth.
 */
export const BAKE_CHUNK_M = 600;
export const BAKE_ORIGIN: readonly [number, number] = [-450, -200];

/** The chunk a position falls in. */
export const chunkOf = (x: number, z: number, size = BAKE_CHUNK_M): [number, number] => [
  Math.floor((x - BAKE_ORIGIN[0]) / size),
  Math.floor((z - BAKE_ORIGIN[1]) / size),
];

/** World position of a chunk's centre (x, z). */
export const chunkCentre = (cx: number, cz: number, size = BAKE_CHUNK_M): [number, number] => [
  BAKE_ORIGIN[0] + (cx + 0.5) * size,
  BAKE_ORIGIN[1] + (cz + 0.5) * size,
];

/**
 * Placements that stay instanced with a draw window: the kerbs and grass tufts (hundreds, only worth drawing close)
 * and the crowds (3,000+ triangles a group). Everything else is baked into the chunk meshes.
 */
export const STAYS_INSTANCED = /kerb_3d_4m|sausage_kerb_4m|grass_patch_|spectators_/;

/** One instanced set per GLB and draw window (a model used by two groups with different windows gets two sets). */
export function groupByModel(
  items: readonly PlacementInstance[],
): { model: string; windowM: number; items: PlacementInstance[] }[] {
  const out = new Map<string, { model: string; windowM: number; items: PlacementInstance[] }>();
  for (const it of items) {
    let w = PLACEMENT_WINDOW_M[it.group] ?? 500;
    if (/spectators_/.test(it.model)) w = Math.min(w, CROWD_WINDOW_M);
    const key = `${it.model}|${w}`;
    let e = out.get(key);
    if (!e) {
      e = { model: it.model, windowM: w, items: [] };
      out.set(key, e);
    }
    e.items.push(it);
  }
  return [...out.values()];
}

/** Circles the forest keeps out of: the footprints of the groups in `PLACEMENT_CLEAR_M`. */
export function placementClearances(items: readonly PlacementInstance[]): Obstacle[] {
  const out: Obstacle[] = [];
  for (const it of items) {
    const r = PLACEMENT_CLEAR_M[it.group];
    if (r) out.push({ x: it.x, z: it.z, r });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ road-relative planning

export interface RoadPose {
  x: number;
  y: number;
  z: number;
  /** Unit tangent (x, z). */
  tx: number;
  tz: number;
}

const wrap01 = (t: number): number => ((t % 1) + 1) % 1;

/** The point `latRight` metres to the right of the driving line at lap fraction `t` (negative = left). */
export function roadPose(path: TrackPath, t: number, latRight = 0): RoadPose {
  const f = frameAt(path, wrap01(t));
  return { x: f.x - f.lx * latRight, y: f.y, z: f.z - f.lz * latRight, tx: f.tx, tz: f.tz };
}

/** Yaw that turns a model's front (+X) to face the oncoming drivers (against the direction of travel). */
export const yawFacingDrivers = (p: Pick<RoadPose, 'tx' | 'tz'>): number => yawForX(-p.tx, -p.tz);

/** Yaw that turns a model's front (+X) towards the road from (x, z), by the nearest centre-line sample. */
export function yawTowardsRoad(index: RoadIndex, x: number, z: number): number {
  const { i } = index.nearest(x, z, 300);
  return i < 0 ? 0 : yawForX(index.xs[i] - x, index.zs[i] - z);
}

export interface SignSite {
  model: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface CornerRow {
  id: string;
  name: string;
  t: number;
}

/**
 * Corner sign boards, distance boards before the named corners and the big screens, from the track JSON. (The TV
 * towers of `tvTowers` are also in the placements' `broadcast` group, which draws them.)
 */
export function planSigns(path: TrackPath, def: TrackDef): SignSite[] {
  const raw = def.raw as {
    signs: {
      corners: { model: string; t: number; lateralM: number }[];
      distanceBoards: { models: string[]; before: string[]; lateralM: number };
    };
    screens: { model: string; t: number; lateralM: number }[];
    corners: CornerRow[];
  };
  const len = path.lengthM;
  const out: SignSite[] = [];
  const put = (model: string, t: number, lat: number, facing: 'drivers' | 'road'): void => {
    const p = roadPose(path, t, lat);
    const c = roadPose(path, t, 0);
    const yaw = facing === 'drivers' ? yawFacingDrivers(p) : yawForX(c.x - p.x, c.z - p.z);
    out.push({ model, x: p.x, y: p.y, z: p.z, yaw });
  };
  for (const s of raw.signs.corners) put(s.model, s.t, s.lateralM, 'drivers');
  const db = raw.signs.distanceBoards;
  for (const name of db.before) {
    const corner = raw.corners.find((c) => c.name.startsWith(name));
    if (!corner) continue;
    // 300, 200 and 100 m before the apex (the braking zone starts a little earlier on the real circuit).
    [300, 200, 100].forEach((d, k) => {
      const model = db.models[k];
      if (model) put(model, corner.t - d / len, db.lateralM, 'drivers');
    });
  }
  for (const s of raw.screens) put(s.model, s.t, s.lateralM, 'road');
  return out;
}

export interface BridgeSite {
  model: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Footbridges: the model's long axis (local X, 30 m back to 4 m forward of its origin) spans the carriageway. */
export function planBridges(path: TrackPath, def: TrackDef): BridgeSite[] {
  const bridges = (def.raw.bridges as { model: string; t: number }[] | undefined) ?? [];
  return bridges.map((b) => {
    // Origin 15 m to the right of the line; local +X points right, so the deck runs from 15 m left to 19 m right.
    const p = roadPose(path, b.t, 15);
    return { model: b.model, x: p.x, y: p.y, z: p.z, yaw: yawForX(-p.tz, p.tx) };
  });
}

export interface StandSite {
  model: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Grandstand and hillside-stand segments, pushed away from the road until they clear the Armco line, and oriented to
 * face the road. Segments that cannot clear within 40 m are dropped.
 */
export function planStands(def: TrackDef, index: RoadIndex, clearanceM: number, maxShiftM = 40): StandSite[] {
  const stands = (def.raw.grandstands as { segments: { model: string; position: [number, number, number] }[] }[]) ?? [];
  const out: StandSite[] = [];
  for (const g of stands) {
    for (const s of g.segments) {
      let x = s.position[0];
      let z = s.position[2];
      for (let shift = 0; shift <= maxShiftM; shift += 2) {
        if (footprintClear(index, x, z, clearanceM)) {
          out.push({ model: s.model, x, y: s.position[1], z, yaw: yawTowardsRoad(index, x, z) });
          break;
        }
        const { i } = index.nearest(x, z, 300);
        if (i < 0) break;
        const dx = x - index.xs[i];
        const dz = z - index.zs[i];
        const l = Math.hypot(dx, dz) || 1;
        x += (dx / l) * 2;
        z += (dz / l) * 2;
      }
    }
  }
  return out;
}

/** The front corners and middle of a 40 m stand (front 1.3 m, back 16 m) keep `clearanceM` from the centre line. */
function footprintClear(index: RoadIndex, x: number, z: number, clearanceM: number): boolean {
  const th = yawTowardsRoad(index, x, z);
  const c = Math.cos(th);
  const s = Math.sin(th);
  for (const lx of [1.3, -4]) {
    for (const lz of [-20.5, 0, 20.5]) {
      if (index.nearest(x + lx * c + lz * s, z - lx * s + lz * c, 300).d < clearanceM) return false;
    }
  }
  return true;
}

// ------------------------------------------------------------------------------------------------ barriers

/** Armco / tecpro stand at this lateral offset; the generic wall collider sits 0.2 m inside it. */
export const BARRIER_LATERAL_FALLBACK_M = 19.5;
/** Metres a tecpro block's body (x 0..0.9) or a tyre stack (x 0.1..0.8) sticks out in front of its origin. */
const TECPRO_DEPTH_M = 0.9;
const TYRE_DEPTH_M = 0.8;

export interface BarrierPlan {
  armco: Piece[];
  fence: Piece[];
  tyres: Piece[];
  tecpro: Piece[];
}

/** One 4 m piece beside the road (`side` +1 = left, -1 = right), its front (+X) turned to the road. */
function pieceAt(path: TrackPath, s: number, side: number, lateral: number): Piece {
  const f = frameAt(path, wrap01(s / path.lengthM));
  return {
    x: f.x + side * f.lx * lateral,
    y: f.y,
    z: f.z + side * f.lz * lateral,
    yaw: yawForX(-side * f.lx, -side * f.lz),
    ad: -1,
  };
}

/** The corners that get a tecpro wall on their outside (`barriers.tecpro.where`). */
const TECPRO_CORNERS = ['La Source', 'Raidillon', 'Les Combes', 'Bus Stop'];

/**
 * Armco on both sides of the whole lap every 4 m (every `adEvery`-th piece carries a sponsor panel), tecpro blocks
 * on the outside of the named corners, the tyre walls of the JSON and a catch fence behind the Armco near the
 * spectators (`fenceSites`). The wall colliders sit at `armco.lateralM - 0.2`, so the faces line up.
 */
export function planBarriers(path: TrackPath, def: TrackDef, fenceSites: readonly Obstacle[]): BarrierPlan {
  const b = def.raw.barriers as {
    armco: { lateralM: number; adEvery: number; adModels: string[] };
    tyreWalls: { t: number; side: string; count: number }[];
  };
  const raw = def.raw as { corners: CornerRow[] };
  const len = path.lengthM;
  const lateral = b.armco.lateralM;
  const n = Math.floor(len / PIECE_M);
  const spans: { side: number; from: number; to: number }[] = [];
  const tyres: Piece[] = [];
  const tecpro: Piece[] = [];
  const outsideAt = (s: number): number => (curvatureAt(path, s) > 0 ? -1 : 1);
  for (const w of b.tyreWalls) {
    const apex = w.t * len;
    const side = outsideAt(apex);
    const start = apex - (w.count * PIECE_M) / 2;
    spans.push({ side, from: start, to: start + w.count * PIECE_M });
    for (let k = 0; k < w.count; k++)
      tyres.push(pieceAt(path, start + (k + 0.5) * PIECE_M, side, lateral - 0.2 + TYRE_DEPTH_M));
  }
  for (const name of TECPRO_CORNERS) {
    const c = raw.corners.find((x) => x.name.startsWith(name));
    if (!c) continue;
    const apex = c.t * len;
    const side = outsideAt(apex);
    const from = apex - 34;
    const to = apex + 30;
    spans.push({ side, from, to });
    for (let s = from + PIECE_M / 2; s < to; s += PIECE_M)
      tecpro.push(pieceAt(path, s, side, lateral - 0.2 + TECPRO_DEPTH_M));
  }
  const armco: Piece[] = [];
  const fence: Piece[] = [];
  const ads = b.armco.adModels.length;
  for (let side = 1; side >= -1; side -= 2) {
    for (let j = 0; j < n; j++) {
      const s = (j + 0.5) * PIECE_M;
      if (spans.some((w) => w.side === side && s >= w.from && s <= w.to)) continue;
      const a = pieceAt(path, s, side, lateral);
      if (b.armco.adEvery > 0 && j % b.armco.adEvery === 0 && ads > 0) a.ad = Math.floor(j / b.armco.adEvery) % ads;
      armco.push(a);
      if (fenceSites.some((o) => Math.hypot(o.x - a.x, o.z - a.z) < o.r))
        fence.push(pieceAt(path, s, side, lateral + 2.1));
    }
  }
  return { armco, fence, tyres, tecpro };
}

// ------------------------------------------------------------------------------------------------ road paint

export interface PaintStrip {
  /** Lateral edges (m, + = left) of the strip at each sample. */
  from: number;
  to: number;
}

/** The rubbered racing line (2.2 m wide): lateral offset (+ = left) from the centre, up to 4.2 m towards the outside of a curve. */
export function racingLineOffset(path: TrackPath, s: number): number {
  const k = curvatureAt(path, s + 20);
  // Same shape as the design reference: heading change over 12 m, scaled and clamped.
  const turn = Math.max(-1, Math.min(1, (k * 12 * 180) / Math.PI / 8));
  return -turn * 4.2;
}

export const PAINT = {
  /** White edge lines: 0.28 m wide, 0.12 m inside each road edge. */
  edgeLine: { widthM: 0.28, insetM: 0.12 },
  /** Chequered band across the road at the start line, 1.6 m long. */
  chequerM: 1.6,
  /** 20 grid boxes, 8 m apart, staggered +-2.4 m, behind the line. */
  gridBoxes: { count: 20, spacingM: 8, lateralM: 2.4, widthM: 2.6, lengthM: 1.0 },
};

/** Where the grid boxes sit: (distance behind the line, lateral offset, + = left). */
export function gridBoxSites(): { behindM: number; lateralM: number }[] {
  const g = PAINT.gridBoxes;
  return Array.from({ length: g.count }, (_, i) => ({
    behindM: g.spacingM + i * g.spacingM,
    lateralM: i % 2 ? g.lateralM : -g.lateralM,
  }));
}
