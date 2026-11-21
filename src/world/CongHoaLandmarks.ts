import { drawDistance, windowInstances } from './Windowed';
import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import type { TrackDef } from '../core/Data';
import { userSettings } from '../core/Settings';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import { findOpposites, type CorridorPath } from './Corridor';
import type { TrackPath } from './TrackPath';
import { CongHoaTrafficSim, type CongHoaMover } from '../sim/CongHoaTrafficSim';
import { leftOfHeading, sampleAt, rightOfHeading, type PathSample, type V2 } from '../sim/congHoaTrafficCommon';

export * from '../sim/congHoaTrafficCommon';

type Rapier = typeof RAPIER;

const P = 'models/props_conghoa/';
const OVERPASS = `${P}pedestrian_overpass.glb`;
const PIER = `${P}flyover_pier.glb`;
const LIGHT = `${P}traffic_light.glb`;
const AIRLINER = `${P}airliner.glb`;

/** Model geometry facts read from the GLBs (metres, model space). */
// The pier is a 1.6 m column; its 12 m wide cap is 6.8 m up (overhead), so only the column is solid.
const PIER_HALF_X = 0.8;
const PIER_HALF_Z = 0.8;
const PIER_HEIGHT = 7.8;
/** Overpass supports (stairs / pillars) at the two ends of the 38 m span, x ∈ ±[16, 19], z ∈ [-0.7, 0.3]. */
const OVERPASS_SUPPORT_X = 17.5;
const OVERPASS_SUPPORT_HALF_X = 1.5;
const OVERPASS_SUPPORT_HALF_Z = 0.5;
const OVERPASS_SUPPORT_Z = -0.2;
const OVERPASS_SUPPORT_HEIGHT = 6;
const SLAB_THICKNESS = 0.8;
const PARAPET_HEIGHT = 0.9;
const PARAPET_WIDTH = 0.35;
/** Walls the Track builds just outside the carriageway edge. */
const WALL_THICKNESS = 0.8;
/** Where the flyover deck is cut: below this line height it would lie across the carriageways. */
const MIN_DECK_LINE_Y = 3;

// ---------------------------------------------------------------------------------------------
// Pure helpers (no DOM / rendering): everything numeric lives here so it can be unit tested.
// ---------------------------------------------------------------------------------------------

export interface Placement {
  x: number;
  z: number;
  /** Rotation about +Y (0 faces +Z); a model whose span runs along X gets its span across the road. */
  yaw: number;
}

/** Median point of the road at along-track t: midway between this carriageway and the opposite one. */
export function overpassPlacement(
  path: CorridorPath,
  opp: Int32Array,
  t: number,
): Placement & { gapM: number; i: number; j: number } {
  const n = path.count;
  const i0 = Math.round((((t % 1) + 1) % 1) * n) % n;
  let i = i0;
  let j = opp[i];
  for (let d = 1; j < 0 && d <= 12; d++) {
    for (const c of [(i0 + d) % n, (i0 - d + n) % n]) {
      if (opp[c] >= 0) {
        i = c;
        j = opp[c];
        break;
      }
    }
  }
  if (j < 0) throw new Error(`no opposite carriageway near t=${t}`);
  return {
    x: (path.px[i] + path.px[j]) / 2,
    z: (path.pz[i] + path.pz[j]) / 2,
    yaw: Math.atan2(path.tx[i], path.tz[i]),
    gapM: Math.hypot(path.px[j] - path.px[i], path.pz[j] - path.pz[i]),
    i,
    j,
  };
}

/** Local → world for a point (lx, lz) of a model placed at (x, z) with `yaw` about +Y. */
export function toWorld(p: Placement, lx: number, lz: number): V2 {
  const s = Math.sin(p.yaw);
  const c = Math.cos(p.yaw);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}

/** Distance from point (px,pz) to an oriented box (centre, yaw, half extents); 0 when inside. */
export function obbDistance(
  px: number,
  pz: number,
  cx: number,
  cz: number,
  yaw: number,
  hx: number,
  hz: number,
): number {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const dx = px - cx;
  const dz = pz - cz;
  const lx = dx * c - dz * s; // world → local (inverse of toWorld)
  const lz = dx * s + dz * c;
  const ox = Math.max(Math.abs(lx) - hx, 0);
  const oz = Math.max(Math.abs(lz) - hz, 0);
  return Math.hypot(ox, oz);
}

/** Smallest distance from an oriented box to any sample of the racing line. */
export function boxToRoadDistance(
  path: CorridorPath,
  cx: number,
  cz: number,
  yaw: number,
  hx: number,
  hz: number,
): number {
  let best = Infinity;
  for (let i = 0; i < path.count; i++) {
    const d = obbDistance(path.px[i], path.pz[i], cx, cz, yaw, hx, hz);
    if (d < best) best = d;
  }
  return best;
}

// --- flyover -----------------------------------------------------------------------------------

export type Pt3 = readonly [number, number, number];

export interface Station {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  /** Arc length from the start of the polyline (horizontal + vertical). */
  s: number;
}

export function polylineLength(points: readonly Pt3[]): number {
  let L = 0;
  for (let i = 1; i < points.length; i++) {
    L += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
  }
  return L;
}

/** Point and horizontal heading on a 3D polyline at arc length s (clamped to the ends). */
export function polylineAt(points: readonly Pt3[], s: number): Station {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (s <= acc + len || i === points.length - 1) {
      const k = len === 0 ? 0 : Math.min(1, Math.max(0, (s - acc) / len));
      const h = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
      return {
        x: a[0] + (b[0] - a[0]) * k,
        y: a[1] + (b[1] - a[1]) * k,
        z: a[2] + (b[2] - a[2]) * k,
        tx: (b[0] - a[0]) / h,
        tz: (b[2] - a[2]) / h,
        s: acc + len * k,
      };
    }
    acc += len;
  }
  const last = points[points.length - 1];
  return { x: last[0], y: last[1], z: last[2], tx: 0, tz: 1, s: acc };
}

/** Stations every `stepM` along the polyline, cut where the line drops below `minY` (deck would lie on the road). */
export function flyoverStations(points: readonly Pt3[], stepM: number, minY: number): Station[] {
  const L = polylineLength(points);
  const out: Station[] = [];
  for (let s = 0; s <= L + 1e-6; s += stepM) {
    const st = polylineAt(points, Math.min(s, L));
    if (st.y < minY) break;
    out.push(st);
  }
  return out;
}

/** Pier height for a deck line at height `lineY`: the model's full height at the flat elevation, scaled down on the ramp. */
export function pierHeightFor(lineY: number, elevationM: number, modelHeight: number): number {
  return lineY <= 0 ? 0 : modelHeight * Math.min(1, lineY / elevationM);
}

export interface PierSite extends Placement {
  /** Line height (deck elevation) at this pier. */
  lineY: number;
  height: number;
}

/** Piers every `spacingM` along the flyover (skipping the cut-off ramp end). */
export function flyoverPierSites(points: readonly Pt3[], spacingM: number, elevationM: number): PierSite[] {
  const L = polylineLength(points);
  const sites: PierSite[] = [];
  for (let s = 0; s <= L + 1e-6; s += spacingM) {
    const st = polylineAt(points, Math.min(s, L));
    if (st.y < MIN_DECK_LINE_Y) break;
    sites.push({
      x: st.x,
      z: st.z,
      yaw: Math.atan2(st.tx, st.tz),
      lineY: st.y,
      height: pierHeightFor(st.y, elevationM, PIER_HEIGHT),
    });
  }
  return sites;
}

// --- airliner flybys ---------------------------------------------------------------------------

export interface FlightPlan {
  start: readonly [number, number, number];
  end: readonly [number, number, number];
  flightSec: number;
  intervalSec: number;
  /** Time of the first flyby after the race starts. */
  firstAtSec: number;
  bankRad: number;
}

export interface AirlinerPose {
  visible: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  bank: number;
}

/** East→west pass across the airport stretch at along-track `t` (section A), descending ~120 → ~80 m. */
export function flightPlanFor(path: CorridorPath, t: number, intervalSec: number): FlightPlan {
  const p: PathSample = { x: 0, z: 0, tx: 0, tz: 0 };
  sampleAt(path, t, p);
  return {
    start: [p.x + 230, 120, p.z + 25],
    end: [p.x - 230, 80, p.z - 25],
    flightSec: 7,
    intervalSec,
    firstAtSec: 4,
    bankRad: 0.12,
  };
}

/** Where the airliner is `timeSec` after the race clock started (pure; fills `out`). */
export function airlinerPose(timeSec: number, plan: FlightPlan, out: AirlinerPose): AirlinerPose {
  const since = timeSec - plan.firstAtSec;
  out.visible = false;
  if (since < 0) return out;
  const phase = since % plan.intervalSec;
  if (phase > plan.flightSec) return out;
  const u = phase / plan.flightSec;
  const [sx, sy, sz] = plan.start;
  const [ex, ey, ez] = plan.end;
  out.visible = true;
  out.x = sx + (ex - sx) * u;
  out.y = sy + (ey - sy) * u;
  out.z = sz + (ez - sz) * u;
  const dx = ex - sx;
  const dz = ez - sz;
  out.yaw = Math.atan2(dx, dz);
  out.pitch = Math.atan2(sy - ey, Math.hypot(dx, dz)); // nose down while descending
  out.bank = plan.bankRad * Math.sin(u * Math.PI * 2);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scene objects
// ---------------------------------------------------------------------------------------------

interface RawLandmarks {
  roadLayout: { lanesPerDirection: number };
  overpasses: { t: number }[];
  trafficLights: { t: number }[];
  flyover: { deckElevationM: number; deckWidthM: number; points: Pt3[]; pierSpacingM: number };
  ambientTraffic: {
    scooters: number;
    cars: number;
    buses: number;
    speedKmh: [number, number];
    models: { scooters: string[]; cars: string[]; buses: string[] };
    /** Full box size (x, y, z) per vehicle kind; the collider is half of it. */
    vehicleSizesM: { scooter: [number, number, number]; car: [number, number, number]; bus: [number, number, number] };
  };
  sections: { id: string; fromT: number; toT: number }[];
  dressing: { airliners: { intervalSec: number } };
}

/** An InstancedMesh per sub-mesh of one GLB (optionally with materials merged and per-instance colours). */
class PropInstances {
  readonly meshes: THREE.InstancedMesh[] = [];
  /** Scratch flag for distance culling of moving sets. */
  near = true;
  private readonly locals: THREE.Matrix4[] = [];
  private readonly tmp = new THREE.Matrix4();

  constructor(
    private readonly parent: THREE.Object3D,
    assets: Assets,
    path: string,
    count: number,
    opts: { merge: boolean; colors?: boolean; castShadow?: boolean },
  ) {
    const root = assets.cloneModel(path);
    if (opts.merge) mergePropMaterials(root);
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const inst = new THREE.InstancedMesh(o.geometry, o.material, count);
      inst.name = o.name;
      inst.frustumCulled = false;
      inst.castShadow = opts.castShadow ?? false;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (opts.colors) {
        inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
      }
      for (let i = 0; i < count; i++) inst.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
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

  setTint(i: number, v: number): void {
    for (const m of this.meshes) {
      if (m.instanceColor) m.instanceColor.setXYZ(i, v, v, v);
    }
  }

  setVisible(on: boolean): void {
    for (const m of this.meshes) m.visible = on;
  }

  commit(): void {
    for (const m of this.meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
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

interface Mover {
  sim: CongHoaMover;
  /** Index inside its kind's PropInstances. */
  slot: number;
  set: PropInstances;
}

const up = new THREE.Vector3(0, 1, 0);
/** Draw ranges (m) for static landmarks: big structures read from far, traffic lights are specks past ~300 m. */
const LARGE_LANDMARK_M = 600;
const SMALL_LANDMARK_M = 300;
/** Ambient vehicles further than this from the player are not drawn (day fog already hazes them out). */
const TRAFFIC_DRAW_RADIUS_M = 300;

/** Overpasses, the roundabout flyover, traffic lights, airliner flybys and ambient scooters of Cong Hoa Boulevard. */
export class CongHoaLandmarks {
  readonly group = new THREE.Group();
  /** Traffic kinds that were not spawned because the pack has no model for them. */
  readonly skippedKinds: string[] = [];
  /** Piers (indices) whose box lies within the road corridor, for diagnostics. */
  readonly pierReport: { index: number; distToRoadM: number }[] = [];

  private readonly raw: RawLandmarks;
  private readonly body: RAPIER.RigidBody;
  private readonly sets: PropInstances[] = [];
  private deck: THREE.Mesh | null = null;
  private airliner: THREE.Object3D | null = null;
  private readonly plan: FlightPlan;
  private readonly pose: AirlinerPose = { visible: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, bank: 0 };
  private readonly movers: Mover[] = [];
  private time = 0;
  private readonly sample: PathSample = { x: 0, z: 0, tx: 0, tz: 1 };
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private moverSets: PropInstances[] = [];
  /** Where the player is; traffic sets with nothing within TRAFFIC_DRAW_RADIUS_M are not drawn. */
  private focus: { x: number; z: number } | null = null;
  private sim: CongHoaTrafficSim | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly R: Rapier,
    private readonly world: RAPIER.World,
    private readonly assets: Assets,
    private readonly track: TrackDef,
    private readonly path: TrackPath,
  ) {
    this.raw = track.raw as unknown as RawLandmarks;
    this.group.name = 'conghoa_landmarks';
    this.body = world.createRigidBody(R.RigidBodyDesc.fixed());
    const opp = findOpposites(path);

    this.buildOverpasses(opp);
    this.buildFlyover();
    this.buildTrafficLights();
    this.airliner = this.buildAirliner();
    const a = this.raw.sections.find((s) => s.id === 'A');
    this.plan = flightPlanFor(path, a ? (a.fromT + a.toT) / 2 : 0.07, this.raw.dressing.airliners.intervalSec);
    if (userSettings.preset !== 'low') this.buildTraffic();
    scene.add(this.group);
  }

  private compose(x: number, y: number, z: number, yaw: number, sy = 1): THREE.Matrix4 {
    this.q.setFromAxisAngle(up, yaw);
    return this.m4.compose(this.v.set(x, y, z), this.q, this.scale.set(1, sy, 1));
  }

  private halfRoad(): number {
    return this.track.roadWidthM / 2;
  }

  private addBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw: number): void {
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(cx, cy, cz)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setFriction(0.3),
      this.body,
    );
  }

  private buildOverpasses(opp: Int32Array): void {
    const list = this.raw.overpasses;
    const set = new PropInstances(this.group, this.assets, OVERPASS, list.length, { merge: false });
    this.sets.push(set);
    list.forEach((o, k) => {
      const pl = overpassPlacement(this.path, opp, o.t);
      set.set(k, this.compose(pl.x, 0, pl.z, pl.yaw).clone());
      // Supports sit at x = ±17.5 from the median: only solid when clear of the road AND its walls.
      for (const side of [-1, 1]) {
        const w = toWorld(pl, side * OVERPASS_SUPPORT_X, OVERPASS_SUPPORT_Z);
        const dist = boxToRoadDistance(this.path, w.x, w.z, pl.yaw, OVERPASS_SUPPORT_HALF_X, OVERPASS_SUPPORT_HALF_Z);
        if (dist >= this.halfRoad() + WALL_THICKNESS) {
          this.addBox(
            w.x,
            OVERPASS_SUPPORT_HEIGHT / 2,
            w.z,
            OVERPASS_SUPPORT_HALF_X,
            OVERPASS_SUPPORT_HEIGHT / 2,
            OVERPASS_SUPPORT_HALF_Z,
            pl.yaw,
          );
        }
      }
    });
    set.commit();
    windowInstances(set.meshes, Math.min(drawDistance(this.track.daylight, 40), LARGE_LANDMARK_M)); // 38 m span
  }

  private buildFlyover(): void {
    const f = this.raw.flyover;
    const sites = flyoverPierSites(f.points, f.pierSpacingM, f.deckElevationM);
    const piers = new PropInstances(this.group, this.assets, PIER, sites.length, { merge: false });
    this.sets.push(piers);
    const roadReach = this.halfRoad() + 8;
    sites.forEach((s, i) => {
      const sy = s.height / PIER_HEIGHT;
      piers.set(i, this.compose(s.x, 0, s.z, s.yaw, sy).clone());
      const dist = boxToRoadDistance(this.path, s.x, s.z, s.yaw, PIER_HALF_X, PIER_HALF_Z);
      if (dist < roadReach) {
        this.pierReport.push({ index: i, distToRoadM: dist });
        this.addBox(s.x, s.height / 2, s.z, PIER_HALF_X, s.height / 2, PIER_HALF_Z, s.yaw);
      }
    });
    piers.commit();
    windowInstances(piers.meshes, Math.min(drawDistance(this.track.daylight, 20), LARGE_LANDMARK_M));
    this.deck = this.buildDeck(f);
    this.group.add(this.deck);
  }

  /** One flat-shaded mesh: slab + two darker parapets, extruded along the flyover line. */
  private buildDeck(f: RawLandmarks['flyover']): THREE.Mesh {
    const stations = flyoverStations(f.points, 4, MIN_DECK_LINE_Y);
    const half = f.deckWidthM / 2;
    const slab = new THREE.Color('#9C9A93');
    const rail = new THREE.Color('#7E7C75');
    // Each ring is a closed loop of (lateral, height-above-underside) corners.
    const rings: { pts: [number, number][]; color: THREE.Color }[] = [
      {
        pts: [
          [-half, 0],
          [-half, SLAB_THICKNESS],
          [half, SLAB_THICKNESS],
          [half, 0],
        ],
        color: slab,
      },
      ...[-1, 1].map((sgn) => ({
        pts: [
          [sgn * half, SLAB_THICKNESS],
          [sgn * half, SLAB_THICKNESS + PARAPET_HEIGHT],
          [sgn * (half - PARAPET_WIDTH), SLAB_THICKNESS + PARAPET_HEIGHT],
          [sgn * (half - PARAPET_WIDTH), SLAB_THICKNESS],
        ] as [number, number][],
        color: rail,
      })),
    ];
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (const ring of rings) {
      const base = positions.length / 3;
      for (const st of stations) {
        const under = pierHeightFor(st.y, f.deckElevationM, PIER_HEIGHT);
        const l = leftOfHeading(st.tx, st.tz);
        for (const [d, h] of ring.pts) {
          positions.push(st.x + l.x * d, under + h, st.z + l.z * d);
          colors.push(ring.color.r, ring.color.g, ring.color.b);
        }
      }
      for (let i = 0; i < stations.length - 1; i++) {
        const a = base + i * 4;
        const b = base + (i + 1) * 4;
        for (let r = 0; r < 4; r++) {
          const r2 = (r + 1) % 4;
          indices.push(a + r, b + r, b + r2, a + r, b + r2, a + r2);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, side: THREE.DoubleSide }),
    );
    mesh.name = 'flyover_deck';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildTrafficLights(): void {
    const list = this.raw.trafficLights;
    const set = new PropInstances(this.group, this.assets, LIGHT, list.length, { merge: false });
    this.sets.push(set);
    const edge = this.halfRoad() + 1.2; // on the right-hand sidewalk
    list.forEach((l, i) => {
      sampleAt(this.path, l.t, this.sample);
      const r = rightOfHeading(this.sample.tx, this.sample.tz);
      // Local +Z (lamp face) points back at oncoming racers; local −X (the arm) points to the left, over the road.
      const yaw = Math.atan2(-this.sample.tx, -this.sample.tz);
      set.set(i, this.compose(this.sample.x + r.x * edge, 0, this.sample.z + r.z * edge, yaw).clone());
    });
    set.commit();
    windowInstances(set.meshes, Math.min(drawDistance(this.track.daylight, 10), SMALL_LANDMARK_M)); // after commit: instance data is final
    for (const m of set.meshes) {
      const mat = m.material;
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      const lit = m.name === 'lamp_green' ? 3 : m.name === 'lamp_red' || m.name === 'lamp_amber' ? 0.12 : -1;
      if (lit < 0) continue;
      if (mat.emissive.getHex() === 0) mat.emissive.copy(mat.color);
      mat.emissiveIntensity = lit;
    }
  }

  private buildAirliner(): THREE.Object3D {
    const root = this.assets.cloneModel(AIRLINER);
    mergePropMaterials(root);
    root.visible = false;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.frustumCulled = false;
    });
    this.group.add(root);
    return root;
  }

  private buildTraffic(): void {
    const cfg = this.raw.ambientTraffic;
    const sim = new CongHoaTrafficSim(this.R, this.world, this.track, this.path);
    this.sim = sim;
    this.skippedKinds.push(...sim.skippedKinds);
    const kinds: { key: string; models: readonly string[] }[] = [
      { key: 'scooters', models: cfg.models.scooters },
      { key: 'cars', models: cfg.models.cars },
      { key: 'buses', models: cfg.models.buses },
    ];
    kinds.forEach((kind) => {
      const mine = sim.movers.filter((m) => m.kindKey === kind.key);
      if (kind.models.length === 0 || mine.length === 0) return;
      const perModel = kind.models.map((m) => {
        const n = mine.filter((s) => s.spec.model === kind.models.indexOf(m)).length;
        return { path: m, n, used: 0, set: null as PropInstances | null };
      });
      for (const pm of perModel) {
        if (pm.n === 0) continue;
        pm.set = new PropInstances(this.group, this.assets, pm.path, pm.n, { merge: true, colors: true });
        this.sets.push(pm.set);
      }
      for (const mv of mine) {
        const pm = perModel[mv.spec.model];
        const set = pm.set as PropInstances;
        const slot = pm.used++;
        set.setTint(slot, mv.spec.tint);
        this.movers.push({ sim: mv, slot, set });
      }
    });
    this.moverSets = [...new Set(this.movers.map((m) => m.set))];
    this.placeTraffic();
  }

  /** Dev/e2e: along-track t (0..1) of every ambient vehicle of a kind (0 scooters, 1 cars, 2 buses). */
  debugTrafficTs(kind: number): number[] {
    return this.sim?.tsOfKind(kind) ?? [];
  }

  /** Tell the traffic where the camera is so far-away sets skip their draw calls. */
  setFocus(x: number, z: number): void {
    this.focus = this.focus ?? { x, z };
    this.focus.x = x;
    this.focus.z = z;
  }

  /** Copy every ambient vehicle's simulated pose into its instance matrix. */
  private placeTraffic(): void {
    if (this.movers.length === 0) return;
    for (const set of this.moverSets) set.near = this.focus === null;
    for (const mv of this.movers) {
      const p = mv.sim;
      mv.set.set(mv.slot, this.compose(p.x, 0, p.z, p.yaw));
      if (this.focus) {
        const dx = p.x - this.focus.x;
        const dz = p.z - this.focus.z;
        if (dx * dx + dz * dz < TRAFFIC_DRAW_RADIUS_M * TRAFFIC_DRAW_RADIUS_M) mv.set.near = true;
      }
    }
    for (const set of this.moverSets) {
      set.setVisible(set.near);
      set.commit();
    }
  }

  /** Fixed-step update after world.step(): airliner flybys and ambient traffic. */
  update(dt: number): void {
    this.time += dt;
    const a = this.airliner;
    if (a) {
      airlinerPose(this.time, this.plan, this.pose);
      a.visible = this.pose.visible;
      if (this.pose.visible) {
        a.position.set(this.pose.x, this.pose.y, this.pose.z);
        a.rotation.set(this.pose.pitch, this.pose.yaw, this.pose.bank, 'YXZ');
      }
    }
    this.sim?.update(dt);
    this.placeTraffic();
  }

  dispose(): void {
    for (const s of this.sets) s.dispose();
    this.sets.length = 0;
    if (this.deck) {
      this.deck.geometry.dispose();
      (this.deck.material as THREE.Material).dispose();
      this.group.remove(this.deck);
    }
    if (this.airliner) {
      this.airliner.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (!m.userData.shared) m.dispose();
      });
      this.group.remove(this.airliner);
    }
    this.sim?.dispose();
    this.movers.length = 0;
    this.world.removeRigidBody(this.body);
    this.scene.remove(this.group);
  }
}
