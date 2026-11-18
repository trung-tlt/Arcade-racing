import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/Assets';
import { RACE, type TrackDef } from '../core/Data';
import { userSettings } from '../core/Settings';
import type { TrackPath } from './TrackPath';

type Rapier = typeof RAPIER;

/**
 * Ambient traffic for Map 3, Hanoi Highway: container trucks, cars and buses on the 4-lane main carriageway and
 * scooters on the 8 m frontage road. Everything is non-racing scenery: kinematic bodies slow a racing car that hits
 * them and never damage anything. Vehicles follow the (3D) racing line, so they ride the bridge, the underpass and the
 * U-turn hump at the road's own height and pitch.
 */

/** Kind indices, in `ambientTraffic` order. `debugTrafficTs(kind)` uses these (cars = 1, buses = 2 as on Map 2). */
export const KIND = { trucks: 0, cars: 1, buses: 2, scooters: 3 } as const;
export type KindKey = keyof typeof KIND;
const KIND_KEYS: readonly KindKey[] = ['trucks', 'cars', 'buses', 'scooters'];

const P_XALO = 'models/props_xalo/';
const P_CONGHOA = 'models/props_conghoa/';

/** Every model file this class loads (the same files as `ambientTraffic.models` in xa_lo_ha_noi.json). */
export const XALO_TRAFFIC_MODELS: string[] = [
  `${P_XALO}container_truck_blue.glb`,
  `${P_XALO}container_truck_red.glb`,
  `${P_CONGHOA}car_sedan_white.glb`,
  `${P_CONGHOA}car_sedan_silver.glb`,
  `${P_CONGHOA}car_hatch_red.glb`,
  `${P_CONGHOA}car_hatch_blue.glb`,
  `${P_CONGHOA}car_taxi.glb`,
  `${P_CONGHOA}city_bus.glb`,
  `${P_CONGHOA}scooter_red.glb`,
  `${P_CONGHOA}scooter_white.glb`,
];

/** Traffic keeps clear of the start grid: from this far before the line to this far after it (as on Map 2). */
export const KEEP_OUT_BEHIND_LINE_M = 130;
export const KEEP_OUT_AHEAD_OF_LINE_M = 30;
/** The bridge crest launches cars (t ≈ 0.03–0.07): nothing is created there at t = 0. */
export const CREST_FROM_T = 0.025;
export const CREST_TO_T = 0.16; // bridge + descent: no slow bus waiting at the foot of the bridge in the opening seconds
/** Where the carriageway narrows to the frontage road the width blends in over this distance (inside the section). */
export const WIDTH_BLEND_M = 25;
/** Ambient vehicles further than this from the player are not drawn (dusk fog already hazes them out). */
export const TRAFFIC_DRAW_RADIUS_M = 300;

// ---------------------------------------------------------------------------------------------
// Pure helpers (no DOM / GL): all the numbers live here so they can be unit tested.
// ---------------------------------------------------------------------------------------------

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

/** Right of a heading (the side traffic drives on): left = (tz, −tx), so right = (−tz, tx). */
export function rightOfHeading(tx: number, tz: number): { x: number; z: number } {
  return { x: -tz, z: tx };
}

/** Anything shaped like TrackPath's sample arrays. */
export interface RoadPath {
  readonly count: number;
  readonly lengthM: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
}

export interface RoadSample {
  x: number;
  /** Road height. */
  y: number;
  z: number;
  /** Unit horizontal heading. */
  tx: number;
  tz: number;
  /** Rise over horizontal run (dy / dxz) along the heading. */
  slope: number;
}

/** Interpolated centre line, height and slope at loop position t ∈ [0,1) without allocating (fills `out`). */
export function sampleRoad(path: RoadPath, t: number, out: RoadSample): RoadSample {
  const n = path.count;
  const f = (((t % 1) + 1) % 1) * n;
  const i = Math.floor(f) % n;
  const j = (i + 1) % n;
  const k = f - Math.floor(f);
  out.x = path.px[i] + (path.px[j] - path.px[i]) * k;
  out.y = path.py[i] + (path.py[j] - path.py[i]) * k;
  out.z = path.pz[i] + (path.pz[j] - path.pz[i]) * k;
  const tx = path.tx[i] + (path.tx[j] - path.tx[i]) * k;
  const tz = path.tz[i] + (path.tz[j] - path.tz[i]) * k;
  const h = Math.hypot(tx, tz) || 1;
  out.tx = tx / h;
  out.tz = tz / h;
  const run = Math.hypot(path.px[j] - path.px[i], path.pz[j] - path.pz[i]) || 1;
  out.slope = (path.py[j] - path.py[i]) / run;
  return out;
}

/** Nose-up pitch (radians) of a vehicle on a road that rises `slope` metres per horizontal metre. */
export function pitchFromSlope(slope: number): number {
  return Math.atan(slope);
}

/** Shape of what the width / lane helpers need from a TrackDef. */
export interface RoadProfile {
  roadWidthM: number;
  lapLengthM: number;
  widthProfile: readonly { fromT: number; toT: number; widthM: number }[];
  /** Lanes across the main carriageway / across the frontage road. */
  mainLanes: number;
  frontageLanes: number;
}

/** Weight 0..1 of the frontage profile at t: 0 on the main carriageway, 1 once `blendM` inside the section. */
export function frontageWeight(profile: RoadProfile, t: number): number {
  for (const p of profile.widthProfile) {
    if (t < p.fromT || t > p.toT) continue;
    const blend = WIDTH_BLEND_M / profile.lapLengthM;
    return Math.min(1, Math.max(0, Math.min(t - p.fromT, p.toT - t) / blend));
  }
  return 0;
}

/** Carriageway width at t (blends from the main width to the frontage width over WIDTH_BLEND_M). */
export function roadWidthAt(profile: RoadProfile, t: number): number {
  const p = profile.widthProfile.find((x) => t >= x.fromT && t <= x.toT);
  if (!p) return profile.roadWidthM;
  const w = frontageWeight(profile, t);
  return profile.roadWidthM + (p.widthM - profile.roadWidthM) * w;
}

/**
 * Lateral offset (metres, + = to the vehicle's right) of the centre of lane `lane` counted from the right edge
 * (0 = rightmost). Uses the actual width and lane count at t, so a car in lane 2 of 4 slides into lane 1 of 2 on the
 * frontage road.
 */
export function laneOffsetAt(profile: RoadProfile, t: number, lane: number): number {
  const w = frontageWeight(profile, t);
  const width = roadWidthAt(profile, t);
  const frontW = profile.widthProfile.find((x) => t >= x.fromT && t <= x.toT)?.widthM ?? profile.roadWidthM;
  const laneW = (profile.roadWidthM / profile.mainLanes) * (1 - w) + (frontW / profile.frontageLanes) * w;
  const laneEff = lane * (1 - w) + Math.min(lane, profile.frontageLanes - 1) * w;
  return width / 2 - laneW * (laneEff + 0.5);
}

export interface TrafficSpec {
  /** Index into KIND_KEYS. */
  kind: number;
  /** Index into that kind's model list. */
  model: number;
  /** Start position: along the whole lap (0..1), or along the frontage section (0..1) for scooters. */
  phase: number;
  speedMps: number;
  /** Lane from the right edge (0 = rightmost). */
  lane: number;
  /** Lateral jitter in metres (+ = further right). */
  jitterM: number;
  /** Per-instance brightness variety. */
  tint: number;
  /** True when the vehicle loops inside the frontage section instead of the whole lap. */
  inSection: boolean;
}

export interface PlanOptions {
  seed: number;
  lapLengthM: number;
  speedKmh: readonly [number, number];
  /** Frontage section bounds (t); scooters loop inside it. */
  section: { fromT: number; toT: number } | null;
}

/** Keep-out zones (t ranges) for whole-lap vehicles at t = 0: the start grid and the bridge crest. */
export function keepOutZones(lapLengthM: number): { from: number; to: number }[] {
  const behind = 1 - KEEP_OUT_BEHIND_LINE_M / lapLengthM;
  const ahead = KEEP_OUT_AHEAD_OF_LINE_M / lapLengthM;
  return [
    { from: behind, to: 1 },
    { from: 0, to: ahead },
    { from: CREST_FROM_T, to: CREST_TO_T },
  ];
}

const inAnyZone = (p: number, zones: readonly { from: number; to: number }[]): boolean =>
  zones.some((z) => p >= z.from && p <= z.to);

/** Which lane a kind prefers (from the right): trucks, buses and scooters in the rightmost lane, cars in lane 1 or 2. */
function laneFor(kind: KindKey, rng: () => number): number {
  return kind === 'cars' ? 1 + Math.floor(rng() * 2) : 0;
}

/**
 * Deterministic plan for one kind. Whole-lap vehicles get evenly spread phases (kept out of the start grid and the
 * crest); scooters get phases inside the frontage section.
 */
export function trafficPlan(kind: KindKey, count: number, models: number, opts: PlanOptions): TrafficSpec[] {
  const ki = KIND[kind];
  const rng = seededRng(opts.seed + ki * 7919);
  const zones = keepOutZones(opts.lapLengthM);
  const inSection = kind === 'scooters' && opts.section !== null;
  const out: TrafficSpec[] = [];
  for (let k = 0; k < count; k++) {
    let phase = (k + rng() * 0.8) / Math.max(1, count);
    if (!inSection) {
      for (let guard = 0; inAnyZone(phase, zones) && guard < 400; guard++) phase = (phase + 0.0137) % 1;
    }
    out.push({
      kind: ki,
      model: models > 0 ? Math.floor(rng() * models) : 0,
      phase,
      speedMps: (opts.speedKmh[0] + rng() * (opts.speedKmh[1] - opts.speedKmh[0])) / 3.6,
      lane: laneFor(kind, rng),
      jitterM: (rng() - 0.5) * 0.6,
      tint: 0.8 + rng() * 0.2,
      inSection,
    });
  }
  return out;
}

/** Loop position (0..1 of the lap) of a traffic participant after `timeSec`. */
export function trafficT(
  spec: TrafficSpec,
  timeSec: number,
  lapLengthM: number,
  section: { fromT: number; toT: number } | null,
): number {
  const dist = spec.speedMps * timeSec;
  if (spec.inSection && section) {
    const span = section.toT - section.fromT;
    // Wrap inside the section: phase and distance are fractions of the section's own length.
    const frac = (spec.phase + dist / (span * lapLengthM)) % 1;
    return section.fromT + frac * span;
  }
  return (spec.phase + dist / lapLengthM) % 1;
}

// ---------------------------------------------------------------------------------------------
// Rendering: one merged, vertex-coloured mesh per model (plus one "glow" mesh for lights), instanced.
// ---------------------------------------------------------------------------------------------

const isGlowMaterial = (m: THREE.MeshStandardMaterial): boolean =>
  (m.emissiveIntensity > 0 && m.emissive.getHex() !== 0) || /^(Light_|Route_Sign|Taxi_Sign)/.test(m.name);

/** Flatten a model's meshes into body / glow geometries with the material colours baked into vertex colours. */
export function bakeModel(root: THREE.Object3D): {
  body: THREE.BufferGeometry | null;
  glow: THREE.BufferGeometry | null;
} {
  root.updateMatrixWorld(true);
  const body: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!(mat instanceof THREE.MeshStandardMaterial)) return;
    let g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    const isGlow = isGlowMaterial(mat);
    const c = isGlow && mat.emissive.getHex() !== 0 ? mat.emissive : mat.color;
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    (isGlow ? glow : body).push(g);
  });
  const merge = (list: THREE.BufferGeometry[]): THREE.BufferGeometry | null => {
    if (list.length === 0) return null;
    const merged = mergeGeometries(list, false) ?? list[0];
    for (const g of list) if (g !== merged) g.dispose();
    return merged;
  };
  return { body: merge(body), glow: merge(glow) };
}

/** Body paint (lit, vertex coloured) and light material (vertex colour is also emitted, so lamps glow at dusk). */
function makeMaterials(): { body: THREE.MeshStandardMaterial; glow: THREE.MeshStandardMaterial } {
  const body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.25 });
  body.name = 'Traffic_Body';
  const glow = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
  glow.name = 'Traffic_Glow';
  glow.onBeforeCompile = (shader): void => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 totalEmissiveRadiance = emissive;',
      'vec3 totalEmissiveRadiance = emissive + vColor.rgb * 2.2;',
    );
  };
  glow.customProgramCacheKey = (): string => 'xalo-traffic-glow';
  return { body, glow };
}

/** Instances of one model: a body InstancedMesh and (if the model has lights) a glow one sharing the same matrices. */
class VehicleSet {
  readonly meshes: THREE.InstancedMesh[] = [];
  /** Scratch flag for distance culling. */
  near = true;
  private readonly geos: THREE.BufferGeometry[] = [];

  constructor(
    private readonly parent: THREE.Object3D,
    assets: Assets,
    path: string,
    count: number,
    mats: { body: THREE.Material; glow: THREE.Material },
  ) {
    const { body, glow } = bakeModel(assets.cloneModel(path));
    for (const [geo, mat] of [
      [body, mats.body],
      [glow, mats.glow],
    ] as const) {
      if (!geo) continue;
      const inst = new THREE.InstancedMesh(geo, mat, count);
      inst.name = `${path.split('/').pop()}:${mat.name}`;
      inst.frustumCulled = false;
      inst.castShadow = false;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < count; i++) inst.setMatrixAt(i, zero);
      parent.add(inst);
      this.meshes.push(inst);
      this.geos.push(geo);
    }
  }

  set(i: number, m: THREE.Matrix4): void {
    for (const mesh of this.meshes) mesh.setMatrixAt(i, m);
  }

  setTint(i: number, v: number): void {
    for (const mesh of this.meshes) mesh.instanceColor?.setXYZ(i, v, v, v);
  }

  setVisible(on: boolean): void {
    for (const mesh of this.meshes) mesh.visible = on;
  }

  commit(): void {
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      this.parent.remove(mesh);
      mesh.dispose();
    }
    for (const g of this.geos) g.dispose();
    this.meshes.length = 0;
    this.geos.length = 0;
  }
}

interface Mover {
  spec: TrafficSpec;
  body: RAPIER.RigidBody;
  slot: number;
  set: VehicleSet;
}

interface RawXaLo {
  roadLayout: {
    mainCarriageway: { widthM: number; lanes: number };
    frontageRoad: { widthM: number; lanes: number };
  };
  sections: { id: string; name: string; fromT: number; toT: number }[];
  ambientTraffic: {
    trucks: number;
    cars: number;
    buses: number;
    scooters: number;
    speedKmh: [number, number];
    models: Record<KindKey, string[]>;
    vehicleSizesM: {
      truck: [number, number, number];
      car: [number, number, number];
      bus: [number, number, number];
      scooter: [number, number, number];
    };
  };
}

/** Section whose lap fraction the frontage scooters loop in (the data's "frontage" section). */
export function frontageSection(raw: Pick<RawXaLo, 'sections'>): { fromT: number; toT: number } | null {
  const s = raw.sections.find((x) => /frontage/i.test(x.name)) ?? raw.sections.find((x) => x.id === 'F');
  return s ? { fromT: s.fromT, toT: s.toT } : null;
}

export function roadProfileOf(track: TrackDef): RoadProfile {
  const raw = track.raw as unknown as RawXaLo;
  return {
    roadWidthM: track.roadWidthM,
    lapLengthM: track.lapLengthM,
    widthProfile: track.widthProfile,
    mainLanes: raw.roadLayout?.mainCarriageway?.lanes ?? 4,
    frontageLanes: raw.roadLayout?.frontageRoad?.lanes ?? 2,
  };
}

const SIZE_KEY: Record<KindKey, 'truck' | 'car' | 'bus' | 'scooter'> = {
  trucks: 'truck',
  cars: 'car',
  buses: 'bus',
  scooters: 'scooter',
};
const PLAN_SEED = 1978;

/** Moving trucks, cars, buses and scooters for Hanoi Highway. */
export class XaLoTraffic {
  readonly group = new THREE.Group();
  /** Traffic kinds that were not spawned because the data lists no model for them. */
  readonly skippedKinds: string[] = [];

  private readonly raw: RawXaLo;
  private readonly profile: RoadProfile;
  private readonly section: { fromT: number; toT: number } | null;
  private readonly movers: Mover[] = [];
  private readonly sets: VehicleSet[] = [];
  private readonly mats: { body: THREE.MeshStandardMaterial; glow: THREE.MeshStandardMaterial };
  private time = 0;
  private focus: { x: number; z: number } | null = null;
  // Reused every step (no per-frame allocation).
  private readonly sample: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, slope: 0 };
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly kinPos = { x: 0, y: 0, z: 0 };
  private readonly kinRot = { x: 0, y: 0, z: 0, w: 1 };

  constructor(
    private readonly scene: THREE.Scene,
    private readonly R: Rapier,
    private readonly world: RAPIER.World,
    private readonly assets: Assets,
    track: TrackDef,
    private readonly path: TrackPath,
  ) {
    this.raw = track.raw as unknown as RawXaLo;
    this.profile = roadProfileOf(track);
    this.section = frontageSection(this.raw);
    this.group.name = 'xalo_traffic';
    this.mats = makeMaterials();
    if (userSettings.preset !== 'low') this.build();
    scene.add(this.group);
  }

  private build(): void {
    const cfg = this.raw.ambientTraffic;
    KIND_KEYS.forEach((key) => {
      const count = cfg[key];
      const models = cfg.models[key] ?? [];
      if (models.length === 0) {
        if (count > 0) this.skippedKinds.push(key);
        return;
      }
      const specs = trafficPlan(key, count, models.length, {
        seed: PLAN_SEED,
        lapLengthM: this.path.lengthM,
        speedKmh: cfg.speedKmh,
        section: this.section,
      });
      const size = cfg.vehicleSizesM[SIZE_KEY[key]];
      const half: [number, number, number] = [size[0] / 2, size[1] / 2, size[2] / 2];
      const perModel = models.map((m, mi) => ({
        path: m,
        n: specs.filter((s) => s.model === mi).length,
        used: 0,
        set: null as VehicleSet | null,
      }));
      for (const pm of perModel) {
        if (pm.n === 0) continue;
        pm.set = new VehicleSet(this.group, this.assets, pm.path, pm.n, this.mats);
        this.sets.push(pm.set);
      }
      for (const spec of specs) {
        const pm = perModel[spec.model];
        const set = pm.set as VehicleSet;
        const slot = pm.used++;
        set.setTint(slot, spec.tint);
        const body = this.world.createRigidBody(this.R.RigidBodyDesc.kinematicPositionBased());
        this.world.createCollider(
          this.R.ColliderDesc.cuboid(half[0], half[1], half[2]).setTranslation(0, half[1], 0).setFriction(0.2),
          body,
        );
        this.movers.push({ spec, body, slot, set });
      }
    });
    this.placeTraffic(true);
  }

  /** Tell the traffic where the camera is so sets with nothing within TRAFFIC_DRAW_RADIUS_M skip their draw calls. */
  setFocus(x: number, z: number): void {
    this.focus = this.focus ?? { x, z };
    this.focus.x = x;
    this.focus.z = z;
  }

  /** Dev/e2e: along-track t (0..1) of every ambient vehicle of a kind (0 trucks, 1 cars, 2 buses, 3 scooters). */
  debugTrafficTs(kind: number): number[] {
    return this.movers
      .filter((m) => m.spec.kind === kind)
      .map((m) => trafficT(m.spec, this.time, this.path.lengthM, this.section));
  }

  /** Move every ambient vehicle to its place for the current clock, riding the road's height and slope. */
  private placeTraffic(initial: boolean): void {
    if (this.movers.length === 0) return;
    const sets = this.sets;
    for (const set of sets) set.near = this.focus === null;
    for (const mv of this.movers) {
      const spec = mv.spec;
      const t = trafficT(spec, this.time, this.path.lengthM, this.section);
      sampleRoad(this.path, t, this.sample);
      const s = this.sample;
      const r = rightOfHeading(s.tx, s.tz);
      const d = laneOffsetAt(this.profile, t, spec.lane) + spec.jitterM;
      const x = s.x + r.x * d;
      const z = s.z + r.z * d;
      const y = s.y + RACE.track.roadY;
      const yaw = Math.atan2(s.tx, s.tz);
      // Nose up on a climb: rotating +Z about +X by −pitch lifts it.
      this.euler.set(-pitchFromSlope(s.slope), yaw, 0, 'YXZ');
      this.q.setFromEuler(this.euler);
      this.m4.compose(this.pos.set(x, y, z), this.q, this.one);
      mv.set.set(mv.slot, this.m4);
      if (this.focus) {
        const dx = x - this.focus.x;
        const dz = z - this.focus.z;
        if (dx * dx + dz * dz < TRAFFIC_DRAW_RADIUS_M * TRAFFIC_DRAW_RADIUS_M) mv.set.near = true;
      }
      this.kinPos.x = x;
      this.kinPos.y = y;
      this.kinPos.z = z;
      this.kinRot.x = this.q.x;
      this.kinRot.y = this.q.y;
      this.kinRot.z = this.q.z;
      this.kinRot.w = this.q.w;
      if (initial) {
        mv.body.setTranslation(this.kinPos, true);
        mv.body.setRotation(this.kinRot, true);
      }
      mv.body.setNextKinematicTranslation(this.kinPos);
      mv.body.setNextKinematicRotation(this.kinRot);
    }
    for (const set of sets) {
      set.setVisible(set.near);
      set.commit();
    }
  }

  /** Fixed-step update, after world.step(). */
  update(dt: number): void {
    this.time += dt;
    this.placeTraffic(false);
  }

  dispose(): void {
    for (const mv of this.movers) this.world.removeRigidBody(mv.body);
    this.movers.length = 0;
    for (const s of this.sets) s.dispose();
    this.sets.length = 0;
    this.mats.body.dispose();
    this.mats.glow.dispose();
    this.group.removeFromParent();
    this.scene.remove(this.group);
  }
}
