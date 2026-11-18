import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { RACE, roadWidthAt, type TrackDef } from '../core/Data';
import { userSettings } from '../core/Settings';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import { nearestSample } from './Corridor';
import type { TrackPath } from './TrackPath';
import { DistanceCull, drawDistance, gateByDistance, windowInstances } from './Windowed';

type Rapier = typeof RAPIER;

const M = 'models/props_catlai/';
const QUAY_EDGE = `${M}quay_edge.glb`;
const STS = `${M}sts_quay_crane.glb`;
const RTG = `${M}rtg_crane.glb`;
const SHIP = `${M}container_ship.glb`;
const FERRY = `${M}river_ferry.glb`;
const STACKER = `${M}reach_stacker.glb`;
const RAMP = 'models/props/jump_ramp.glb';
const TRUCK_BLUE = 'models/props_xalo/container_truck_blue.glb';
const TRUCK_RED = 'models/props_xalo/container_truck_red.glb';

/** Every model this module loads (for the track's asset list). */
export const CAT_LAI_QUAY_MODELS: string[] = [QUAY_EDGE, STS, RTG, SHIP, FERRY, STACKER, RAMP, TRUCK_BLUE, TRUCK_RED];
/** Textures this module loads (the Reefer lane uses the port apron texture). */
export const CAT_LAI_QUAY_TEXTURES: string[] = ['textures/catlai_apron.png'];

// --- Facts read from the GLBs (metres, model space) -------------------------------------------------------------
/** STS legs: 1.8 m square columns at x ±15, z ±9; the wheel bogies under them span x 13.5–16.5, z 7–11. */
const STS_LEG_X = 15;
const STS_LEG_Z = 9;
const STS_LEG_HALF_X = 1.6;
const STS_LEG_HALF_Z = 2.2;
/** RTG legs: a column pair per side at x ±11.1…12.4, tyres out to ±12.6 along z ±5.5. */
const RTG_LEG_X = 11.75;
const RTG_LEG_HALF_X = 0.95;
const RTG_LEG_HALF_Z = 5.6;
/** Collider height of crane legs (only the part a car could touch matters). */
const LEG_HALF_Y = 12;
const FERRY_HALF_LEN_M = 24;
const FERRY_Y = -0.1;
const SHIP_Y = -1.2;
/** Reach stacker body (chassis) and truck footprint for kinematic colliders. */
const STACKER_HALF: [number, number, number] = [2.4, 1.9, 5.5];
const TRUCK_HALF: [number, number, number] = [1.25, 1.95, 8.2];

const QUAY_WALL_HALF_X = 0.4;
const QUAY_WALL_HALF_Y = 0.75;
/** Dynamic sets farther than this from the camera focus are hidden. */
const DYNAMIC_DRAW_RADIUS_M = 380;

// --- JSON ------------------------------------------------------------------------------------------------------
interface RawCatLai {
  quay: { edgeX: number; fromN: number; toN: number; tileM: number };
  cranes: { sts: { positions: [number, number, number][] }; rtg: { positions: [number, number, number][] } };
  ships: { position: [number, number, number]; headingDeg: number }[];
  ferry: { landing: [number, number, number]; crossing: { to: [number, number, number]; durationSec: number } };
  yardTraffic: { reachStackers: { count: number }; trucks: number };
  shortcut: {
    fromT: number;
    toT: number;
    widthM: number;
    points: [number, number, number][];
    ramp: { position: [number, number, number]; heightM: number; lengthM: number };
  };
  roadLayout: { yardLanes: { widthM: number } };
}

export const catLaiRaw = (track: TrackDef): RawCatLai => track.raw as unknown as RawCatLai;

// --- Pure helpers (unit-tested) ---------------------------------------------------------------------------------

/** A box on the ground plane: centre, half extents along its own axes, and yaw (rotation about +Y like THREE). */
export interface GroundBox {
  cx: number;
  cz: number;
  /** Half extent along the box's local X / Z. */
  hx: number;
  hz: number;
  yaw: number;
}

/** The four solid legs of an STS crane at (x, z) (yaw 0: the lane runs along Z between the legs). */
export function stsLegBoxes(x: number, z: number): GroundBox[] {
  const out: GroundBox[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      out.push({
        cx: x + sx * STS_LEG_X,
        cz: z + sz * STS_LEG_Z,
        hx: STS_LEG_HALF_X,
        hz: STS_LEG_HALF_Z,
        yaw: 0,
      });
    }
  }
  return out;
}

/** The two solid leg rows of an RTG crane at (x, z) rotated by `yaw`. */
export function rtgLegBoxes(x: number, z: number, yaw: number): GroundBox[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [-1, 1].map((side) => ({
    // Model +X maps to (cos yaw, −sin yaw): the same rotation THREE uses about +Y.
    cx: x + side * RTG_LEG_X * c,
    cz: z - side * RTG_LEG_X * s,
    hx: RTG_LEG_HALF_X,
    hz: RTG_LEG_HALF_Z,
    yaw,
  }));
}

/** Distance from (x, z) to a box (0 inside). */
export function boxDistance(b: GroundBox, x: number, z: number): number {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const dx = x - b.cx;
  const dz = z - b.cz;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.hypot(Math.max(Math.abs(lx) - b.hx, 0), Math.max(Math.abs(lz) - b.hz, 0));
}

/**
 * Free metres between the racing carriageway's edge and a set of solid boxes: min over path samples of
 * (distance to the nearest box − half road width at that sample). Negative = a box sits on the road.
 */
export function laneClearanceM(path: TrackPath, track: TrackDef, boxes: readonly GroundBox[]): number {
  let best = Infinity;
  for (let i = 0; i < path.count; i++) {
    const half = roadWidthAt(track, i / path.count) / 2;
    for (const b of boxes) {
      const d = boxDistance(b, path.px[i], path.pz[i]) - half;
      if (d < best) best = d;
    }
  }
  return best;
}

/** Yaw that points an RTG crane's model +Z (its lane axis) along the racing path at the sample nearest (x, z). */
export function rtgYaw(path: TrackPath, x: number, z: number): number {
  const i = nearestSample(path, x, z);
  return Math.atan2(path.tx[i], path.tz[i]);
}

/** Ferry timeline: dock, cross east, dwell, cross back. Returns the centre x and the yaw (model +Z along travel). */
export interface FerryPose {
  x: number;
  yaw: number;
}

export function ferryPose(
  timeSec: number,
  landingX: number,
  farX: number,
  crossSec: number,
  dwellSec: number,
  out: FerryPose,
): FerryPose {
  const dockX = landingX + FERRY_HALF_LEN_M;
  const period = 2 * (crossSec + dwellSec);
  const u = ((timeSec % period) + period) % period;
  const ease = (k: number): number => k * k * (3 - 2 * k);
  if (u < dwellSec) {
    out.x = dockX;
    out.yaw = Math.PI / 2;
  } else if (u < dwellSec + crossSec) {
    out.x = dockX + (farX - dockX) * ease((u - dwellSec) / crossSec);
    out.yaw = Math.PI / 2; // heading +X
  } else if (u < 2 * dwellSec + crossSec) {
    out.x = farX;
    out.yaw = -Math.PI / 2;
  } else {
    out.x = farX + (dockX - farX) * ease((u - 2 * dwellSec - crossSec) / crossSec);
    out.yaw = -Math.PI / 2; // heading −X
  }
  return out;
}

/** One reach-stacker crossing: it shuttles A ↔ B across a lane, dwelling at each side. */
export interface Crossing {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  phaseSec: number;
}
export interface StackerPose {
  x: number;
  z: number;
  yaw: number;
}

export const STACKER_DWELL_SEC = 8;
export const STACKER_CROSS_SEC = 6;

/** Smooth 0→1 step. */
const smooth = (k: number): number => {
  const c = Math.min(1, Math.max(0, k));
  return c * c * (3 - 2 * c);
};

/**
 * Pose along a crossing. The stacker waits parked PARALLEL to the lane, beside it (an 11 m machine parked across the
 * lane would block it), then swings square to the lane for the crossing and back again.
 */
export function stackerPose(c: Crossing, timeSec: number, out: StackerPose): StackerPose {
  const period = 2 * (STACKER_DWELL_SEC + STACKER_CROSS_SEC);
  const u = (((timeSec + c.phaseSec) % period) + period) % period;
  const toB = Math.atan2(c.bx - c.ax, c.bz - c.az);
  let k: number;
  let dir: number;
  if (u < STACKER_DWELL_SEC) {
    k = 0;
    dir = 0;
  } else if (u < STACKER_DWELL_SEC + STACKER_CROSS_SEC) {
    k = smooth((u - STACKER_DWELL_SEC) / STACKER_CROSS_SEC);
    dir = 0;
  } else if (u < 2 * STACKER_DWELL_SEC + STACKER_CROSS_SEC) {
    k = 1;
    dir = 1;
  } else {
    k = 1 - smooth((u - 2 * STACKER_DWELL_SEC - STACKER_CROSS_SEC) / STACKER_CROSS_SEC);
    dir = 1;
  }
  // 1 while square to the lane (mid-crossing), 0 when parked at either side.
  const square = smooth(k / 0.15) * (1 - smooth((k - 0.85) / 0.15));
  const base = toB + dir * Math.PI;
  out.yaw = base + (1 - square) * (dir === 0 ? Math.PI / 2 : -Math.PI / 2);
  out.x = c.ax + (c.bx - c.ax) * k;
  out.z = c.az + (c.bz - c.az) * k;
  return out;
}

/**
 * Where the stackers cross: two crossings of the Reefer lane (at 40 % and 75 % of its length, along Z) and one of
 * the yard lane at the shortcut's mouth (along the lane's normal). Each spans the road plus `margin` on both sides.
 */
export function stackerCrossings(track: TrackDef, _path: TrackPath, count: number): Crossing[] {
  const raw = catLaiRaw(track);
  const pts = raw.shortcut.points;
  const sx0 = pts[0][0];
  const sx1 = pts[pts.length - 1][0];
  const sz = pts[0][2];
  // Parked beside the side walls: wall outer face + half the machine's width + a little air.
  const half = SHORTCUT_WALL_GAP_M + SHORTCUT_WALL_THICKNESS_M + STACKER_HALF[0] + 0.3;
  // Never on the racing roads: the yard lane is 10 m wide between container stacks and the stacker is 11 m long.
  const out: Crossing[] = [];
  for (const f of [0.2, 0.6, 0.85]) {
    const x = sx0 + (sx1 - sx0) * f;
    out.push({ ax: x, az: sz - half, bx: x, bz: sz + half, phaseSec: 0 });
  }
  const n = Math.min(count, out.length);
  return out.slice(0, n).map((c, k) => ({ ...c, phaseSec: k * 7 }));
}

/** The straight stretch of the yard lane where the trucks shuttle (t window) — wrap inside it. */
export const YARD_TRUCK_FROM_T = 0.322;
export const YARD_TRUCK_TO_T = 0.39;
export const YARD_TRUCK_SPEED_MPS = 4;

/** Along-track t of yard truck `k` of `n` after `timeSec`: evenly spaced, wrapping inside the window. */
export function yardTruckT(k: number, n: number, timeSec: number, lengthM: number): number {
  const span = YARD_TRUCK_TO_T - YARD_TRUCK_FROM_T;
  const u = (((k / n + (timeSec * YARD_TRUCK_SPEED_MPS) / (span * lengthM)) % 1) + 1) % 1;
  return YARD_TRUCK_FROM_T + u * span;
}

/** Reefer-lane geometry: ribbon centreline plus oriented side walls that leave both ends open. */
export interface ShortcutGeometry {
  points: [number, number][];
  widthM: number;
  walls: GroundBox[];
}

export const SHORTCUT_WALL_GAP_M = 3.8;
export const SHORTCUT_END_OPENING_M = 8;
export const SHORTCUT_WALL_THICKNESS_M = 0.8;

export function shortcutGeometry(track: TrackDef): ShortcutGeometry {
  const sc = catLaiRaw(track).shortcut;
  const pts = sc.points.map((p) => [p[0], p[2]] as [number, number]);
  const walls: GroundBox[] = [];
  const offset = SHORTCUT_WALL_GAP_M + SHORTCUT_WALL_THICKNESS_M / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const dx = (x1 - x0) / len;
    const dz = (z1 - z0) / len;
    const from = i === 0 ? SHORTCUT_END_OPENING_M : 0;
    const to = i + 2 === pts.length ? len - SHORTCUT_END_OPENING_M : len;
    if (to <= from) continue;
    const mid = (from + to) / 2;
    const yaw = Math.atan2(dx, dz);
    for (const side of [-1, 1]) {
      walls.push({
        cx: x0 + dx * mid + dz * offset * side,
        cz: z0 + dz * mid - dx * offset * side,
        hx: SHORTCUT_WALL_THICKNESS_M / 2,
        hz: (to - from) / 2,
        yaw,
      });
    }
  }
  return { points: pts, widthM: sc.widthM, walls };
}

/**
 * Where the Reefer lane joins the main road at each end. The main track's invisible side walls need a gap here
 * (centre x, z, and the half length of the gap along the main road).
 */
export function shortcutMouths(track: TrackDef): { x: number; z: number; halfGapM: number }[] {
  const sc = catLaiRaw(track).shortcut;
  const a = sc.points[0];
  const b = sc.points[sc.points.length - 1];
  const halfGap = sc.widthM / 2 + 3;
  return [
    { x: a[0], z: a[2], halfGapM: halfGap },
    { x: b[0], z: b[2], halfGapM: halfGap },
  ];
}

/** Quay tile centres (z) along the river edge: N = −z, tiles of `tileM`. */
export function quayTiles(q: { fromN: number; toN: number; tileM: number }): number[] {
  const n = Math.ceil((q.toN - q.fromN) / q.tileM);
  const z0 = -q.toN + q.tileM / 2;
  return Array.from({ length: n }, (_, i) => z0 + i * q.tileM);
}

// --- Instanced model sets ---------------------------------------------------------------------------------------

const tmpA = new THREE.Matrix4();
const tmpT = new THREE.Matrix4();

interface SetPart {
  mesh: THREE.InstancedMesh;
  /** Mesh transform inside the model, with every animated part at rest. */
  rest: THREE.Matrix4;
  /** The crane spreader: slides on its own while the rest of the model stays put. */
  anim: boolean;
}

/** N copies of one GLB as one InstancedMesh per merged sub-mesh; an optional `Spreader` part animates per copy. */
class ModelSet {
  readonly parts: SetPart[] = [];
  readonly meshes: THREE.InstancedMesh[] = [];
  private readonly base: THREE.Matrix4[];

  constructor(
    private readonly parent: THREE.Object3D,
    assets: Assets,
    path: string,
    readonly count: number,
    animateSpreader = false,
  ) {
    this.base = Array.from({ length: count }, () => new THREE.Matrix4());
    const proto = assets.cloneModel(path);
    if (animateSpreader) {
      // Keep the spreader out of the material merge (the merge skips this name) so it stays its own draw.
      proto.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material instanceof THREE.Material && o.material.name === 'Spreader') {
          o.material.userData.spreader = true;
          o.material.name = 'Light_Head';
        }
      });
    }
    mergePropMaterials(proto);
    proto.updateMatrixWorld(true);
    proto.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const inst = new THREE.InstancedMesh(o.geometry, o.material, count);
      inst.name = o.name;
      inst.frustumCulled = false;
      inst.castShadow = false;
      inst.receiveShadow = false;
      const anim = animateSpreader && !!(o.material as THREE.Material).userData.spreader;
      this.parts.push({ mesh: inst, rest: o.matrixWorld.clone(), anim });
      this.meshes.push(inst);
      parent.add(inst);
    });
  }

  /** Set copy `i`'s placement (every part, spreader at rest). */
  set(i: number, m: THREE.Matrix4): void {
    this.base[i].copy(m);
    for (const p of this.parts) p.mesh.setMatrixAt(i, tmpA.multiplyMatrices(m, p.rest));
  }

  /** Slide copy `i`'s spreader by (dx, dy) in model space. */
  slide(i: number, dx: number, dy: number): void {
    tmpT.makeTranslation(dx, dy, 0);
    for (const p of this.parts) {
      if (!p.anim) continue;
      tmpA.multiplyMatrices(this.base[i], tmpT).multiply(p.rest);
      p.mesh.setMatrixAt(i, tmpA);
    }
  }

  commit(): void {
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }

  setVisible(v: boolean): void {
    for (const m of this.meshes) m.visible = v;
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
    this.parts.length = 0;
  }
}

const Q = new THREE.Quaternion();
const P = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
/** Placement matrix at (x, y, z) turned by `yaw` about +Y (shared temporaries: no allocation per call). */
const posQuat = (m: THREE.Matrix4, x: number, y: number, z: number, yaw: number): THREE.Matrix4 =>
  m.compose(P.set(x, y, z), Q.setFromAxisAngle(UP, yaw), ONE);

/** Spreader slide: slow sinusoid, a different phase per crane. */
const SPREADER_PERIOD_SEC = 46;

/**
 * Map 1's river side and moving parts: quay edge, six STS crane + three RTG crane colliders, two ships, the ferry,
 * reach stackers and trucks in the yard, and the Reefer-lane shortcut with its jump.
 */
export class CatLaiQuay {
  readonly group = new THREE.Group();
  private readonly body: RAPIER.RigidBody;
  private readonly sets: ModelSet[] = [];
  private readonly bodies: RAPIER.RigidBody[] = [];
  private stackerBodies: RAPIER.RigidBody[] = [];
  private readonly ribbon: THREE.Mesh;
  private stsSet: ModelSet;
  private rtgSet: ModelSet;
  private ferrySet: ModelSet | null = null;
  private ferryCfg: RawCatLai['ferry'];
  private crossings: Crossing[] = [];
  private stackerSet: ModelSet | null = null;
  private truckSets: ModelSet[] = [];
  private truckSlots: { set: ModelSet; slot: number; k: number; body: RAPIER.RigidBody }[] = [];
  private time = 0;
  private focus: { x: number; z: number } | null = null;
  private readonly m4 = new THREE.Matrix4();
  private readonly kinPos = { x: 0, y: 0, z: 0 };
  private readonly kinRot = { x: 0, y: 0, z: 0, w: 1 };
  private readonly fp: FerryPose = { x: 0, yaw: 0 };
  private readonly sp: StackerPose = { x: 0, z: 0, yaw: 0 };
  private readonly raw: RawCatLai;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly R: Rapier,
    private readonly world: RAPIER.World,
    assets: Assets,
    private readonly track: TrackDef,
    private readonly path: TrackPath,
  ) {
    this.group.name = 'cat_lai_quay';
    this.raw = catLaiRaw(track);
    this.ferryCfg = this.raw.ferry;
    this.body = world.createRigidBody(R.RigidBodyDesc.fixed());
    const draw = drawDistance(null, 70);

    this.buildQuay(assets, draw);
    this.stsSet = this.buildStsCranes(assets, draw);
    this.rtgSet = this.buildRtgCranes(assets, draw);
    this.buildShips(assets, draw);
    this.ribbon = this.buildShortcut(assets);
    if (userSettings.preset !== 'low') this.buildDynamic(assets);
    scene.add(this.group);
  }

  private add(set: ModelSet): ModelSet {
    this.sets.push(set);
    return set;
  }

  private collide(box: GroundBox, hy: number, friction = 0.3): void {
    const desc = this.R.ColliderDesc.cuboid(box.hx, hy, box.hz)
      .setTranslation(box.cx, hy, box.cz)
      .setRotation({ x: 0, y: Math.sin(box.yaw / 2), z: 0, w: Math.cos(box.yaw / 2) })
      .setFriction(friction);
    this.world.createCollider(desc, this.body);
  }

  private buildQuay(assets: Assets, draw: number): void {
    const q = this.raw.quay;
    const tiles = quayTiles(q);
    const set = this.add(new ModelSet(this.group, assets, QUAY_EDGE, tiles.length));
    tiles.forEach((z, i) => set.set(i, posQuat(this.m4, q.edgeX, 0, z, 0)));
    set.commit();
    windowInstances(set.meshes, draw);
    // Solid wall along the lip so nothing can be driven (or knocked) into the river.
    const zFrom = -q.toN;
    const zTo = -q.fromN;
    const wall: GroundBox = {
      cx: q.edgeX + 0.3,
      cz: (zFrom + zTo) / 2,
      hx: QUAY_WALL_HALF_X,
      hz: (zTo - zFrom) / 2,
      yaw: 0,
    };
    this.collide(wall, QUAY_WALL_HALF_Y, 0.2);
  }

  private buildStsCranes(assets: Assets, draw: number): ModelSet {
    const pos = this.raw.cranes.sts.positions;
    const set = this.add(new ModelSet(this.group, assets, STS, pos.length, true));
    pos.forEach((p, i) => {
      set.set(i, posQuat(this.m4, p[0], 0, p[2], 0));
      for (const b of stsLegBoxes(p[0], p[2])) this.collide(b, LEG_HALF_Y);
    });
    set.commit();
    gateByDistance(set.meshes, Float32Array.from(pos.flatMap((p) => [p[0], p[2]])), draw + 60);
    return set;
  }

  private buildRtgCranes(assets: Assets, draw: number): ModelSet {
    const pos = this.raw.cranes.rtg.positions;
    const set = this.add(new ModelSet(this.group, assets, RTG, pos.length, true));
    pos.forEach((p, i) => {
      const yaw = rtgYaw(this.path, p[0], p[2]);
      set.set(i, posQuat(this.m4, p[0], 0, p[2], yaw));
      for (const b of rtgLegBoxes(p[0], p[2], yaw)) this.collide(b, LEG_HALF_Y);
    });
    set.commit();
    gateByDistance(set.meshes, Float32Array.from(pos.flatMap((p) => [p[0], p[2]])), draw + 30);
    return set;
  }

  private buildShips(assets: Assets, draw: number): void {
    const ships = this.raw.ships;
    const set = this.add(new ModelSet(this.group, assets, SHIP, ships.length));
    ships.forEach((s, i) =>
      set.set(i, posQuat(this.m4, s.position[0], SHIP_Y, s.position[2], (s.headingDeg * Math.PI) / 180)),
    );
    set.commit();
    gateByDistance(set.meshes, Float32Array.from(ships.flatMap((s) => [s.position[0], s.position[2]])), draw + 90);
  }

  /** The Reefer lane: its own ribbon, side walls with open ends, and the loading-ramp jump. */
  private buildShortcut(assets: Assets): THREE.Mesh {
    const geo = shortcutGeometry(this.track);
    const sc = this.raw.shortcut;
    const tex = assets.texture('textures/catlai_apron.png');
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;

    // Ribbon from just inside the yard lane's middle to just inside the apron: it overlaps both roads a little.
    const pts = geo.points;
    const ribbonInset = 3;
    const rows: [number, number, number][] = []; // x, z, v
    let run = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const steps = Math.max(1, Math.ceil(len / 5));
      for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
        const k = s / steps;
        rows.push([x0 + (x1 - x0) * k, z0 + (z1 - z0) * k, run + len * k]);
      }
      run += len;
    }
    const first = rows[0];
    const last = rows[rows.length - 1];
    const trimmed = rows.filter((r) => r[2] >= ribbonInset && r[2] <= last[2] - ribbonInset);
    const half = geo.widthM / 2;
    const pos = new Float32Array(trimmed.length * 2 * 3);
    const uv = new Float32Array(trimmed.length * 2 * 2);
    trimmed.forEach((r, i) => {
      const a = Math.min(rows.length - 1, Math.max(0, rows.indexOf(r)));
      const p0 = rows[Math.max(0, a - 1)];
      const p1 = rows[Math.min(rows.length - 1, a + 1)];
      const dx = p1[0] - p0[0];
      const dz = p1[1] - p0[1];
      const l = Math.hypot(dx, dz) || 1;
      const lx = dz / l;
      const lz = -dx / l;
      for (let side = 0; side < 2; side++) {
        const s = side === 0 ? 1 : -1;
        const o = (i * 2 + side) * 3;
        pos[o] = r[0] + lx * half * s;
        pos[o + 1] = RACE.track.roadY + 0.01;
        pos[o + 2] = r[1] + lz * half * s;
        uv[(i * 2 + side) * 2] = side === 0 ? 0 : 1;
        uv[(i * 2 + side) * 2 + 1] = (r[2] - first[2]) / this.track.roadTextureRepeatM;
      }
    });
    const idx: number[] = [];
    for (let i = 0; i + 1 < trimmed.length; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.9,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const ribbon = new THREE.Mesh(g, mat);
    ribbon.name = 'reefer_lane';
    ribbon.receiveShadow = true;
    ribbon.frustumCulled = false;
    this.group.add(ribbon);

    for (const w of geo.walls) this.collide(w, RACE.track.wallColliderHeightM / 2 + 0.5, 0.2);
    this.buildRamp(assets, sc);
    return ribbon;
  }

  private buildRamp(assets: Assets, sc: RawCatLai['shortcut']): void {
    const ramp = assets.cloneModel(RAMP);
    const [rx, , rz] = sc.ramp.position;
    // The model is 18.8 m wide; "scale X to 0.4" fits it to the 7 m lane. Its +Z (the rising direction) points along
    // the lane (+X, the race direction).
    ramp.scale.x = 0.4;
    ramp.rotation.y = Math.PI / 2;
    ramp.position.set(rx, 0, rz);
    ramp.name = 'reefer_ramp';
    ramp.updateMatrixWorld(true);
    // Collider as in Track.buildRamps: the driving surface only, plus a gentle lead-in at ground level.
    const inv = ramp.matrixWorld.clone().invert();
    const v = new THREE.Vector3();
    const local: number[] = [];
    ramp.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (mat.name !== 'Ramp_Surface') return;
      const pos = o.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
        local.push(v.x, v.y, v.z);
      }
    });
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    for (let i = 0; i < local.length; i += 3) {
      minX = Math.min(minX, local[i]);
      maxX = Math.max(maxX, local[i]);
      minZ = Math.min(minZ, local[i + 2]);
    }
    if (local.length > 0) {
      local.push(minX, 0, minZ - RACE.track.rampLeadInM, maxX, 0, minZ - RACE.track.rampLeadInM);
      const pts: number[] = [];
      for (let i = 0; i < local.length; i += 3) {
        v.set(local[i], local[i + 1], local[i + 2]).applyMatrix4(ramp.matrixWorld);
        pts.push(v.x, v.y, v.z);
      }
      const hull = this.R.ColliderDesc.convexHull(new Float32Array(pts));
      if (hull) this.world.createCollider(hull.setFriction(0.8), this.body);
    }
    mergePropMaterials(ramp);
    const cull = new DistanceCull(ramp.position.clone(), 300, 14);
    this.group.add(cull);
    cull.add(ramp);
  }

  /** Ferry, reach stackers and yard trucks: cosmetic or kinematic, skipped on the Low preset. */
  private buildDynamic(assets: Assets): void {
    const raw = this.raw;
    this.ferrySet = this.add(new ModelSet(this.group, assets, FERRY, 1));

    const cross = stackerCrossings(this.track, this.path, raw.yardTraffic.reachStackers.count);
    this.crossings = cross;
    if (cross.length > 0) {
      this.stackerSet = this.add(new ModelSet(this.group, assets, STACKER, cross.length));
      this.stackerBodies = cross.map(() => this.addMover(STACKER_HALF));
    }

    const n = raw.yardTraffic.trucks;
    const blue = Math.ceil(n / 2);
    const counts = [blue, n - blue];
    [TRUCK_BLUE, TRUCK_RED].forEach((model, mi) => {
      if (counts[mi] === 0) return;
      const set = this.add(new ModelSet(this.group, assets, model, counts[mi]));
      this.truckSets.push(set);
      for (let s = 0; s < counts[mi]; s++) {
        const k = mi === 0 ? s * 2 : s * 2 + 1;
        this.truckSlots.push({ set, slot: s, k, body: this.addMover(TRUCK_HALF) });
      }
    });
    this.place(true);
  }

  private addMover(half: [number, number, number]): RAPIER.RigidBody {
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.kinematicPositionBased());
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(half[0], half[1], half[2]).setTranslation(0, half[1], 0).setFriction(0.2),
      body,
    );
    this.bodies.push(body);
    return body;
  }

  private moveBody(body: RAPIER.RigidBody, x: number, z: number, yaw: number, initial: boolean): void {
    this.kinPos.x = x;
    this.kinPos.y = RACE.track.roadY;
    this.kinPos.z = z;
    this.kinRot.y = Math.sin(yaw / 2);
    this.kinRot.w = Math.cos(yaw / 2);
    if (initial) {
      body.setTranslation(this.kinPos, true);
      body.setRotation(this.kinRot, true);
    }
    body.setNextKinematicTranslation(this.kinPos);
    body.setNextKinematicRotation(this.kinRot);
  }

  private near(x: number, z: number): boolean {
    if (!this.focus) return true;
    const dx = x - this.focus.x;
    const dz = z - this.focus.z;
    return dx * dx + dz * dz < DYNAMIC_DRAW_RADIUS_M * DYNAMIC_DRAW_RADIUS_M;
  }

  /** Tell the quay where the camera is so far dynamic sets skip their draw calls. */
  setFocus(x: number, z: number): void {
    this.focus = this.focus ?? { x, z };
    this.focus.x = x;
    this.focus.z = z;
  }

  private place(initial: boolean): void {
    const t = this.time;
    // Cranes: spreaders slide slowly, each crane on its own phase.
    const w = (Math.PI * 2 * t) / SPREADER_PERIOD_SEC;
    for (let i = 0; i < this.stsSet.count; i++) {
      this.stsSet.slide(i, 9 * Math.sin(w + i * 1.3), 1.5 + 1.5 * Math.sin(w * 1.4 + i));
    }
    for (let i = 0; i < this.rtgSet.count; i++) {
      this.rtgSet.slide(i, 4 * Math.sin(w + i * 2.1), 1 + Math.sin(w * 1.2 + i));
    }
    this.stsSet.commit();
    this.rtgSet.commit();

    const fs = this.ferrySet;
    if (fs) {
      const c = this.ferryCfg;
      ferryPose(t, c.landing[0], c.crossing.to[0], c.crossing.durationSec, 15, this.fp);
      fs.set(0, posQuat(this.m4, this.fp.x, FERRY_Y, c.landing[2], this.fp.yaw));
      fs.commit();
      fs.setVisible(this.near(this.fp.x, c.landing[2]));
    }

    const ss = this.stackerSet;
    if (ss) {
      let any = false;
      this.crossings.forEach((c, i) => {
        stackerPose(c, t, this.sp);
        ss.set(i, posQuat(this.m4, this.sp.x, 0, this.sp.z, this.sp.yaw));
        any = any || this.near(this.sp.x, this.sp.z);
        this.moveBody(this.stackerBodies[i], this.sp.x, this.sp.z, this.sp.yaw, initial);
      });
      ss.commit();
      ss.setVisible(any);
    }

    const nTrucks = this.truckSlots.length;
    for (const set of this.truckSets) set.setVisible(false);
    for (const ts of this.truckSlots) {
      const tt = yardTruckT(ts.k, nTrucks, t, this.path.lengthM);
      const p = this.path.pointAt(tt);
      const tg = this.path.tangentAt(tt);
      const len = Math.hypot(tg.x, tg.z) || 1;
      const tx = tg.x / len;
      const tz = tg.z / len;
      // Oncoming: they drive against the race, on their own right = the racers' left.
      // Hug the left wall: the racers' centre line (and a 3.5 m wide APC) must stay clear.
      const lane = this.raw.roadLayout.yardLanes.widthM / 2 - TRUCK_HALF[0] - 0.35;
      const x = p.x + tz * lane;
      const z = p.z - tx * lane;
      const yaw = Math.atan2(-tx, -tz);
      ts.set.set(ts.slot, posQuat(this.m4, x, 0, z, yaw));
      if (this.near(x, z)) ts.set.setVisible(true);
      this.moveBody(ts.body, x, z, yaw, initial);
    }
    for (const set of this.truckSets) set.commit();
  }

  /** Fixed-step update, after world.step(). */
  update(dt: number): void {
    this.time += dt;
    this.place(false);
  }

  dispose(): void {
    for (const b of this.bodies) this.world.removeRigidBody(b);
    this.bodies.length = 0;
    this.world.removeRigidBody(this.body);
    for (const s of this.sets) s.dispose();
    this.sets.length = 0;
    this.ribbon.geometry.dispose();
    (this.ribbon.material as THREE.Material).dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o !== this.ribbon && !(o instanceof THREE.InstancedMesh)) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m.userData.shared) m.dispose();
        }
      }
    });
    this.group.removeFromParent();
    this.scene.remove(this.group);
  }
}
