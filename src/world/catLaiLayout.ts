import { roadWidthAt, type TrackDef } from '../core/Data';
import { seededRng } from './CongHoaDressing';
import { RoadIndex, frameAt, yawForZ } from './monteCarloLayout';
import { projectRoad } from './ardennesLayout';
import type { TrackPath } from './TrackPath';

/**
 * Pure layout planning for Map 1 (Cat Lai Port v2, daylight): which designed props stay, which land on the carriageway
 * and are dropped, the container stacks, the colliders, the OpenStreetMap surroundings and the ferry. No DOM, no
 * three.js scene, no assets: deterministic and unit tested. Positions are world metres (x east, z = -north, y up);
 * `rotY` rotates about +Y like three's `rotation.y` (local +Z -> (sin, cos), local +X -> (cos, -sin) in (x, z)).
 * The OSM file stores (x, n) with n = north, so everything read from it is flipped to z = -n here.
 */

/** Land and quay level; the river surface is 0. */
export const GROUND_Y = 2;
/** Height of one container tier and the pitches of a stack (design spec). */
export const TIER_M = 2.6;
export const ROW_PITCH_M = 2.6;
export const BAY_GAP_M = 0.4;

// ------------------------------------------------------------------------------------------------ data

export interface PlacementRow {
  model: string;
  x: number;
  z: number;
  rotY: number;
  y?: number;
  scale?: number;
}

export interface YardBlock {
  x: number;
  z: number;
  rotY: number;
  bays: number;
  rows: number;
  /** 12.19 (40 ft) or 6.06 (20 ft). */
  len: number;
  /** Tier counts, row-major (`rows * bays` digits; 0 = empty slot). */
  h: string;
  rtg?: boolean;
  reefer?: boolean;
}

export interface CatLaiPlacementData {
  models: Record<string, string>;
  containerColours: string[];
  containerModels: Record<string, string>;
  groups: Record<string, PlacementRow[]>;
  yardBlocks: YardBlock[];
}

export interface OsmRoad {
  p: [number, number][];
  w: number;
  type: string;
}

export interface OsmBuilding {
  p: [number, number][];
  h: number | null;
  type: string;
}

export interface OsmData {
  roads: OsmRoad[];
  buildings: OsmBuilding[];
}

export interface CatLaiRiver {
  shoreline: [number, number, number][];
  farBank: [number, number, number][];
  ferry: { landingHCMC: [number, number, number]; landingNhonTrach: [number, number, number]; crossingSec: number };
  surfaceY: number;
}

export interface CatLaiQuay {
  edgeStart: [number, number, number];
  dirDeg: number;
  lengthM: number;
}

/** A placed designed prop: `key` is the placement file's model key (`sts`, `house_3`, `moto_0`...), `model` its GLB. */
export interface PlacedItem {
  group: string;
  key: string;
  model: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
}

/** A point of the lap measured beside the carriageway. */
export type Clearance = (x: number, z: number) => number;

export const flip = (p: readonly [number, number]): [number, number] => [p[0], -p[1]];

// ------------------------------------------------------------------------------------------------ geometry helpers

/** Local (lx, lz) of a prop placed at (x, z) with yaw `rotY` -> world (x, z). */
export function toWorld(x: number, z: number, rotY: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  return [x + lx * c + lz * s, z - lx * s + lz * c];
}

/** Even-odd point-in-polygon test; the polygon is a list of (x, z) vertices. */
export function inPolygon(x: number, z: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** The quay's frame: `along` runs NE with the berths, `inland` points away from the river. All world (x, z). */
export function quayFrame(q: CatLaiQuay): {
  at: (s: number, d: number) => [number, number];
  along: [number, number];
  inland: [number, number];
} {
  const a = (q.dirDeg * Math.PI) / 180;
  // The JSON's (x, n) frame: U = (cos, sin), V = (-sin, cos); in world z = -n.
  const along: [number, number] = [Math.cos(a), -Math.sin(a)];
  const inland: [number, number] = [-Math.sin(a), -Math.cos(a)];
  const e: [number, number] = [q.edgeStart[0], q.edgeStart[2]];
  return {
    along,
    inland,
    at: (s, d) => [e[0] + along[0] * s + inland[0] * d, e[1] + along[1] * s + inland[1] * d],
  };
}

/**
 * The port's concrete slab (the design's PORT polygon), world (x, z): the quay, the yard to the north road, the CFS
 * warehouse strip and the ferry-side corner of Nguyen Thi Dinh.
 */
export function portPolygon(q: CatLaiQuay): [number, number][] {
  const f = quayFrame(q);
  const n = (x: number, north: number): [number, number] => [x, -north];
  return [
    f.at(-70, 0),
    f.at(1220, 0),
    n(1440, 330),
    n(1480, 470),
    n(1510, 640),
    f.at(1240, 700),
    f.at(1000, 700),
    f.at(980, 860),
    f.at(820, 860),
    f.at(800, 700),
    f.at(-20, 700),
    n(-30, 190),
    n(150, -150),
    n(260, -230),
  ];
}

// ------------------------------------------------------------------------------------------------ road clearance

/** Metres from (x, z) to the nearest carriageway edge of the lap (negative = on the road); Infinity beyond `maxM`. */
export function roadClearance(index: RoadIndex, def: TrackDef, maxM = 80): Clearance {
  return (x, z) => {
    const hit = projectRoad(index, x, z, maxM);
    return hit ? hit.d - roadWidthAt(def, hit.t) / 2 : Infinity;
  };
}

/** The lap's own road sampled every few metres plus the OSM roads: nearest-road queries for frontage and trees. */
export class RoadGrid {
  private readonly cells = new Map<number, [number, number, number][]>();
  constructor(private readonly cell = 25) {}

  private key(i: number, j: number): number {
    return i * 100003 + j;
  }

  add(x: number, z: number, w: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    const list = this.cells.get(k);
    if (list) list.push([x, z, w]);
    else this.cells.set(k, [[x, z, w]]);
  }

  addPolyline(pts: readonly (readonly [number, number])[], w: number, stepM = 6): void {
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1];
      const [x1, z1] = pts[i];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.ceil(len / stepM));
      for (let k = 0; k <= n; k++) this.add(x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n, w);
    }
  }

  /** Distance to the nearest road edge within ~2 cells, Infinity if none. */
  clear(x: number, z: number): number {
    let d = Infinity;
    const ci = Math.floor(x / this.cell);
    const cj = Math.floor(z / this.cell);
    for (let a = -2; a <= 2; a++) {
      for (let b = -2; b <= 2; b++) {
        const c = this.cells.get(this.key(ci + a, cj + b));
        if (!c) continue;
        for (const [px, pz, w] of c) d = Math.min(d, Math.hypot(px - x, pz - z) - w / 2);
      }
    }
    return d;
  }
}

// ------------------------------------------------------------------------------------------------ placements

export function planPlacements(data: CatLaiPlacementData): PlacedItem[] {
  const out: PlacedItem[] = [];
  for (const [group, rows] of Object.entries(data.groups)) {
    for (const r of rows) {
      const model = data.models[r.model];
      if (!model) continue;
      out.push({
        group,
        key: r.model,
        model,
        x: r.x,
        y: r.y ?? GROUND_Y,
        z: r.z,
        rotY: r.rotY,
        scale: r.scale ?? 1,
      });
    }
  }
  return out;
}

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

const r = (x0: number, x1: number, z0: number, z1: number): Rect => ({ x0, x1, z0, z1 });
const centred = (hw: number, hd: number): Rect => r(-hw, hw, -hd, hd);

/** STS crane legs (the portal straddles the quay lane: the car drives between them). */
export const STS_LEGS: Rect[] = [r(-17, -13.5, -13.5, 13.5), r(13.5, 17, -13.5, 13.5)];
/** RTG gantry legs. */
export const RTG_LEGS: Rect[] = [r(-14.9, -10.9, -8.1, 8.1), r(10.9, 13.6, -8.1, 8.1)];
/** Gate B booth islands (centre x, half width, in the gate's local frame; each runs z -9..9). */
export const GATE_ISLANDS: [number, number][] = [
  [-12.75, 0.75],
  [-8.5, 1],
  [-4.25, 0.75],
  [-0.25, 1.25],
  [4.25, 0.75],
  [8, 1],
  [12.75, 0.75],
];
/** The gate is shifted sideways so a lane (not a booth island) lies on the centre line the rivals hold. */
export const GATE_SHIFT_M = -2.25;
/**
 * The three booth islands around the centre line (indices into `GATE_ISLANDS`) are drive-through. Six cars converge
 * on the one lane the centre line runs through, and the left-turning racing line runs 1.5 m wide of it at 60 m/s: with
 * solid booths there the pack wedged itself against them every lap. The outer booths stay solid.
 */
export const GATE_OPEN_ISLANDS = [2, 3, 4];
/** The solid part of an island is narrower than its visual so the lanes between stay wide enough for a car. */
export const GATE_ISLAND_SOLID = 0.5;
/** Half the length (m) of an island's solid core: the booth itself, not the kerb tips the island runs out to. */
export const GATE_ISLAND_CORE_HALF_M = 4.5;
export const GATE_HEIGHT_M = 3.1;

/** Footprints (local rectangles) of the placed models, by placement key. The solid or ground-touching parts only. */
const FOOTPRINTS: [RegExp, Rect[]][] = [
  [/^sts/, STS_LEGS],
  [/^rtg$/, RTG_LEGS],
  [/^house_/, [r(-2.8, 2.8, -21, 2.6)]],
  [/^cfs$/, [centred(30, 76)]],
  [/^office$/, [r(-20.2, 20.2, -10, 14.5)]],
  [/^tank$/, [centred(14.5, 14.5)]],
  [/^mast$/, [centred(2.5, 2.6)]],
  [/^reefer$/, [centred(1.6, 38)]],
  [/^rs$/, [r(-6.1, 6.1, -5.5, 10.3)]],
  [/^tt_/, [r(-1.3, 1.3, -10.3, 6)]],
  [/^pole/, [centred(0.6, 0.5)]],
  [/^tree_/, [centred(1.2, 1.2)]],
  [/^truck_/, [r(-1.6, 1.6, -10.8, 7.7)]],
  [/^moto_/, [centred(0.4, 0.9)]],
  [/^bus$/, [centred(1.3, 5.6)]],
  [/^jersey_/, [centred(0.3, 2)]],
  [/^quay$/, [r(-31, 4.5, -10, 10)]],
  [/^workers$/, [r(-1.3, 2.5, -1.5, 1.5)]],
  [/^street$/, [r(-2, 2, -1.6, 1.4)]],
  [/^landing$/, [r(-9.6, 24, 0, 44)]],
];

export function footprintOf(key: string): Rect[] {
  return FOOTPRINTS.find(([re]) => re.test(key))?.[1] ?? [centred(2, 2)];
}

/** Corners and mid-edges of a local rectangle in world space. */
export function rectPoints(it: Pick<PlacedItem, 'x' | 'z' | 'rotY'>, rect: Rect): [number, number][] {
  const out: [number, number][] = [];
  for (const u of [0, 0.5, 1]) {
    for (const v of [0, 0.5, 1]) {
      out.push(toWorld(it.x, it.z, it.rotY, rect.x0 + (rect.x1 - rect.x0) * u, rect.z0 + (rect.z1 - rect.z0) * v));
    }
  }
  return out;
}

/** Groups that are on the road by design (the parked queue, the scooters, the gate, jersey barriers on the road edge). */
const ON_ROAD_GROUPS = new Set(['traffic']);
/** What stays beyond the carriageway edge for every footprint point (kerbs and the wall are inside it). */
export const PROP_CLEAR_M = 0.5;
/**
 * The cranes straddle the quay lane, but the lane bends at both ends of the quay, so a leg can stand right at the
 * carriageway edge there. A leg may reach this far (m) past the edge: the invisible wall (1.6 m thick) is what the car
 * meets, and the leg sits on the kerb line like a rail. A crane with a leg further in is dropped.
 */
export const CRANE_LEG_CLEAR_M = -1.8;
/** The quay-edge kit is the dock face (it lies under the apron), and people stand on the kerb: neither is an obstacle. */
const NOT_OBSTACLES = /^(quay|street|workers)$/;
/** The river and the far bank are nowhere near the road: never filtered. */
const WATER_GROUPS = new Set(['river', 'landing']);

export interface DropOptions {
  /** Along-lap stretches (t) where the on-road queue and traffic must not stand (the start grid). */
  keepClearT?: readonly (readonly [number, number])[];
  /** t of a point, for `keepClearT`. */
  tOf?: (x: number, z: number) => number;
}

/**
 * Drops the placed props whose footprint reaches the carriageway. The design placements were authored against the
 * spline, but the road width varies along the lap, so a few props land on it. The quay cranes keep their legs off the
 * road only (the portal itself straddles it); the parked queue and the scooters belong on the road; the start grid
 * stays free of them.
 */
export function dropOnRoad(items: readonly PlacedItem[], clearance: Clearance, opts: DropOptions = {}): PlacedItem[] {
  return items.filter((it) => {
    if (WATER_GROUPS.has(it.group)) return true;
    if (ON_ROAD_GROUPS.has(it.group)) {
      if (!opts.keepClearT || !opts.tOf) return true;
      const t = opts.tOf(it.x, it.z);
      return !opts.keepClearT.some(([a, b]) => t >= a && t <= b);
    }
    if (it.key === 'gate' || NOT_OBSTACLES.test(it.key)) return true; // the gate spans the road by design
    const rects = footprintOf(it.key);
    return rects.every((rect) =>
      rectPoints(it, rect).every(
        ([x, z]) => clearance(x, z) >= (/^sts/.test(it.key) ? CRANE_LEG_CLEAR_M : PROP_CLEAR_M),
      ),
    );
  });
}

/** Shifts Gate B sideways (see `GATE_SHIFT_M`) and returns the items. */
export function shiftGate(items: readonly PlacedItem[]): PlacedItem[] {
  return items.map((it) => {
    if (it.key !== 'gate') return it;
    const [x, z] = toWorld(it.x, it.z, it.rotY, GATE_SHIFT_M, 0);
    return { ...it, x, z };
  });
}

// ------------------------------------------------------------------------------------------------ container yard

export interface Stack {
  x: number;
  z: number;
  rotY: number;
  /** 12.19 or 6.06. */
  len: number;
  /** Tiers high (1-5). */
  h: number;
  block: number;
}

export interface YardPlan {
  stacks: Stack[];
  /** Containers (all tiers) in the stacks that stay, and in the ones that touched the road. */
  kept: number;
  dropped: number;
}

/**
 * Every container stack of the yard blocks: rows across (2.6 m pitch), bays along (length + 0.4 m pitch), tier counts
 * from the block's `h` digits. A stack whose footprint reaches the carriageway is dropped.
 */
export function planYard(blocks: readonly YardBlock[], clearance: Clearance): YardPlan {
  const stacks: Stack[] = [];
  let kept = 0;
  let dropped = 0;
  blocks.forEach((b, bi) => {
    const pitch = b.len + BAY_GAP_M;
    for (let row = 0; row < b.rows; row++) {
      for (let bay = 0; bay < b.bays; bay++) {
        const h = Number(b.h[row * b.bays + bay] ?? 0);
        if (!(h > 0)) continue;
        const lx = (row - (b.rows - 1) / 2) * ROW_PITCH_M;
        const lz = (bay - (b.bays - 1) / 2) * pitch;
        const [x, z] = toWorld(b.x, b.z, b.rotY, lx, lz);
        const rect = centred(1.3, b.len / 2);
        const ok = rectPoints({ x, z, rotY: b.rotY }, rect).every(([px, pz]) => clearance(px, pz) >= PROP_CLEAR_M);
        if (ok) {
          stacks.push({ x, z, rotY: b.rotY, len: b.len, h, block: bi });
          kept += h;
        } else dropped += h;
      }
    }
  });
  return { stacks, kept, dropped };
}

/** A container's colour: index into `containerColours` and a brightness multiplier (0.85-1.1). Deterministic. */
export function containerTint(seed: number, nColours: number): { index: number; mul: number } {
  const rng = seededRng(seed);
  return { index: Math.floor(rng() * nColours), mul: 0.85 + rng() * 0.25 };
}

// ------------------------------------------------------------------------------------------------ colliders

export interface BoxCollider {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  rotY: number;
}

/** Solid props are only worth a collider when a car could reach them: within this of the carriageway edge. */
export const COLLIDER_REACH_M = 14;

const SOLID: [RegExp, number][] = [
  [/^sts/, 74],
  [/^rtg$/, 26],
  [/^house_/, 15],
  [/^cfs$/, 14.8],
  [/^office$/, 28],
  [/^tank$/, 15],
  [/^mast$/, 35],
  [/^reefer$/, 9.4],
  [/^rs$/, 10],
  [/^tt_/, 4],
  [/^pole/, 12],
  [/^truck_/, 4.9],
  [/^bus$/, 3.3],
];

/** The cuboids of one item: legs for the cranes, the booth islands of Gate B, a box for everything else. */
export function itemBoxes(it: PlacedItem): BoxCollider[] {
  if (it.key === 'gate') {
    return GATE_ISLANDS.filter((_, i) => !GATE_OPEN_ISLANDS.includes(i)).map(([cx, hw]) => {
      const [x, z] = toWorld(it.x, it.z, it.rotY, cx, 0);
      return {
        x,
        y: it.y + GATE_HEIGHT_M / 2,
        z,
        hx: hw * GATE_ISLAND_SOLID,
        hy: GATE_HEIGHT_M / 2,
        hz: GATE_ISLAND_CORE_HALF_M,
        rotY: it.rotY,
      };
    });
  }
  const height = SOLID.find(([re]) => re.test(it.key))?.[1];
  if (!height) return [];
  const h = /^sts|^rtg$/.test(it.key) ? 5 : /^mast$/.test(it.key) ? 4 : /^pole/.test(it.key) ? 3 : height;
  return footprintOf(it.key).map((rect) => {
    const [x, z] = toWorld(it.x, it.z, it.rotY, (rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2);
    return {
      x,
      y: it.y + h / 2,
      z,
      hx: (rect.x1 - rect.x0) / 2,
      hy: h / 2,
      hz: (rect.z1 - rect.z0) / 2,
      rotY: it.rotY,
    };
  });
}

/**
 * Static colliders of the map: the solid props near the road, plus ONE cuboid per container block that comes near the
 * road (a block is up to ~60 stacks). The walls along the carriageway are `Track`'s; the quay edge needs nothing more
 * because a car cannot leave the road.
 */
export function planColliders(
  items: readonly PlacedItem[],
  stacks: readonly Stack[],
  blocks: readonly YardBlock[],
  clearance: Clearance,
): BoxCollider[] {
  const out: BoxCollider[] = [];
  for (const it of items) {
    if (it.group === 'river' || it.group === 'landing' || it.group === 'traffic' || it.group === 'barriers') continue;
    const boxes = itemBoxes(it);
    if (boxes.length === 0) continue;
    // Within reach: the nearest point of the footprint (its centre for a gate) to the carriageway.
    const near =
      it.key === 'gate' || rectPoints(it, centred(0, 0)).some(([x, z]) => clearance(x, z) < COLLIDER_REACH_M + 40);
    if (!near) continue;
    for (const b of boxes) if (clearance(b.x, b.z) < COLLIDER_REACH_M + Math.max(b.hx, b.hz)) out.push(b);
  }
  // Container blocks: the bounding box of a block's kept stacks, in the block's own frame.
  const byBlock = new Map<number, Stack[]>();
  for (const s of stacks) {
    const list = byBlock.get(s.block);
    if (list) list.push(s);
    else byBlock.set(s.block, [s]);
  }
  for (const [bi, list] of byBlock) {
    const b = blocks[bi];
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    let hMax = 0;
    for (const s of list) {
      // Back into the block's frame: rotate the world offset by -rotY.
      const dx = s.x - b.x;
      const dz = s.z - b.z;
      const c = Math.cos(b.rotY);
      const sn = Math.sin(b.rotY);
      const lx = dx * c - dz * sn;
      const lz = dx * sn + dz * c;
      x0 = Math.min(x0, lx - 1.3);
      x1 = Math.max(x1, lx + 1.3);
      z0 = Math.min(z0, lz - s.len / 2);
      z1 = Math.max(z1, lz + s.len / 2);
      hMax = Math.max(hMax, s.h);
    }
    const [x, z] = toWorld(b.x, b.z, b.rotY, (x0 + x1) / 2, (z0 + z1) / 2);
    const hx = (x1 - x0) / 2;
    const hz = (z1 - z0) / 2;
    if (clearance(x, z) > COLLIDER_REACH_M + Math.hypot(hx, hz)) continue;
    out.push({ x, y: GROUND_Y + (hMax * TIER_M) / 2, z, hx, hy: (hMax * TIER_M) / 2, hz, rotY: b.rotY });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ OpenStreetMap surroundings

export const OSM_FRONTAGE_TYPES = new Set(['residential', 'tertiary', 'unclassified', 'primary', 'secondary']);

export interface WorldRoad {
  pts: [number, number][];
  w: number;
  type: string;
}

/** OSM roads within `radiusM` of any of `centres`, in world (x, z). */
export function osmRoadsNear(osm: OsmData, centres: readonly [number, number][], radiusM: number): WorldRoad[] {
  const r2 = radiusM * radiusM;
  const out: WorldRoad[] = [];
  for (const road of osm.roads) {
    const pts = road.p.map(flip);
    if (pts.some(([x, z]) => centres.some(([cx, cz]) => (x - cx) ** 2 + (z - cz) ** 2 < r2))) {
      out.push({ pts, w: road.w, type: road.type });
    }
  }
  return out;
}

/** Sample points of the whole lap, every `stepM` along: the centres the surroundings are kept around. */
export function lapCentres(path: TrackPath, stepM: number): [number, number][] {
  const out: [number, number][] = [];
  const n = Math.max(1, Math.round(path.lengthM / stepM));
  for (let i = 0; i < n; i++) {
    const f = frameAt(path, i / n);
    out.push([f.x, f.z]);
  }
  return out;
}

export interface RoadStrips {
  /** x, y, z per vertex. */
  positions: number[];
  indices: number[];
  /** Metres along the road and across (u in 0..1), per vertex, for the asphalt texture. */
  uvs: number[];
}

/**
 * OSM roads as flat asphalt strips outside the port. Pieces that lie on the lap's own carriageway (the lap IS the
 * Nguyen Thi Dinh road) or inside the port slab are skipped, so nothing z-fights with the road or the concrete.
 */
export function osmRoadStrips(
  roads: readonly WorldRoad[],
  clearance: Clearance,
  inPort: (x: number, z: number) => boolean,
  y: number,
): RoadStrips {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const PIECE_M = 6;
  for (const road of roads) {
    let along = 0;
    for (let i = 1; i < road.pts.length; i++) {
      const [x0, z0] = road.pts[i - 1];
      const [x1, z1] = road.pts[i];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.01) continue;
      const nx = (z1 - z0) / len;
      const nz = -(x1 - x0) / len;
      const pieces = Math.max(1, Math.ceil(len / PIECE_M));
      for (let k = 0; k < pieces; k++) {
        const a = k / pieces;
        const b = (k + 1) / pieces;
        const ax = x0 + (x1 - x0) * a;
        const az = z0 + (z1 - z0) * a;
        const bx = x0 + (x1 - x0) * b;
        const bz = z0 + (z1 - z0) * b;
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        const hw = road.w / 2;
        // Anything of this piece (its corners at the half width) on the lap's road or in the port slab is skipped.
        const onLap = [
          [ax, az],
          [mx, mz],
          [bx, bz],
        ].some(([px, pz]) => clearance(px, pz) < road.w / 2 + 0.5);
        if (!onLap && !inPort(mx, mz)) {
          const base = positions.length / 3;
          positions.push(
            ax - nx * hw, y, az - nz * hw,
            ax + nx * hw, y, az + nz * hw,
            bx - nx * hw, y, bz - nz * hw,
            bx + nx * hw, y, bz + nz * hw,
          ); // prettier-ignore
          const va = (along + len * a) / 32;
          const vb = (along + len * b) / 32;
          uvs.push(0, va, 1, va, 0, vb, 1, vb);
          indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }
      }
      along += len;
    }
  }
  return { positions, indices, uvs };
}

export interface Frontage {
  x: number;
  z: number;
  rotY: number;
  variant: number;
}

export interface FrontageRules {
  inPort: (x: number, z: number) => boolean;
  onLand: (x: number, z: number) => boolean;
  /** Skip a site (outside the area worth building, say). */
  keep: (x: number, z: number) => boolean;
  variants: number;
  seed: number;
}

/**
 * Tube houses (nha ong) every 4.6-5.4 m along residential / tertiary / primary roads outside the port, their facade
 * toward the road; skipped where the house or its back would hit another road, or off the land.
 */
export function planFrontage(roads: readonly WorldRoad[], grid: RoadGrid, rules: FrontageRules): Frontage[] {
  const rng = seededRng(rules.seed);
  const out: Frontage[] = [];
  for (const road of roads) {
    if (!OSM_FRONTAGE_TYPES.has(road.type)) continue;
    for (let i = 1; i < road.pts.length; i++) {
      const [x0, z0] = road.pts[i - 1];
      const [x1, z1] = road.pts[i];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 8) continue;
      const ux = (x1 - x0) / len;
      const uz = (z1 - z0) / len;
      for (let t = 3; t < len - 3; t += 4.6 + rng() * 0.8) {
        for (const side of [1, -1]) {
          const off = road.w / 2 + 4.5;
          // The right-hand normal of the (x, z) segment: (uz, -ux).
          const x = x0 + ux * t + uz * off * side;
          const z = z0 + uz * t - ux * off * side;
          if (rng() < 0.12 || !rules.keep(x, z) || rules.inPort(x, z) || !rules.onLand(x, z)) continue;
          if (grid.clear(x, z) < 2.5) continue;
          // The house runs 21 m back from its facade: its back and middle must not reach another road.
          const bx = x + uz * side * 16;
          const bz = z - ux * side * 16;
          const mx = x + uz * side * 8;
          const mz = z - ux * side * 8;
          if (grid.clear(bx, bz) < 3 || grid.clear(mx, mz) < 3) continue;
          // Local +Z (the facade) points back at the road: against the side normal.
          out.push({
            x,
            z,
            rotY: Math.atan2(-side * uz, side * ux),
            variant: Math.floor(rng() * rules.variants),
          });
        }
      }
    }
  }
  return out;
}

export interface TreeSite {
  x: number;
  z: number;
  scale: number;
  variant: number;
  /** HSL tint. */
  hue: number;
  sat: number;
  light: number;
}

/** Trees on open land at least `roadClearM` from every road, on a jittered grid; the rest of the land stays bare. */
export function planTrees(
  bounds: { x0: number; x1: number; z0: number; z1: number },
  cellM: number,
  grid: RoadGrid,
  allowed: (x: number, z: number) => boolean,
  seed: number,
  roadClearM = 10,
): TreeSite[] {
  const rng = seededRng(seed);
  const out: TreeSite[] = [];
  for (let gx = bounds.x0; gx < bounds.x1; gx += cellM) {
    for (let gz = bounds.z0; gz < bounds.z1; gz += cellM) {
      const x = gx + rng() * cellM;
      const z = gz + rng() * cellM;
      if (rng() < 0.45 || !allowed(x, z) || grid.clear(x, z) < roadClearM) continue;
      out.push({
        x,
        z,
        scale: 0.7 + rng() * 0.7,
        variant: rng() < 0.5 ? 0 : 1,
        hue: 0.25 + (rng() - 0.5) * 0.06,
        sat: 0.35 + rng() * 0.25,
        light: 0.4 + rng() * 0.2,
      });
    }
  }
  return out;
}

export interface MappedBuilding {
  x: number;
  z: number;
  rotY: number;
  w: number;
  d: number;
  h: number;
  type: string;
}

/**
 * The OSM "building footprints" of this file are single centre points with a type: each becomes a box sized by its
 * type, turned to run along the nearest OSM road, with a height from the tags or 7-16 m. Boxes that would reach a
 * road or the port slab are dropped.
 */
export function planMappedBuildings(
  osm: OsmData,
  grid: RoadGrid,
  roads: readonly WorldRoad[],
  inPort: (x: number, z: number) => boolean,
  keep: (x: number, z: number) => boolean,
  seed: number,
): MappedBuilding[] {
  const rng = seededRng(seed);
  const SIZE: Record<string, [number, number, number]> = {
    house: [7, 13, 8],
    terrace: [6, 18, 9],
    apartments: [20, 32, 24],
    warehouse: [24, 56, 9],
    industrial: [26, 50, 10],
    school: [20, 44, 11],
    yes: [10, 16, 9],
  };
  const out: MappedBuilding[] = [];
  for (const b of osm.buildings) {
    const [x, z] = flip(b.p[0]);
    if (!keep(x, z) || inPort(x, z)) continue;
    const [w, d, h0] = SIZE[b.type] ?? SIZE.yes;
    // Yaw along the nearest road piece.
    let best = Infinity;
    let rot = rng() * Math.PI;
    for (const road of roads) {
      for (let i = 1; i < road.pts.length; i++) {
        const [x0, z0] = road.pts[i - 1];
        const [x1, z1] = road.pts[i];
        const dx = x1 - x0;
        const dz = z1 - z0;
        const l2 = dx * dx + dz * dz || 1;
        const k = Math.min(1, Math.max(0, ((x - x0) * dx + (z - z0) * dz) / l2));
        const dist = Math.hypot(x - (x0 + dx * k), z - (z0 + dz * k));
        if (dist < best) {
          best = dist;
          rot = Math.atan2(dx, dz);
        }
      }
    }
    const reach = Math.hypot(w, d) / 2;
    if (grid.clear(x, z) < reach + 1) continue;
    out.push({ x, z, rotY: rot, w, d, h: b.h ?? h0 * (0.8 + rng() * 0.4), type: b.type });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ ferry

export interface FerryPose {
  x: number;
  z: number;
  /** Heading as three's `rotation.y` (local +Z is the bow). */
  rotY: number;
  /** 0 at the HCMC landing, 1 at Nhon Trach. */
  along: number;
  /** True while it sits at a landing. */
  docked: boolean;
}

/**
 * The Cat Lai ferry between its two landings: it sails across for 45 % of the cycle, loads for 5 %, sails back and
 * loads again. `offset` (0-1) staggers a second boat so one is always on each leg.
 */
export function ferryPose(
  a: readonly [number, number],
  b: readonly [number, number],
  timeSec: number,
  cycleSec: number,
  offset = 0,
): FerryPose {
  const phase = (((timeSec / cycleSec + offset) % 1) + 1) % 1;
  const smooth = (k: number): number => k * k * (3 - 2 * k);
  let along: number;
  let outbound: boolean;
  let docked = false;
  if (phase < 0.45) {
    along = smooth(phase / 0.45);
    outbound = true;
  } else if (phase < 0.5) {
    along = 1;
    outbound = true;
    docked = true;
  } else if (phase < 0.95) {
    along = 1 - smooth((phase - 0.5) / 0.45);
    outbound = false;
  } else {
    along = 0;
    outbound = false;
    docked = true;
  }
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  return {
    x: a[0] + dx * along,
    z: a[1] + dz * along,
    rotY: yawForZ(outbound ? dx : -dx, outbound ? dz : -dz),
    along,
    docked,
  };
}

// ------------------------------------------------------------------------------------------------ sponsors

export interface BillboardSite {
  model: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  side: 1 | -1;
  s: number;
}

const BILLBOARDS = ['capturemann', 'craftmann', 'emesoft', 'voltline'].map(
  (n) => `models/props_xalo/billboard_${n}.glb`,
);

/**
 * Billboards along Nguyen Thi Dinh facing the oncoming traffic, brands rotating so neighbours differ. `rangesS` are
 * stretches of the lap (metres from the start line, wrapping) and `every` the spacing.
 */
export function planBillboards(
  path: TrackPath,
  def: TrackDef,
  rangesS: readonly (readonly [number, number])[],
  every: number,
  offsetM: number,
): BillboardSite[] {
  const out: BillboardSite[] = [];
  let k = 0;
  for (const [s0, s1] of rangesS) {
    for (let s = s0; s < s1; s += every, k++) {
      const t = (((s / path.lengthM) % 1) + 1) % 1;
      const f = frameAt(path, t);
      const side: 1 | -1 = k % 2 === 0 ? 1 : -1;
      const lat = roadWidthAt(def, t) / 2 + offsetM;
      // `lx` points to the car's left. The board's face looks along local -Z, so +Z runs the way the cars drive.
      out.push({
        model: BILLBOARDS[k % BILLBOARDS.length],
        x: f.x + f.lx * lat * side,
        y: GROUND_Y,
        z: f.z + f.lz * lat * side,
        rotY: yawForZ(f.tx, f.tz),
        side,
        s,
      });
    }
  }
  return out;
}

/**
 * Billboards stand on the ground, 9 m beyond the carriageway edge, where the design's tube-house rows already are: the
 * houses within `halfLenM` along the road of a board (and on its side) make way for it.
 */
export function clearBillboardLots(
  items: readonly PlacedItem[],
  boards: readonly BillboardSite[],
  halfLenM = 8,
): PlacedItem[] {
  return items.filter((it) => {
    if (!/^house_/.test(it.key)) return true;
    return !boards.some((b) => Math.hypot(it.x - b.x, it.z - b.z) < halfLenM + 7);
  });
}
