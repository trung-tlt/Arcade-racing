import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/Assets';
import type { TrackDef } from '../core/Data';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import { rectClearanceToPath, rectPoints, rotateLocal, seededRng } from './CongHoaDressing';
import { type CorridorPath, distToPolyline, leftOf, rightOf } from './Corridor';
import type { TrackPath } from './TrackPath';
import { DistanceCull, drawDistance } from './Windowed';

type Rapier = typeof RAPIER;

const XP = 'models/props_xalo/';
const CP = 'models/props_conghoa/';
const APARTMENTS = ['apartment_tower_a', 'apartment_tower_b'].map((n) => `${XP}${n}.glb`);
const FACTORY = `${XP}factory_shed.glb`;
const LAMP = `${XP}highway_lamp.glb`;
const SHOPHOUSES = ['shophouse_a', 'shophouse_b', 'shophouse_c', 'shophouse_d'].map((n) => `${CP}${n}.glb`);
const BARRIER = 'models/props/barrier_jersey.glb';
const TREES = [`${CP}street_tree_a.glb`, `${CP}street_tree_b.glb`];

/** Every GLB this module loads, relative to /assets/. */
export const XALO_DRESSING_MODELS: string[] = [...APARTMENTS, FACTORY, LAMP, ...SHOPHOUSES, BARRIER, ...TREES];

// ---------------------------------------------------------------------------------------------
// Pure layout planning (no DOM, no rendering, no assets): deterministic and unit tested.
// ---------------------------------------------------------------------------------------------

/** Kerb stone width beyond the carriageway edge. */
export const KERB_M = 0.35;
/** Chunk edge for spatial culling. */
export const CHUNK_M = 150;
/** Shophouse footprint depth behind the facade (GLBs are 14 m deep, origin on the facade). */
export const HOUSE_DEPTH_M = 14;
/** Footprints (half width, half depth) of the big buildings, read from the GLB bounds. */
export const TOWER_HALF = { w: 16, d: 14 };
export const FACTORY_HALF = { w: 30, d: 20 };
/** Clear space kept around metro line, stations and billboards. */
export const METRO_CLEARANCE_M = 12;
export const LANDMARK_CLEARANCE_M = 22;
export const HOUSE_ROAD_CLEARANCE_M = 8;
export const BIG_ROAD_CLEARANCE_M = 20;
export const BARRIER_TILE_M = 3;
/** Centre-to-centre distance of the two bridge decks (the lamps stand midway). */
export const BRIDGE_DECK_GAP_M = 20;

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
  /** Metres north (−z) of the start line along the frontage road. */
  n: number;
}

export interface XaLoSpec {
  mainWidthM: number;
  frontageWidthM: number;
  /** First t of the frontage leg (section F) and of the whole outbound leg's end. */
  frontageFromT: number;
  frontageToT: number;
  apartments: { fromN: number; toN: number; setbackM: number; spacingM: number };
  factories: { fromN: number; toN: number; setbackM: number; spacingM: number };
  shophouses: { fromN: number; toN: number; frontageOffsetM: number };
  lampEveryM: number;
  underpass: { fromN: number; toN: number; coveredFromN: number; coveredToN: number };
  bridge: { fromN: number; toN: number };
  viaduct: [number, number][];
  /** Stations and billboards [x, z]. */
  landmarks: [number, number][];
}

/** Reads the spec out of the map JSON (`TrackDef.raw`). */
export function specFromTrack(raw: Record<string, unknown>): XaLoSpec {
  const r = raw as {
    roadLayout: { mainCarriageway: { widthM: number }; frontageRoad: { widthM: number } };
    sections: { id: string; fromT: number; toT: number }[];
    dressing: {
      apartments: { fromN: number; toN: number; setbackM: number; spacingM: number };
      factories: { fromN: number; toN: number; setbackM: number; spacingM: number };
      shophouses: { fromN: number; toN: number; frontageOffsetM: number };
      lamps: { inMedianEveryM: number };
    };
    underpass: { fromN: number; toN: number; coveredFromN: number; coveredToN: number };
    bridge: { fromN: number; toN: number };
    metro: { viaduct: { path: number[][] }; stations: { position: number[] }[] };
    billboards: { position: number[] }[];
  };
  const f = r.sections.find((s) => s.id === 'F');
  if (!f) throw new Error('xa_lo: section F (frontage) missing');
  const d = r.dressing;
  return {
    mainWidthM: r.roadLayout.mainCarriageway.widthM,
    frontageWidthM: r.roadLayout.frontageRoad.widthM,
    frontageFromT: f.fromT,
    frontageToT: f.toT,
    apartments: d.apartments,
    factories: d.factories,
    shophouses: d.shophouses,
    lampEveryM: d.lamps.inMedianEveryM,
    underpass: r.underpass,
    bridge: r.bridge,
    viaduct: r.metro.viaduct.path.map((p) => [p[0], p[2]] as [number, number]),
    landmarks: [...r.metro.stations.map((s) => s.position), ...r.billboards.map((b) => b.position)].map(
      (p) => [p[0], p[2]] as [number, number],
    ),
  };
}

export interface RoadPath extends CorridorPath {
  readonly py: Float32Array;
}

/** A road sample with its distance north of the start line (−z). */
export interface LegSample {
  i: number;
  /** Metres north: −z of the sample. */
  n: number;
}

/**
 * Samples [t0, t1) ordered by increasing northing. Heading-reversals (the U-turn) are cut off: the list ends
 * where northing stops increasing (outbound) or decreasing (frontage, returned reversed).
 */
export function legSamples(path: RoadPath, t0: number, t1: number): LegSample[] {
  const out: LegSample[] = [];
  const a = Math.floor(t0 * path.count);
  const b = Math.floor(t1 * path.count);
  const rising = path.tz[a] < 0 || path.tz[Math.min(a + 1, path.count - 1)] < 0;
  for (let i = a; i < b; i++) {
    const n = -path.pz[i];
    const last = out[out.length - 1];
    if (last && (rising ? n < last.n : n > last.n)) break;
    out.push({ i, n });
  }
  return rising ? out : out.reverse();
}

/** The sample of `leg` closest to northing `n` (leg ordered by increasing n). */
export function sampleAtN(leg: readonly LegSample[], n: number): LegSample {
  let lo = 0;
  let hi = leg.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (leg[mid].n <= n) lo = mid;
    else hi = mid;
  }
  return Math.abs(leg[lo].n - n) <= Math.abs(leg[hi].n - n) ? leg[lo] : leg[hi];
}

/** Like `sampleAtN` but null when `n` lies beyond the ends of the leg (so nothing piles up on the end sample). */
export function sampleWithin(leg: readonly LegSample[], n: number, slackM = 3): LegSample | null {
  if (!leg.length || n < leg[0].n - slackM || n > leg[leg.length - 1].n + slackM) return null;
  return sampleAtN(leg, n);
}

export interface RoadPoint {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
}

/** Road centre point at northing `n`, interpolated between the two bracketing samples (null beyond the leg). */
export function roadPointAtN(path: RoadPath, leg: readonly LegSample[], n: number): RoadPoint | null {
  if (!leg.length || n < leg[0].n || n > leg[leg.length - 1].n) return null;
  let lo = 0;
  let hi = leg.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (leg[mid].n <= n) lo = mid;
    else hi = mid;
  }
  const a = leg[lo].i;
  const b = leg[hi].i;
  const u = leg[hi].n === leg[lo].n ? 0 : (n - leg[lo].n) / (leg[hi].n - leg[lo].n);
  const tx = path.tx[a] + (path.tx[b] - path.tx[a]) * u;
  const tz = path.tz[a] + (path.tz[b] - path.tz[a]) * u;
  const l = Math.hypot(tx, tz) || 1;
  return {
    x: path.px[a] + (path.px[b] - path.px[a]) * u,
    y: path.py[a] + (path.py[b] - path.py[a]) * u,
    z: path.pz[a] + (path.pz[b] - path.pz[a]) * u,
    tx: tx / l,
    tz: tz / l,
  };
}

export interface XaLoPlan {
  apartments: KindSite[];
  factories: Site[];
  houses: HouseSite[];
  barriers: Site[];
  lamps: Site[];
  trees: KindSite[];
}

/** Where a point sits relative to the keep-out areas shared by every row. */
function nearLandmark(spec: XaLoSpec, x: number, z: number, radius: number): boolean {
  return spec.landmarks.some(([lx, lz]) => Math.hypot(lx - x, lz - z) < radius);
}

const inRange = (n: number, a: number, b: number): boolean => n >= a && n <= b;

/** Offset of road sample `i` by `lateral` metres to the right (+) or left (−) of its heading. */
function lateralPoint(path: RoadPath, i: number, lateral: number): { x: number; z: number } {
  const r = rightOf(path.tx[i], path.tz[i]);
  return { x: path.px[i] + r.x * lateral, z: path.pz[i] + r.z * lateral };
}

/** Whole roadside layout for Xa Lo Ha Noi, deterministic for a given path, spec and house widths. */
export function planXaLo(path: RoadPath, spec: XaLoSpec, houseWidths: readonly number[] = [6, 4, 5, 5]): XaLoPlan {
  const outbound = legSamples(path, 0, spec.frontageFromT);
  const frontage = legSamples(path, spec.frontageFromT, spec.frontageToT);
  const mainEdge = spec.mainWidthM / 2 + KERB_M;
  const frontEdge = spec.frontageWidthM / 2 + KERB_M;
  const nearViaduct = (x: number, z: number, r: number): boolean => distToPolyline(spec.viaduct, x, z) < r;

  // Apartment towers (east of the outbound leg, fronts to the road).
  const apartments: KindSite[] = [];
  const rndA = seededRng(0xa9a7);
  for (let n = spec.apartments.fromN; n <= spec.apartments.toN; n += spec.apartments.spacingM) {
    const s = sampleWithin(outbound, n);
    if (!s) continue;
    const p = lateralPoint(path, s.i, mainEdge + spec.apartments.setbackM + TOWER_HALF.d);
    const l = leftOf(path.tx[s.i], path.tz[s.i]);
    const yaw = Math.atan2(l.x, l.z);
    const kind = rndA() < 0.5 ? 0 : 1;
    if (rectClearanceToPath(path, p.x, p.z, TOWER_HALF.w, TOWER_HALF.d, yaw) < BIG_ROAD_CLEARANCE_M) continue;
    if (nearLandmark(spec, p.x, p.z, LANDMARK_CLEARANCE_M + TOWER_HALF.w)) continue;
    if (nearViaduct(p.x, p.z, METRO_CLEARANCE_M + TOWER_HALF.w)) continue;
    apartments.push({ x: p.x, y: 0, z: p.z, yaw, kind });
  }

  // Factory sheds, further out on the same side.
  const factories: Site[] = [];
  for (let n = spec.factories.fromN; n <= spec.factories.toN; n += spec.factories.spacingM) {
    const s = sampleWithin(outbound, n);
    if (!s) continue;
    const p = lateralPoint(path, s.i, mainEdge + spec.factories.setbackM + FACTORY_HALF.d);
    const l = leftOf(path.tx[s.i], path.tz[s.i]);
    const yaw = Math.atan2(l.x, l.z);
    if (rectClearanceToPath(path, p.x, p.z, FACTORY_HALF.w, FACTORY_HALF.d, yaw) < BIG_ROAD_CLEARANCE_M) continue;
    if (nearLandmark(spec, p.x, p.z, LANDMARK_CLEARANCE_M + FACTORY_HALF.w)) continue;
    if (nearViaduct(p.x, p.z, METRO_CLEARANCE_M + FACTORY_HALF.w)) continue;
    factories.push({ x: p.x, y: 0, z: p.z, yaw });
  }

  // Shophouses packed along the frontage road, west of it (right of its southbound heading), facing it.
  const houses: HouseSite[] = [];
  const rndH = seededRng(0x5409);
  let n = spec.shophouses.fromN;
  while (n < spec.shophouses.toN) {
    const kind = Math.floor(rndH() * houseWidths.length);
    const w = houseWidths[kind];
    const nc = n + w / 2;
    n += w + 0.3;
    const s = sampleWithin(frontage, nc);
    if (!s) continue;
    const f = lateralPoint(path, s.i, frontEdge + spec.shophouses.frontageOffsetM);
    const l = leftOf(path.tx[s.i], path.tz[s.i]);
    const yaw = Math.atan2(l.x, l.z);
    const c = rotateLocal(0, -(HOUSE_DEPTH_M / 2 - 0.7), yaw);
    const cx = f.x + c.x;
    const cz = f.z + c.z;
    if (rectClearanceToPath(path, cx, cz, w / 2, HOUSE_DEPTH_M / 2 + 0.7, yaw) < HOUSE_ROAD_CLEARANCE_M) continue;
    if (nearLandmark(spec, cx, cz, LANDMARK_CLEARANCE_M / 2 + w / 2)) continue;
    if (
      rectPoints(cx, cz, w / 2, HOUSE_DEPTH_M / 2 + 0.7, yaw).some((q) => nearViaduct(q.x, q.z, METRO_CLEARANCE_M - 3))
    )
      continue;
    houses.push({ x: f.x, y: 0, z: f.z, yaw, kind, width: w, n: nc });
  }

  // Jersey barriers along the main carriageway's median edge and the frontage road's inner edge.
  // Skipped on the bridge deck (its own parapets) and in the underpass trench.
  const barriers: Site[] = [];
  const outEnd = outbound[outbound.length - 1].n - 60;
  const rowN = (leg: readonly LegSample[], lateral: number, fromN: number, toN: number): void => {
    // Step along the road's own length (not northing) so the tiles butt end to end on the diagonal stretches too.
    for (let m = fromN; m <= toN;) {
      const c = roadPointAtN(path, leg, m);
      if (!c) {
        m += BARRIER_TILE_M;
        continue;
      }
      m += BARRIER_TILE_M * Math.max(0.3, Math.abs(c.tz));
      if (inRange(-c.z, spec.underpass.fromN - 10, spec.underpass.toN + 10)) continue;
      const r = rightOf(c.tx, c.tz);
      barriers.push({ x: c.x + r.x * lateral, y: c.y, z: c.z + r.z * lateral, yaw: Math.atan2(c.tx, c.tz) });
    }
  };
  rowN(outbound, -(mainEdge + 0.6), spec.bridge.toN + 20, outEnd);
  rowN(frontage, -(frontEdge + 0.6), spec.shophouses.fromN, frontage[frontage.length - 1].n - 10);

  // Highway lamps every `lampEveryM`: on the bridge in the gap between the two decks, elsewhere in the barrier row.
  const lamps: Site[] = [];
  for (let m = spec.bridge.fromN; m <= outEnd; m += spec.lampEveryM) {
    if (inRange(m, spec.underpass.fromN, spec.underpass.toN)) continue;
    const s = sampleWithin(outbound, m);
    if (!s) continue;
    const onBridge = m <= spec.bridge.toN + 10;
    const p = lateralPoint(path, s.i, onBridge ? -BRIDGE_DECK_GAP_M / 2 : -(mainEdge + 0.6));
    lamps.push({ x: p.x, y: path.py[s.i], z: p.z, yaw: Math.atan2(path.tx[s.i], path.tz[s.i]) });
  }

  // Street trees: east of the main carriageway and between the frontage road and the shophouses.
  const trees: KindSite[] = [];
  const rndT = seededRng(0x7ee5);
  const addTrees = (leg: readonly LegSample[], lateral: number, step: number, fromN: number, toN: number): void => {
    for (let m = fromN; m <= toN; m += step) {
      const s = sampleWithin(leg, m);
      if (!s || Math.abs(path.py[s.i]) > 0.3) continue;
      const p = lateralPoint(path, s.i, lateral);
      if (nearLandmark(spec, p.x, p.z, 8) || nearViaduct(p.x, p.z, 8)) continue;
      trees.push({ x: p.x, y: 0, z: p.z, yaw: rndT() * Math.PI * 2, kind: rndT() < 0.5 ? 0 : 1 });
    }
  };
  addTrees(outbound, mainEdge + 3, 30, spec.apartments.fromN, spec.factories.toN);
  addTrees(frontage, frontEdge + 2.6, 24, spec.shophouses.fromN, frontage[frontage.length - 1].n - 10);

  return { apartments, factories, houses, barriers, lamps, trees };
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
    new THREE.Vector3(s.x, s.y, s.z),
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
  const b = new THREE.Box3();
  for (const m of meshes) {
    if (m instanceof THREE.InstancedMesh) m.computeBoundingSphere();
    m.geometry.computeBoundingBox();
    if (m.geometry.boundingBox) {
      b.copy(m.geometry.boundingBox);
      if (m instanceof THREE.InstancedMesh) {
        // Instance matrices already hold the placement: bound them through the sphere instead.
        if (m.boundingSphere)
          b.setFromCenterAndSize(m.boundingSphere.center, new THREE.Vector3().setScalar(m.boundingSphere.radius * 2));
      }
      box.union(b);
    }
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

/** Dusk roadside for Xa Lo Ha Noi: apartments, factories, shophouses, median barriers, highway lamps, trees. */
export class XaLoDressing {
  readonly group = new THREE.Group();
  /** The layout that was built (handy for debugging and tests). */
  readonly plan: XaLoPlan;
  private readonly instanced: THREE.InstancedMesh[] = [];
  private readonly baked: THREE.Mesh[] = [];
  private readonly protos: THREE.Object3D[] = [];
  private readonly usedMaterials = new Set<THREE.Material>();
  private readonly drawM: number;

  constructor(
    private readonly scene: THREE.Scene,
    _R: Rapier,
    _world: RAPIER.World,
    private readonly assets: Assets,
    track: TrackDef,
    path: TrackPath,
  ) {
    this.group.name = 'xa_lo_dressing';
    // Dusk haze is warm and bright, so far buildings read as silhouettes: stop drawing them a little before the fog is total.
    this.drawM = drawDistance(track.daylight) * 0.72;
    const spec = specFromTrack(track.raw);
    const houseProtos = SHOPHOUSES.map((m) => this.prep(m));
    const widths = houseProtos.map((p) => {
      const b = new THREE.Box3().setFromObject(p);
      return Math.max(3, Math.round((b.max.x - b.min.x) * 10) / 10);
    });
    this.plan = planXaLo(path, spec, widths);
    this.buildStatic(houseProtos);
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

  /** Big buildings: baked into one merged mesh per material per ~150 m chunk. */
  private buildStatic(houseProtos: THREE.Group[]): void {
    const p = this.plan;
    const towers = APARTMENTS.map((m) => this.prep(m));
    const factory = this.prep(FACTORY);
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
    for (const h of p.houses) batchFor(h.x, h.z).add(houseProtos[h.kind], compose(h));
    for (const t of p.apartments) batchFor(t.x, t.z).add(towers[t.kind], compose(t));
    for (const f of p.factories) batchFor(f.x, f.z).add(factory, compose(f));
    // Barriers, lamps and trees are baked too: per chunk they collapse into the same two shared materials, so a chunk costs
    // a handful of draw calls instead of one per sub-mesh per model.
    const barrier = this.prep(BARRIER);
    const lamp = this.prep(LAMP);
    const trees = TREES.map((m) => this.prep(m));
    for (const b of p.barriers) batchFor(b.x, b.z).add(barrier, compose(b));
    for (const l of p.lamps) batchFor(l.x, l.z).add(lamp, compose(l));
    for (const t of p.trees) batchFor(t.x, t.z).add(trees[t.kind], compose(t));
    for (const [k, b] of batches) {
      const { meshes, materials } = b.build(this.group, `static:${k}`, this.drawM);
      this.baked.push(...meshes);
      materials.forEach((m) => this.usedMaterials.add(m));
    }
  }

  dispose(): void {
    // Geometry of instanced props is owned by Assets / the merge cache (shared between races); baked meshes own theirs.
    for (const m of this.instanced) m.dispose();
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
