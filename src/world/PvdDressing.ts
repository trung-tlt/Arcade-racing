import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/Assets';
import type { TrackDef } from '../core/Data';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import { minDistToPath, rectPoints, rotateLocal, seededRng } from './CongHoaDressing';
import { rightOf } from './Corridor';
import type { TrackPath } from './TrackPath';
import { DistanceCull, drawDistance } from './Windowed';
import { type LegSample, type RoadPath, type RoadPoint, chunkKey, legSamples, roadPointAtN } from './XaLoDressing';

type Rapier = typeof RAPIER;

const P = 'models/props_pvd/';
const CP = 'models/props_conghoa/';
const XP = 'models/props_xalo/';
const MEDIAN = `${P}boulevard_median.glb`;
const SEPARATOR = `${P}lane_separator.glb`;
const SHELTER = `${P}rain_shelter.glb`;
const FLOOD_SIGN = `${P}flood_sign.glb`;
const GANTRY_OUT = `${P}sign_gantry_outbound.glb`;
const GANTRY_IN = `${P}sign_gantry_inbound.glb`;
const SHOPHOUSES = ['shophouse_a', 'shophouse_b', 'shophouse_c', 'shophouse_d'].map((n) => `${CP}${n}.glb`);
const APARTMENTS = ['apartment_tower_a', 'apartment_tower_b'].map((n) => `${XP}${n}.glb`);
const OVERPASS = `${CP}pedestrian_overpass.glb`;
const TREES = [`${CP}street_tree_a.glb`, `${CP}street_tree_b.glb`];

/** Every GLB this module loads, relative to /assets/. */
export const PVD_DRESSING_MODELS: string[] = [
  ...new Set([
    MEDIAN,
    SEPARATOR,
    SHELTER,
    FLOOD_SIGN,
    GANTRY_OUT,
    GANTRY_IN,
    ...SHOPHOUSES,
    ...APARTMENTS,
    OVERPASS,
    ...TREES,
  ]),
];

// ---------------------------------------------------------------------------------------------
// Pure layout planning (no DOM, no rendering, no assets): deterministic and unit tested.
// ---------------------------------------------------------------------------------------------

/** Footprint depth of a shophouse behind its facade (the GLBs are 14 m deep, origin on the facade). */
export const HOUSE_DEPTH_M = 14;
/** Footprint of an apartment tower (half width, half depth), read from the GLB bounds. */
export const TOWER_HALF = { w: 16, d: 14 };
/** Footprint of one median / separator tile: half widths (across, along the road). */
export const MEDIAN_HALF = { w: 4, d: 10 };
export const SEPARATOR_HALF = { w: 0.8, d: 10 };
/** Closest a tile or a building may come to the racing line. */
export const TILE_CLEARANCE_M = 3;
export const HOUSE_CLEARANCE_M = 4;
export const TREE_CLEARANCE_M = 2.5;
/** Nothing is dressed this far either side of the ring-road overpass (its piers stand in the median and separators). */
export const OVERPASS_HALF_N_M = 20;
/** The flooded dip is a trench on the inbound (west) side: keep the west side clear this far beyond it. */
export const DIP_MARGIN_N_M = 12;
/** Street trees stand on the sidewalk, this often along the road. */
export const TREE_EVERY_M = 20;
/** Houses and trees stop this far short of the U-turn flyover at the north end. */
export const FLYOVER_MARGIN_N_M = 35;
/** Widest scale X of the pedestrian overpass so it spans the 60 m boulevard. */
export const OVERPASS_SCALE_X = 1.75;
/** Fraction of the fog's cull distance the dressing is drawn to. */
export const DRAW_FACTOR = 0.78;
/** The flood signs' amber blinkers pulse at this rate. */
export const BLINK_HZ = 1.4;

export interface Site {
  x: number;
  y: number;
  z: number;
  /** Rotation about +Y (0 faces +Z). */
  yaw: number;
}
export interface KindSite extends Site {
  kind: number;
}
export interface HouseSite extends KindSite {
  width: number;
  /** Metres north (−z) of the start line. */
  n: number;
}
export interface ScaledSite extends Site {
  scaleX: number;
}

/** An oriented rectangle on the ground: centre, half extents (local x, local z) and yaw. */
export interface Rect {
  x: number;
  z: number;
  hw: number;
  hd: number;
  yaw: number;
}

export interface PvdSpec {
  /** Offsets from the boulevard centre line (positive = east / right when heading north). */
  medianHalfM: number;
  outboundU: number;
  inboundU: number;
  /** Where the houses' facades stand (centre line to facade). */
  frontageM: number;
  /** Sidewalk centre line. */
  sidewalkU: number;
  /** Half the boulevard: median + car lanes + separator + motorbike lanes + sidewalk. */
  halfM: number;
  medianTileM: number;
  separatorTileM: number;
  separatorU: number[];
  separatorGapsN: number[];
  shophouses: { fromN: number; toN: number; also: [number, number] | null; frontageOffsetM: number };
  apartments: { fromN: number; toN: number; setbackM: number; spacingM: number };
  shelters: [number, number, number][];
  floodSigns: [number, number, number][];
  overpasses: [number, number, number][];
  gantries: { t: number; model: string; side: string }[];
  /** Northing ranges dressed by the structure modules (bridges, river) or left bare. */
  bridges: [number, number][];
  overpassN: number;
  flyoverFromT: number;
  flood: { fromT: number; toT: number };
}

interface RawPvd {
  roadLayout: { crossSectionFromCentre: { part: string; widthM: number }[] };
  dressing: {
    median: { tileM: number };
    separators: { tileM: number; offsetsFromCentreM: number[]; gapsAtN: number[] };
    shophouses: { fromN: number; toN: number; also?: number[]; frontageOffsetM: number };
    apartments: { fromN: number; toN: number; setbackM: number; spacingM: number };
    shelters: { positions: [number, number, number][] };
    floodSigns: { positions: [number, number, number][] };
    pedestrianOverpasses: { position: [number, number, number] }[];
  };
  bridge: { binhLoi: { fromN: number; toN: number }; goDua: { fromN: number; toN: number } };
  crossOverpass: { position: [number, number, number] };
  uTurnFlyover: { fromT: number };
  weather: { flood: { fromT: number; toT: number } };
  gantries: { t: number; model: string; side: string }[];
}

/** Reads the spec out of the map JSON (`TrackDef.raw`). */
export function specFromTrack(raw: Record<string, unknown>): PvdSpec {
  const r = raw as unknown as RawPvd;
  const part = (re: RegExp): number => r.roadLayout.crossSectionFromCentre.find((x) => re.test(x.part))?.widthM ?? 0;
  const median = part(/median/i);
  const cars = part(/car lanes/i);
  const sep = part(/separator/i);
  const moto = part(/motorbike/i);
  const walk = part(/sidewalk/i);
  const d = r.dressing;
  const also = d.shophouses.also;
  return {
    medianHalfM: median / 2,
    outboundU: median / 2 + cars / 2,
    inboundU: -(median / 2 + cars + sep + moto / 2),
    frontageM: d.shophouses.frontageOffsetM,
    sidewalkU: median / 2 + cars + sep + moto + walk / 2,
    halfM: median / 2 + cars + sep + moto + walk,
    medianTileM: d.median.tileM,
    separatorTileM: d.separators.tileM,
    separatorU: d.separators.offsetsFromCentreM,
    separatorGapsN: d.separators.gapsAtN,
    shophouses: {
      fromN: d.shophouses.fromN,
      toN: d.shophouses.toN,
      also: also && also.length >= 2 ? [also[0], also[1]] : null,
      frontageOffsetM: d.shophouses.frontageOffsetM,
    },
    apartments: d.apartments,
    shelters: d.shelters.positions,
    floodSigns: d.floodSigns.positions,
    overpasses: d.pedestrianOverpasses.map((o) => o.position),
    gantries: r.gantries,
    bridges: [
      [r.bridge.binhLoi.fromN, r.bridge.binhLoi.toN],
      [r.bridge.goDua.fromN, r.bridge.goDua.toN],
    ],
    overpassN: -r.crossOverpass.position[2],
    flyoverFromT: r.uTurnFlyover.fromT,
    flood: { fromT: r.weather.flood.fromT, toT: r.weather.flood.toT },
  };
}

/** Is a tile / building of half length `halfN` centred at northing `n` touching any `[a, b]` range? */
export function touchesRange(n: number, halfN: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([a, b]) => n + halfN > a && n - halfN < b);
}

/** Do two oriented rectangles overlap (separating-axis test), with `marginM` of extra room around `a`? */
export function rectsOverlap(a: Rect, b: Rect, marginM = 0): boolean {
  const corners = (r: Rect, m: number): { x: number; z: number }[] =>
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([fx, fz]) => {
      const o = rotateLocal(fx * (r.hw + m), fz * (r.hd + m), r.yaw);
      return { x: r.x + o.x, z: r.z + o.z };
    });
  const ca = corners(a, marginM);
  const cb = corners(b, 0);
  const axes = [a.yaw, b.yaw].flatMap((yaw) => [
    { x: Math.cos(yaw), z: -Math.sin(yaw) },
    { x: Math.sin(yaw), z: Math.cos(yaw) },
  ]);
  for (const ax of axes) {
    const pa = ca.map((c) => c.x * ax.x + c.z * ax.z);
    const pb = cb.map((c) => c.x * ax.x + c.z * ax.z);
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
  }
  return true;
}

/** The boulevard's centre line, derived from the outbound racing line (which runs `outboundU` east of it). */
export interface Boulevard {
  readonly path: RoadPath;
  /** Outbound samples ordered by northing. */
  readonly leg: readonly LegSample[];
  readonly spec: PvdSpec;
  /** Metres north of the last outbound sample (the road turns into the U-turn flyover there). */
  readonly endN: number;
  /** Centre-line point at northing `n`: straight south of the start line, straight on beyond the leg's end. */
  centreAtN(n: number): RoadPoint;
}

export function makeBoulevard(path: RoadPath, spec: PvdSpec): Boulevard {
  const leg = legSamples(path, 0, spec.flyoverFromT);
  const endN = leg[leg.length - 1].n;
  const shift = (p: RoadPoint): RoadPoint => {
    const r = rightOf(p.tx, p.tz);
    return { x: p.x - r.x * spec.outboundU, y: p.y, z: p.z - r.z * spec.outboundU, tx: p.tx, tz: p.tz };
  };
  const at = (k: number): RoadPoint =>
    shift({
      x: path.px[leg[k].i],
      y: path.py[leg[k].i],
      z: path.pz[leg[k].i],
      tx: path.tx[leg[k].i],
      tz: path.tz[leg[k].i],
    });
  const first = at(0);
  const last = at(leg.length - 1);
  return {
    path,
    leg,
    spec,
    endN,
    centreAtN(n: number): RoadPoint {
      // Beyond either end the road is taken to run straight on along its end heading.
      if (n < 0) return { ...first, x: first.x + first.tx * n, z: first.z + first.tz * n };
      if (n > endN) return { ...last, x: last.x + last.tx * (n - endN), z: last.z + last.tz * (n - endN) };
      const c = roadPointAtN(path, leg, n);
      return c ? shift(c) : first;
    },
  };
}

/** Offset of a centre-line point by `u` metres to the right (+) or left (−) of its heading. */
export function sideOf(c: RoadPoint, u: number): { x: number; z: number } {
  const r = rightOf(c.tx, c.tz);
  return { x: c.x + r.x * u, z: c.z + r.z * u };
}

/** Rotation about +Y that points a model's +Z along the heading. */
export const headingYaw = (c: { tx: number; tz: number }): number => Math.atan2(c.tx, c.tz);
/** Rotation about +Y that points a model's +Z from the side `u` (+ east, − west) toward the road. */
export const faceRoadYaw = (c: { tx: number; tz: number }, u: number): number => {
  const left = { x: c.tz, z: -c.tx };
  const s = u >= 0 ? 1 : -1;
  return Math.atan2(left.x * s, left.z * s);
};

/**
 * A shelter is 2.6 m deep and 8.4 m long (local x, z): its long side runs along the road, its open (−x) side toward it.
 * `u` is the side of the centre line the shelter stands on (+ east, − west).
 */
export const shelterYaw = (c: { tx: number; tz: number }, u: number): number => headingYaw(c) + (u >= 0 ? Math.PI : 0);

export interface PvdPlan {
  median: Site[];
  separators: Site[];
  houses: HouseSite[];
  apartments: KindSite[];
  trees: KindSite[];
  shelters: Site[];
  floodSigns: Site[];
  overpasses: ScaledSite[];
  gantries: (Site & { model: string })[];
}

/** Northing ranges, from the spec and the path, that every row leaves to the structure modules or keeps bare. */
export function exclusionRanges(
  path: TrackPath,
  spec: PvdSpec,
): { both: [number, number][]; westOnly: [number, number][]; northN: number } {
  const dipA = -path.pointAt(spec.flood.fromT).z;
  const dipB = -path.pointAt(spec.flood.toT).z;
  const flyN = -path.pointAt(spec.flyoverFromT).z;
  return {
    both: [...spec.bridges, [spec.overpassN - OVERPASS_HALF_N_M, spec.overpassN + OVERPASS_HALF_N_M]],
    westOnly: [[Math.min(dipA, dipB) - DIP_MARGIN_N_M, Math.max(dipA, dipB) + DIP_MARGIN_N_M]],
    northN: flyN - FLYOVER_MARGIN_N_M,
  };
}

/** Whole roadside layout for Pham Van Dong Boulevard, deterministic for a given path, spec, house widths and keep-outs. */
export function planPvd(
  path: TrackPath,
  spec: PvdSpec,
  houseWidths: readonly number[] = [6, 4, 5, 5],
  keepouts: readonly Rect[] = [],
): PvdPlan {
  const blvd = makeBoulevard(path, spec);
  const ex = exclusionRanges(path, spec);
  const ranges = (west: boolean): [number, number][] => (west ? [...ex.both, ...ex.westOnly] : ex.both);
  const clearOf = (x: number, z: number, hw: number, hd: number, yaw: number, minM: number): boolean => {
    for (const p of rectPoints(x, z, hw, hd, yaw)) if (minDistToPath(path, p.x, p.z) < minM) return false;
    return true;
  };
  const freeOfKeepouts = (r: Rect, marginM: number): boolean => !keepouts.some((k) => rectsOverlap(r, k, marginM));

  // Median and separators: one tile per `tileM` of road, on the centre line / at the separator offsets. South of the
  // start line the road runs straight; tiles the final U-turn crosses are dropped by the clearance test.
  const tileRow = (tileM: number, u: number, half: { w: number; d: number }, gaps: readonly number[]): Site[] => {
    const out: Site[] = [];
    const west = u < -spec.medianHalfM;
    const ns: number[] = [];
    for (let n = -tileM / 2; n > -tileM * 6; n -= tileM) ns.push(n);
    for (let n = tileM / 2; n < blvd.endN; n += tileM) ns.push(n);
    for (const n of ns) {
      if (touchesRange(n, tileM / 2, ranges(west)) || n > ex.northN) continue;
      if (gaps.some((g) => Math.abs(n - g) < tileM * 0.6)) continue;
      const c = blvd.centreAtN(n);
      const p = sideOf(c, u);
      const yaw = headingYaw(c);
      if (!clearOf(p.x, p.z, half.w, half.d, yaw, TILE_CLEARANCE_M)) continue;
      out.push({ x: p.x, y: c.y, z: p.z, yaw });
    }
    return out;
  };
  const median = tileRow(spec.medianTileM, 0, MEDIAN_HALF, []);
  const separators = spec.separatorU.flatMap((u) =>
    tileRow(spec.separatorTileM, u, SEPARATOR_HALF, spec.separatorGapsN),
  );

  // Shophouses packed along both frontages, facing the road.
  const houses: HouseSite[] = [];
  const rndH = seededRng(0x7d0f);
  const runs: [number, number][] = [[spec.shophouses.fromN, spec.shophouses.toN]];
  if (spec.shophouses.also) runs.push([spec.shophouses.also[0], Math.min(spec.shophouses.also[1], ex.northN)]);
  for (const u of [spec.frontageM, -spec.frontageM]) {
    for (const [from, to] of runs) {
      let n = from;
      while (n < to) {
        const kind = Math.floor(rndH() * houseWidths.length);
        const w = houseWidths[kind];
        const nc = n + w / 2;
        n += w + 0.3;
        if (nc + w / 2 > to || touchesRange(nc, w / 2, ranges(u < 0))) continue;
        const c = blvd.centreAtN(nc);
        const f = sideOf(c, u);
        const yaw = faceRoadYaw(c, u);
        const o = rotateLocal(0, -(HOUSE_DEPTH_M / 2 - 0.7), yaw);
        const rect: Rect = { x: f.x + o.x, z: f.z + o.z, hw: w / 2, hd: HOUSE_DEPTH_M / 2 + 0.7, yaw };
        if (!clearOf(rect.x, rect.z, rect.hw, rect.hd, yaw, HOUSE_CLEARANCE_M) || !freeOfKeepouts(rect, 0.5)) continue;
        houses.push({ x: f.x, y: 0, z: f.z, yaw, kind, width: w, n: nc });
      }
    }
  }

  // Apartment towers behind the east frontage.
  const apartments: KindSite[] = [];
  const rndA = seededRng(0x2b1d);
  for (let n = spec.apartments.fromN; n <= spec.apartments.toN; n += spec.apartments.spacingM) {
    if (touchesRange(n, TOWER_HALF.w, ranges(false))) continue;
    const c = blvd.centreAtN(n);
    const p = sideOf(c, spec.halfM + spec.apartments.setbackM + TOWER_HALF.d);
    const yaw = faceRoadYaw(c, 1);
    const kind = rndA() < 0.5 ? 0 : 1;
    const rect: Rect = { x: p.x, z: p.z, hw: TOWER_HALF.w, hd: TOWER_HALF.d, yaw };
    if (!clearOf(p.x, p.z, rect.hw, rect.hd, yaw, 20) || !freeOfKeepouts(rect, 2)) continue;
    apartments.push({ x: p.x, y: 0, z: p.z, yaw, kind });
  }

  // Authored one-offs: shelters and flood signs at their JSON positions, the overpasses scaled to span the boulevard.
  const authored = (positions: readonly [number, number, number][], yaw: (c: RoadPoint, u: number) => number): Site[] =>
    positions.map(([x, , z]) => {
      const c = blvd.centreAtN(-z);
      const u = (x - c.x) * -c.tz + (z - c.z) * c.tx >= 0 ? 1 : -1; // which side of the centre line (right = east)
      return { x, y: 0, z, yaw: yaw(c, u) };
    });
  const shelters = authored(spec.shelters, shelterYaw).filter((s) => !touchesRange(-s.z, 1, ranges(false)));
  // The flood signs face the inbound (southbound) traffic: their face looks along the boulevard's heading.
  const floodSigns = authored(spec.floodSigns, (c) => headingYaw(c) + Math.PI);
  const overpasses: ScaledSite[] = spec.overpasses.map(([x, , z]) => ({
    x,
    y: 0,
    z,
    yaw: headingYaw(blvd.centreAtN(-z)),
    scaleX: OVERPASS_SCALE_X,
  }));

  // Direction gantries straddle the racing line they announce: legs on the median and the far sidewalk.
  const gantries = spec.gantries.map((g) => {
    const pt = path.pointAt(g.t);
    const tan = path.tangentAt(g.t);
    return { x: pt.x, y: path.yAt(g.t), z: pt.z, yaw: Math.atan2(tan.x, tan.z), model: g.model };
  });

  // Street trees on the sidewalks, both sides, clear of everything above.
  const trees: KindSite[] = [];
  const rndT = seededRng(0x51ee);
  const clutter: Rect[] = [
    ...keepouts,
    ...overpasses.map((o) => ({ x: o.x, z: o.z, hw: 19 * o.scaleX, hd: 9, yaw: o.yaw })),
    ...shelters.map((s) => ({ x: s.x, z: s.z, hw: 1.3, hd: 4.2, yaw: s.yaw })),
    ...floodSigns.map((s) => ({ x: s.x, z: s.z, hw: 0.8, hd: 0.3, yaw: s.yaw })),
    ...houses.map((h) => {
      // The body only (the awnings overhang the sidewalk, where the trees stand).
      const o = rotateLocal(0, -HOUSE_DEPTH_M / 2, h.yaw);
      return { x: h.x + o.x, z: h.z + o.z, hw: h.width / 2, hd: HOUSE_DEPTH_M / 2, yaw: h.yaw };
    }),
  ];
  for (const u of [spec.sidewalkU, -spec.sidewalkU]) {
    for (let n = TREE_EVERY_M / 2; n < Math.min(blvd.endN, ex.northN); n += TREE_EVERY_M) {
      const nj = n + (rndT() - 0.5) * 6;
      const kind = rndT() < 0.5 ? 0 : 1;
      const yawT = rndT() * Math.PI * 2;
      if (touchesRange(nj, 3, ranges(u < 0))) continue;
      const c = blvd.centreAtN(nj);
      if (Math.abs(c.y) > 0.3) continue;
      const p = sideOf(c, u);
      if (minDistToPath(path, p.x, p.z) < TREE_CLEARANCE_M) continue;
      const r: Rect = { x: p.x, z: p.z, hw: 1.5, hd: 1.5, yaw: 0 };
      if (clutter.some((k) => rectsOverlap(r, k))) continue;
      trees.push({ x: p.x, y: 0, z: p.z, yaw: yawT, kind });
    }
  }

  return { median, separators, houses, apartments, trees, shelters, floodSigns, overpasses, gantries };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const up = new THREE.Vector3(0, 1, 0);

function compose(s: Site & { scaleX?: number }): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(s.x, s.y, s.z),
    new THREE.Quaternion().setFromAxisAngle(up, s.yaw),
    new THREE.Vector3(s.scaleX ?? 1, 1, 1),
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
    if (meshes.length > 0) {
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
    return { meshes, materials };
  }
}

/** Oriented keep-out rectangle of a prop placed at `pos` with `yawDeg`, from its model bounds (model space). */
function propRect(box: THREE.Box3, pos: readonly number[], yawDeg: number): Rect {
  const yaw = THREE.MathUtils.degToRad(yawDeg);
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const o = rotateLocal(cx, cz, yaw);
  return { x: pos[0] + o.x, z: pos[2] + o.z, hw: (box.max.x - box.min.x) / 2, hd: (box.max.z - box.min.z) / 2, yaw };
}

/**
 * Roadside of Pham Van Dong Boulevard in the storm: tree median with glowing lamps, lane separators, shophouses,
 * apartment towers, shelters, flood signs, pedestrian overpasses, direction gantries and street trees. Everything is
 * baked into merged static meshes per material per chunk (a handful of draws); nothing here is solid: Track's walls at
 * every carriageway edge already keep cars off the median, the separators and the sidewalks.
 */
export class PvdDressing {
  readonly group = new THREE.Group();
  /** The layout that was built (handy for debugging and tests). */
  readonly plan: PvdPlan;
  private readonly baked: THREE.Mesh[] = [];
  private readonly protos: THREE.Object3D[] = [];
  private readonly usedMaterials = new Set<THREE.Material>();
  private readonly drawM: number;
  private blink: THREE.MeshStandardMaterial | null = null;
  private blinkBase = 1;
  private time = 0;

  constructor(
    private readonly scene: THREE.Scene,
    _R: Rapier,
    _world: RAPIER.World,
    private readonly assets: Assets,
    track: TrackDef,
    path: TrackPath,
  ) {
    this.group.name = 'pvd_dressing';
    // Storm fog hides 80% of a prop 190 m out: stop drawing a little before that to save draw calls.
    this.drawM = drawDistance(track.daylight) * DRAW_FACTOR;
    const spec = specFromTrack(track.raw);
    const houseProtos = SHOPHOUSES.map((m) => this.prep(m));
    const widths = houseProtos.map((p) => {
      const b = new THREE.Box3().setFromObject(p);
      return Math.max(3, Math.round((b.max.x - b.min.x) * 10) / 10);
    });
    this.plan = planPvd(path, spec, widths, this.keepouts(track));
    this.build(houseProtos);
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

  /** Footprints of the sponsor boards and malls the Sponsors module places from the same JSON. */
  private keepouts(track: TrackDef): Rect[] {
    const sp = (track.raw.sponsors ?? {}) as Record<string, { model: string; position: number[]; yawDeg: number }[]>;
    const out: Rect[] = [];
    for (const list of Object.values(sp)) {
      if (!Array.isArray(list)) continue;
      for (const it of list) {
        const box = new THREE.Box3().setFromObject(this.assets.cloneModel(it.model));
        out.push(propRect(box, it.position, it.yawDeg));
      }
    }
    return out;
  }

  private build(houseProtos: THREE.Group[]): void {
    const p = this.plan;
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
    const median = this.prep(MEDIAN);
    const separator = this.prep(SEPARATOR);
    const shelter = this.prep(SHELTER);
    const flood = this.prep(FLOOD_SIGN);
    const overpass = this.prep(OVERPASS);
    const towers = APARTMENTS.map((m) => this.prep(m));
    const trees = TREES.map((m) => this.prep(m));
    const gantries = new Map([GANTRY_OUT, GANTRY_IN].map((m) => [m, this.prep(m)]));
    for (const s of p.median) batchFor(s.x, s.z).add(median, compose(s));
    for (const s of p.separators) batchFor(s.x, s.z).add(separator, compose(s));
    for (const h of p.houses) batchFor(h.x, h.z).add(houseProtos[h.kind], compose(h));
    for (const t of p.apartments) batchFor(t.x, t.z).add(towers[t.kind], compose(t));
    for (const t of p.trees) batchFor(t.x, t.z).add(trees[t.kind], compose(t));
    for (const s of p.shelters) batchFor(s.x, s.z).add(shelter, compose(s));
    for (const s of p.floodSigns) batchFor(s.x, s.z).add(flood, compose(s));
    for (const o of p.overpasses) batchFor(o.x, o.z).add(overpass, compose(o));
    for (const g of p.gantries) {
      const proto = gantries.get(g.model.includes('inbound') ? GANTRY_IN : GANTRY_OUT);
      if (proto) batchFor(g.x, g.z).add(proto, compose(g));
    }
    for (const [k, b] of batches) {
      const { meshes, materials } = b.build(this.group, `static:${k}`, this.drawM);
      this.baked.push(...meshes);
      materials.forEach((m) => this.usedMaterials.add(m));
    }
    // The flood signs' amber blinkers: one shared material, pulsed in update().
    flood.traverse((o) => {
      if (o instanceof THREE.Mesh && !Array.isArray(o.material) && o.material.name === 'Sign_Blink') {
        this.blink = o.material as THREE.MeshStandardMaterial;
        this.blinkBase = this.blink.emissiveIntensity || 1;
      }
    });
  }

  /** Pulses the flood-sign blinkers. */
  update(dt: number): void {
    if (!this.blink) return;
    this.time += dt;
    this.blink.emissiveIntensity =
      this.blinkBase * (0.25 + 0.75 * (Math.sin(this.time * BLINK_HZ * Math.PI * 2) > 0 ? 1 : 0));
  }

  dispose(): void {
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
