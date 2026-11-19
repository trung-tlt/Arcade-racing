import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { roadWidthAt, type TrackDef } from '../core/Data';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import {
  distanceToPathM,
  polylineLengthM,
  polylinePoseAt,
  rectDistanceToPathM,
  spanPlacements,
  trainHeadM,
  trainsPerDirection,
  type PolyPose,
} from './Corridor';
import type { TrackPath } from './TrackPath';
import { drawDistance, gateByDistance, windowInstances } from './Windowed';

type Rapier = typeof RAPIER;

const P = 'models/props_xalo/';
const VIADUCT = `${P}metro_viaduct_span.glb`;
const STATION = `${P}metro_station.glb`;
const SKYWALK = `${P}skywalk.glb`;
const CAB = `${P}metro_car_cab.glb`;
const MID = `${P}metro_car_mid.glb`;
const GANTRY_OUT = `${P}sign_gantry_outbound.glb`;
const GANTRY_IN = `${P}sign_gantry_inbound.glb`;
const BILLBOARDS = ['emesoft', 'voltline', 'apartments', 'ev', 'capturemann', 'craftmann'].map(
  (n) => `${P}billboard_${n}.glb`,
);

/** Every model this module loads (the parent adds them to the Map 3 asset list). */
export const XALO_METRO_MODELS: string[] = [VIADUCT, STATION, SKYWALK, CAB, MID, GANTRY_OUT, GANTRY_IN, ...BILLBOARDS];

// ---------------------------------------------------------------------------------------------
// Model geometry facts read from the GLBs (metres, model space).
// ---------------------------------------------------------------------------------------------
/** Viaduct pier: a 2.2 m square column up to y = 7; the 7.5 m wide cap above it is overhead and never solid. */
const PIER_HALF_XZ = 1.1;
const PIER_COLUMN_HEIGHT = 7;
/** Station body extent (model space): the raised body overhangs x −10…13.5 and z ±15.7. */
const STATION_X0 = -10;
const STATION_X1 = 13.5;
const STATION_HALF_Z = 15.7;
const STATION_NUDGE_MAX_M = 8;
/** Station anchors (model space): east and west ends of the deck, 6 m up. */
const ANCHOR_EAST = { x: 13.5, z: 12 };
const ANCHOR_WEST = { x: -13.5, z: -12 };
/** Skywalk: the deck's −X end sits at x = −12; three 0.5 m columns and a stair footprint touch the ground. */
const SKYWALK_DECK_END_X = -12;
const SKYWALK_FEET: readonly [number, number, number, number][] = [
  [-11.25, -10.75, -0.25, 0.25],
  [-0.25, 0.25, -0.25, 0.25],
  [10.75, 11.25, -0.25, 0.25],
  [12.66, 20.34, -1.2, 1.2],
];
/** Gantry legs (model space): 0.6 m square at x = ±17. */
const GANTRY_LEG_X = 17;
const GANTRY_LEG_HALF_X = 0.3;
const GANTRY_LEG_HALF_Z = 0.3;
/** Billboard pole: ≈ 1.1 m square. */
const BILLBOARD_POLE_HALF = 0.6;
/** Metro car extents along the car's own +Z (cab: −10 … 11.76, mid: ±10) and pivot spacing along the train. */
const CAR_PITCH_M = 20;
const TRAIN_LENGTH_M = 11.76 + 3 * CAR_PITCH_M + 11.76;
/** Piers closer than this to a racing-path sample become solid. */
const PIER_COLLIDER_RANGE_M = 8;
/** The two tracks run this far either side of the viaduct centre line. */
const TRACK_OFFSET_M = 1.5;
/** Extra clearance a support stands from the carriageway edge / a billboard pole from the road edge. */
const SUPPORT_MARGIN_M = 1.5;
const BILLBOARD_MARGIN_M = 3;
const SKYWALK_SHIFT_STEP_M = 0.5;
const SKYWALK_SHIFT_MAX_M = 14;

// ---------------------------------------------------------------------------------------------
// Raw JSON shapes.
// ---------------------------------------------------------------------------------------------
interface RawMetro {
  viaduct: { path: number[][]; spanM: number; offsetFromMainX: number };
  stations: { position: [number, number, number]; skywalks: number }[];
  trains: { deckY: number; speedKmh: number; headwaySec: number };
}
interface RawXaLo {
  metro: RawMetro;
  gantries: { t: number; model: string; side: string }[];
  billboards: { position: [number, number, number]; model: string; facing: string }[];
}

export interface PierInfo {
  index: number;
  x: number;
  z: number;
  /** Along-track t of the racing-path point nearest to the pier. */
  t: number;
  distToRoadM: number;
}

export type PieceAction = 'ok' | 'shifted' | 'rotated' | 'skipped';
export interface PieceReport {
  kind: 'skywalk' | 'gantry' | 'billboard' | 'station';
  name: string;
  action: PieceAction;
  /** Smallest distance from a support / pole / leg to the racing path (m); Infinity if skipped. */
  minDistM: number;
  requiredM: number;
  detail: string;
}

// ---------------------------------------------------------------------------------------------
// Pure placement helpers (exported for tests).
// ---------------------------------------------------------------------------------------------

/** World pose of a prop: position and yaw (model +Z → (sin yaw, cos yaw), model +X → (cos yaw, −sin yaw)). */
export interface Pose2 {
  x: number;
  z: number;
  yaw: number;
}

/** Model-space (lx, lz) of a prop at `pose` as a world x / z. */
export function toWorld(pose: Pose2, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(pose.yaw);
  const s = Math.sin(pose.yaw);
  return { x: pose.x + lx * c + lz * s, z: pose.z - lx * s + lz * c };
}

/** Yaw that puts the model's +Z along the viaduct's +Z-ish direction (so model +X points east). */
export function viaductYaw(poly: readonly (readonly number[])[]): number {
  const a = poly[0];
  const b = poly[poly.length - 1];
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  // The path heads −Z; face the opposite way so the station's "east" anchor is on world +X.
  return dz < 0 ? Math.atan2(-dx, -dz) : Math.atan2(dx, dz);
}

/**
 * Viaduct centre line: the outbound leg of the racing path (heading −Z between `zFrom` and `zTo`), shifted
 * `shiftX` metres in X and resampled every ~`stepM`. Runs from the start of the leg towards −Z.
 */
export function viaductPolyline(
  path: TrackPath,
  zFrom: number,
  zTo: number,
  shiftX: number,
  stepM: number,
): number[][] {
  // Longest run of consecutive samples that head −Z inside the z window.
  let bestStart = 0;
  let bestLen = 0;
  let runStart = -1;
  const n = path.count;
  for (let i = 0; i <= n; i++) {
    const ok = i < n && path.tz[i] < 0 && path.pz[i] <= zFrom && path.pz[i] >= zTo;
    if (ok && runStart < 0) runStart = i;
    if (!ok && runStart >= 0) {
      if (i - runStart > bestLen) {
        bestLen = i - runStart;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  const stride = Math.max(1, Math.round(stepM / path.spacingM));
  const poly: number[][] = [];
  for (let k = 0; k < bestLen; k += stride) {
    const i = bestStart + k;
    poly.push([path.px[i] + shiftX, 0, path.pz[i]]);
  }
  const last = bestStart + bestLen - 1;
  if (bestLen > 0 && (bestLen - 1) % stride !== 0) poly.push([path.px[last] + shiftX, 0, path.pz[last]]);
  return poly;
}

/** Station pose on a −Z-heading polyline at world z: x from the polyline, yaw facing +Z-ish (model +X = east). */
export function stationPoseAt(poly: readonly (readonly number[])[], z: number): Pose2 {
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    if (z <= a[2] && z >= b[2]) {
      const k = (a[2] - z) / (a[2] - b[2] || 1);
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      return { x: a[0] + dx * k, z, yaw: Math.atan2(-dx, -dz) };
    }
  }
  const e = poly[poly.length - 1];
  return { x: e[0], z, yaw: 0 };
}

/** Smallest (distance − that sample's carriageway half width) from (x, z) to any racing-path sample. */
export function edgeClearanceM(track: TrackDef, path: TrackPath, x: number, z: number): number {
  let best = Infinity;
  for (let k = 0; k < path.count; k++) {
    const half = roadWidthAt(track, k / path.count) / 2;
    best = Math.min(best, Math.hypot(path.px[k] - x, path.pz[k] - z) - half);
  }
  return best;
}

/** Edge clearance of the station body (x −10…13.5, z ±15.7 at its pose), sampled on a 5 × 3 grid. */
export function stationEdgeClearanceM(track: TrackDef, path: TrackPath, pose: Pose2): number {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 3; j++) {
      const w = toWorld(pose, STATION_X0 + ((STATION_X1 - STATION_X0) * i) / 4, STATION_HALF_Z * (j - 1));
      best = Math.min(best, edgeClearanceM(track, path, w.x, w.z));
    }
  }
  return best;
}

export function skywalkMinDistM(path: TrackPath, pose: Pose2): number {
  let best = Infinity;
  for (const [x0, x1, z0, z1] of SKYWALK_FEET) {
    best = Math.min(best, rectDistanceToPathM(path, pose.x, pose.z, pose.yaw, x0, x1, z0, z1));
  }
  return best;
}

export interface SkywalkPlan {
  pose: Pose2;
  mode: 'outward' | 'along';
  shiftM: number;
  minDistM: number;
}

/**
 * Where a skywalk goes for one station anchor. First choice: the deck leaves the anchor straight out sideways with
 * its −X end on it. If any support or the stair would stand within `requiredM` of the racing path, the skywalk
 * slides away from the station in 0.5 m steps; if that never clears, it is turned to run along the station
 * instead and slides the same way. Returns null if nothing clears.
 */
export function planSkywalk(path: TrackPath, station: Pose2, east: boolean, requiredM: number): SkywalkPlan | null {
  const a = east ? ANCHOR_EAST : ANCHOR_WEST;
  const anchor = toWorld(station, a.x, a.z);
  const c = Math.cos(station.yaw);
  const s = Math.sin(station.yaw);
  const dirs = {
    outward: { x: east ? c : -c, z: east ? -s : s, yaw: east ? station.yaw : station.yaw + Math.PI },
    // Away from the station centre along its length (east anchor z > 0, west z < 0).
    along: {
      x: east ? s : -s,
      z: east ? c : -c,
      yaw: east ? station.yaw - Math.PI / 2 : station.yaw + Math.PI / 2,
    },
  } as const;
  for (const mode of ['outward', 'along'] as const) {
    const d = dirs[mode];
    for (let shift = 0; shift <= SKYWALK_SHIFT_MAX_M + 1e-9; shift += SKYWALK_SHIFT_STEP_M) {
      const off = -SKYWALK_DECK_END_X + shift;
      const pose: Pose2 = { x: anchor.x + d.x * off, z: anchor.z + d.z * off, yaw: d.yaw };
      const minDistM = skywalkMinDistM(path, pose);
      if (minDistM >= requiredM) return { pose, mode, shiftM: shift, minDistM };
    }
  }
  return null;
}

/** Nearest racing-path sample index to (x, z). */
function nearestIndex(path: TrackPath, x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.count; i++) {
    const d = (path.px[i] - x) ** 2 + (path.pz[i] - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Yaw for a sign that faces `facing` traffic ("outbound" heads −Z, "inbound" heads +Z): model +Z follows the traffic
 * (ad face −Z toward it). Uses the real road tangent of the nearest matching carriageway within 80 m.
 */
export function billboardYaw(path: TrackPath, x: number, z: number, facing: string): number {
  const want = facing.startsWith('outbound') ? -1 : 1;
  let best = -1;
  let bestD = 80 * 80;
  for (let i = 0; i < path.count; i++) {
    if (path.tz[i] * want <= 0) continue;
    const d = (path.px[i] - x) ** 2 + (path.pz[i] - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? Math.atan2(path.tx[best], path.tz[best]) : want < 0 ? Math.PI : 0;
}

/** Moves a billboard pole straight away from the road until it stands `requiredM` from the racing path. */
export function planBillboard(
  path: TrackPath,
  x: number,
  z: number,
  requiredM: number,
): { x: number; z: number; shiftM: number; minDistM: number } {
  let cx = x;
  let cz = z;
  let shift = 0;
  for (let iter = 0; iter < 8; iter++) {
    const d = distanceToPathM(path, cx, cz);
    if (d >= requiredM) return { x: cx, z: cz, shiftM: shift, minDistM: d };
    const i = nearestIndex(path, cx, cz);
    let dx = cx - path.px[i];
    let dz = cz - path.pz[i];
    const h = Math.hypot(dx, dz) || 1;
    dx /= h;
    dz /= h;
    const push = requiredM - d + 0.25;
    cx += dx * push;
    cz += dz * push;
    shift += push;
  }
  return { x: cx, z: cz, shiftM: shift, minDistM: distanceToPathM(path, cx, cz) };
}

export function gantryMinDistM(path: TrackPath, pose: Pose2): number {
  let best = Infinity;
  for (const sx of [-1, 1]) {
    const lx = sx * GANTRY_LEG_X;
    best = Math.min(
      best,
      rectDistanceToPathM(
        path,
        pose.x,
        pose.z,
        pose.yaw,
        lx - GANTRY_LEG_HALF_X,
        lx + GANTRY_LEG_HALF_X,
        -GANTRY_LEG_HALF_Z,
        GANTRY_LEG_HALF_Z,
      ),
    );
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Instancing.
// ---------------------------------------------------------------------------------------------
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** One InstancedMesh per sub-mesh of a GLB (materials merged; textured and glowing ones stay separate draws). */
class Inst {
  readonly meshes: THREE.InstancedMesh[] = [];
  private readonly locals: THREE.Matrix4[] = [];
  private readonly tmp = new THREE.Matrix4();

  constructor(
    private readonly parent: THREE.Object3D,
    assets: Assets,
    path: string,
    readonly count: number,
  ) {
    const root = assets.cloneModel(path);
    mergePropMaterials(root);
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const inst = new THREE.InstancedMesh(o.geometry, o.material, count);
      inst.name = o.name;
      inst.frustumCulled = false;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < count; i++) inst.setMatrixAt(i, ZERO);
      parent.add(inst);
      this.meshes.push(inst);
      this.locals.push(o.matrixWorld.clone());
    });
  }

  set(i: number, base: THREE.Matrix4): void {
    for (let k = 0; k < this.meshes.length; k++) {
      this.meshes[k].setMatrixAt(i, this.tmp.multiplyMatrices(base, this.locals[k]));
    }
  }

  hide(i: number): void {
    for (const m of this.meshes) m.setMatrixAt(i, ZERO);
  }

  commit(): void {
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.meshes) {
      this.parent.remove(m);
      m.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!mat.userData.shared) mat.dispose();
      }
    }
    this.meshes.length = 0;
  }
}

const scratchM = new THREE.Matrix4();
const poseScratch: PolyPose = { x: 0, y: 0, z: 0, yaw: 0 };

function placeAt(m: THREE.Matrix4, x: number, y: number, z: number, yaw: number): THREE.Matrix4 {
  return m.makeRotationY(yaw).setPosition(x, y, z);
}

/** Viaduct, stations, skywalks, metro trains, sign gantries and billboards of Xa Lo Ha Noi. */
export class XaLoMetro {
  readonly group = new THREE.Group();
  /** Piers that got a solid column collider. */
  readonly piers: PierInfo[] = [];
  /** Number of spans tiled along the viaduct, and how many of them have a pier collider. */
  spanCount = 0;
  /** Final world pose of each station (after any sideways nudge). */
  readonly stationPoses: Pose2[] = [];
  /** Span indices left out because their pier would stand too close to a carriageway. */
  readonly skippedSpans: number[] = [];
  /** Per-piece clearance results (skywalks, gantries, billboards, stations). */
  readonly reports: PieceReport[] = [];
  /** Worst-case draw calls (every sub-mesh of every set drawn); distance windows cut this in practice. */
  drawCallEstimate = 0;

  private readonly sets: Inst[] = [];
  private readonly body: RAPIER.RigidBody;
  private time = 0;
  private readonly trainSets: { cab: Inst; mid: Inst } | null;
  private readonly poly: number[][];
  private readonly viaductLenM: number;
  private readonly loopM: number;
  private readonly speedMps: number;
  private readonly headwayS: number;
  private readonly perDir: number;
  private readonly deckY: number;

  constructor(
    private readonly scene: THREE.Scene,
    R: Rapier,
    private readonly world: RAPIER.World,
    assets: Assets,
    track: TrackDef,
    path: TrackPath,
  ) {
    const raw = track.raw as unknown as RawXaLo;
    const metro = raw.metro;
    const [pa, pb] = metro.viaduct.path;
    this.poly = viaductPolyline(path, pa[2], pb[2], metro.viaduct.offsetFromMainX, 30);
    this.viaductLenM = polylineLengthM(this.poly);
    this.deckY = metro.trains.deckY;
    this.speedMps = metro.trains.speedKmh / 3.6;
    this.headwayS = metro.trains.headwaySec;
    this.loopM = this.viaductLenM + TRAIN_LENGTH_M;
    this.perDir = trainsPerDirection(this.loopM, this.speedMps, this.headwayS);
    scene.add(this.group);
    this.group.name = 'XaLoMetro';

    const drawM = drawDistance(track.daylight, 120);
    const roadHalf = track.roadWidthM / 2;
    const supportClearM = roadHalf + SUPPORT_MARGIN_M;
    const windowed: Inst[] = [];
    const add = (path: string, count: number): Inst => {
      const s = new Inst(this.group, assets, path, count);
      this.sets.push(s);
      return s;
    };

    // --- Viaduct spans + pier colliders -------------------------------------------------------
    const spans = spanPlacements(this.poly, metro.viaduct.spanM);
    this.spanCount = spans.length;
    const viaduct = add(VIADUCT, spans.length);
    this.body = world.createRigidBody(R.RigidBodyDesc.fixed());
    spans.forEach((sp, i) => {
      viaduct.set(i, placeAt(scratchM, sp.x, sp.y, sp.z, sp.yaw));
      // A pier that would stand within road half width + 1.5 m of any carriageway sample is not built at all.
      const edge = edgeClearanceM(track, path, sp.x, sp.z);
      if (edge - PIER_HALF_XZ < SUPPORT_MARGIN_M) {
        viaduct.hide(i);
        this.skippedSpans.push(i);
        return;
      }
      const d = distanceToPathM(path, sp.x, sp.z);
      if (d > PIER_COLLIDER_RANGE_M) return;
      world.createCollider(
        R.ColliderDesc.cuboid(PIER_HALF_XZ, PIER_COLUMN_HEIGHT / 2, PIER_HALF_XZ)
          .setTranslation(sp.x, sp.y + PIER_COLUMN_HEIGHT / 2, sp.z)
          .setRotation({ x: 0, y: Math.sin(sp.yaw / 2), z: 0, w: Math.cos(sp.yaw / 2) }),
        this.body,
      );
      this.piers.push({ index: i, x: sp.x, z: sp.z, t: path.project(sp.x, sp.z), distToRoadM: d });
    });
    viaduct.commit();
    windowed.push(viaduct);

    // --- Stations + skywalks -------------------------------------------------------------------
    const stations = add(STATION, metro.stations.length);
    const planned: { pose: Pose2; y: number }[] = [];
    metro.stations.forEach((st, i) => {
      const base = stationPoseAt(this.poly, st.position[2]);
      // Slide the station sideways (model +X, away from the frontage road) until its body clears the carriageways.
      let nudge = 0;
      let pose = base;
      while (nudge < STATION_NUDGE_MAX_M && stationEdgeClearanceM(track, path, pose) < SUPPORT_MARGIN_M) {
        nudge += 0.5;
        pose = { ...toWorld(base, nudge, 0), yaw: base.yaw };
      }
      this.stationPoses.push(pose);
      stations.set(i, placeAt(scratchM, pose.x, st.position[1], pose.z, pose.yaw));
      // The station body has no collider; report how close its ground-level footprint is to the road.
      const foot = stationEdgeClearanceM(track, path, pose);
      this.reports.push({
        kind: 'station',
        name: `station ${i}`,
        minDistM: foot,
        requiredM: SUPPORT_MARGIN_M,
        detail: `body edge clearance ${foot.toFixed(1)} m` + (nudge > 0 ? `, slid ${nudge.toFixed(1)} m east` : ''),
        action: foot >= SUPPORT_MARGIN_M ? (nudge > 0 ? 'shifted' : 'ok') : 'skipped',
      });
      for (const east of [true, false]) {
        const plan = planSkywalk(path, pose, east, supportClearM);
        const name = `station ${i} skywalk ${east ? 'east' : 'west'}`;
        if (!plan) {
          this.reports.push({
            kind: 'skywalk',
            name,
            action: 'skipped',
            minDistM: Infinity,
            requiredM: supportClearM,
            detail: 'no shift or rotation clears the racing path',
          });
          continue;
        }
        const action: PieceAction = plan.mode === 'along' ? 'rotated' : plan.shiftM > 0 ? 'shifted' : 'ok';
        this.reports.push({
          kind: 'skywalk',
          name,
          action,
          minDistM: plan.minDistM,
          requiredM: supportClearM,
          detail: `${plan.mode}, shifted ${plan.shiftM.toFixed(1)} m`,
        });
        planned.push({ pose: plan.pose, y: st.position[1] });
      }
    });
    stations.commit();
    windowed.push(stations);
    if (planned.length > 0) {
      const walks = add(SKYWALK, planned.length);
      planned.forEach((p, i) => walks.set(i, placeAt(scratchM, p.pose.x, p.y, p.pose.z, p.pose.yaw)));
      walks.commit();
      windowed.push(walks);
    }

    // --- Sign gantries ---------------------------------------------------------------------------
    const gantryPlans = new Map<string, { x: number; y: number; z: number; yaw: number }[]>();
    for (const g of raw.gantries) {
      const model = g.side === 'inbound' ? GANTRY_IN : GANTRY_OUT;
      const pt = path.pointAt(g.t);
      const tan = path.tangentAt(g.t);
      const pose: Pose2 = { x: pt.x, z: pt.z, yaw: Math.atan2(tan.x, tan.z) };
      const minDistM = gantryMinDistM(path, pose);
      const ok = minDistM >= supportClearM;
      this.reports.push({
        kind: 'gantry',
        name: `gantry t=${g.t}`,
        action: ok ? 'ok' : 'skipped',
        minDistM,
        requiredM: supportClearM,
        detail: ok ? 'legs clear' : 'a leg stands too close to the racing path',
      });
      if (!ok) continue;
      const list = gantryPlans.get(model) ?? [];
      list.push({ x: pose.x, y: path.yAt(g.t), z: pose.z, yaw: pose.yaw });
      gantryPlans.set(model, list);
    }
    for (const [model, list] of gantryPlans) {
      const set = add(model, list.length);
      list.forEach((p, i) => set.set(i, placeAt(scratchM, p.x, p.y, p.z, p.yaw)));
      set.commit();
      windowed.push(set);
    }

    // --- Billboards ------------------------------------------------------------------------------
    const boardPlans = new Map<string, { x: number; y: number; z: number; yaw: number }[]>();
    const boardClearM = roadHalf + BILLBOARD_MARGIN_M;
    for (const b of raw.billboards) {
      const plan = planBillboard(path, b.position[0], b.position[2], boardClearM + BILLBOARD_POLE_HALF);
      const ok = plan.minDistM >= boardClearM;
      this.reports.push({
        kind: 'billboard',
        name: `${b.model.split('/').pop()} @ ${b.position[0]},${b.position[2]}`,
        action: !ok ? 'skipped' : plan.shiftM > 0 ? 'shifted' : 'ok',
        minDistM: plan.minDistM,
        requiredM: boardClearM,
        detail: plan.shiftM > 0 ? `moved ${plan.shiftM.toFixed(1)} m away from the road` : 'in place',
      });
      if (!ok) continue;
      const list = boardPlans.get(b.model) ?? [];
      list.push({
        x: plan.x,
        y: b.position[1],
        z: plan.z,
        yaw: billboardYaw(path, plan.x, plan.z, b.facing),
      });
      boardPlans.set(b.model, list);
    }
    for (const [model, list] of boardPlans) {
      const set = add(model, list.length);
      list.forEach((p, i) => set.set(i, placeAt(scratchM, p.x, p.y, p.z, p.yaw)));
      set.commit();
      windowed.push(set);
    }

    // --- Trains (animated every frame, drawn whole) ----------------------------------------------
    const cars = this.perDir * 2;
    this.trainSets = { cab: add(CAB, cars * 2), mid: add(MID, cars * 2) };
    this.update(0);
    // Trains move every frame but stay on the viaduct: draw them only while the camera is near some part of it.
    const polyXZ = new Float32Array(this.poly.length * 2);
    this.poly.forEach((q, i) => {
      polyXZ[i * 2] = q[0];
      polyXZ[i * 2 + 1] = q[2];
    });
    gateByDistance([...this.trainSets.cab.meshes, ...this.trainSets.mid.meshes], polyXZ, drawM);

    for (const s of windowed) windowInstances(s.meshes, drawM);
    for (const s of this.sets) this.drawCallEstimate += s.meshes.length;
  }

  /** Moves the trains; does not allocate. */
  update(dt: number): void {
    const sets = this.trainSets;
    if (!sets) return;
    this.time += dt;
    let cabI = 0;
    let midI = 0;
    for (let dir = 0; dir < 2; dir++) {
      const forward = dir === 0;
      // The two directions run on separate tracks, 20 s out of step so they do not mirror each other.
      const phase = dir * 20;
      for (let k = 0; k < this.perDir; k++) {
        const head = trainHeadM(this.time + phase, this.speedMps, this.loopM, this.headwayS, k);
        for (let j = 0; j < 4; j++) {
          const pivot = head - j * CAR_PITCH_M;
          const onLine = pivot >= 0 && pivot <= this.viaductLenM;
          const isCab = j === 0 || j === 3;
          const set = isCab ? sets.cab : sets.mid;
          const idx = isCab ? cabI++ : midI++;
          if (!onLine) {
            set.hide(idx);
            continue;
          }
          const s = forward ? pivot : this.viaductLenM - pivot;
          polylinePoseAt(this.poly, s, poseScratch);
          const heading = forward ? poseScratch.yaw : poseScratch.yaw + Math.PI;
          // Trains keep right: the lateral offset is to the right of their own heading.
          const x = poseScratch.x - Math.cos(heading) * TRACK_OFFSET_M;
          const z = poseScratch.z + Math.sin(heading) * TRACK_OFFSET_M;
          // The last cab is turned round so both ends of the train have a nose.
          placeAt(scratchM, x, this.deckY, z, j === 3 ? heading + Math.PI : heading);
          set.set(idx, scratchM);
        }
      }
    }
    sets.cab.commit();
    sets.mid.commit();
  }

  dispose(): void {
    for (const s of this.sets) s.dispose();
    this.sets.length = 0;
    this.world.removeRigidBody(this.body);
    this.scene.remove(this.group);
  }
}
