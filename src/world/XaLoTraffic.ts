import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/Assets';
import type { TrackDef } from '../core/Data';
import { userSettings } from '../core/Settings';
import type { TrackPath } from './TrackPath';
import { KIND_KEYS, TRAFFIC_DRAW_RADIUS_M, frontageSection, trafficT, type RawXaLo } from '../sim/trafficCommon';

export * from '../sim/trafficCommon';
import { XaLoTrafficSim, type TrafficMover } from '../sim/XaLoTrafficSim';

type Rapier = typeof RAPIER;

/**
 * Ambient traffic for Map 3, Hanoi Highway: container trucks, cars and buses on the 4-lane main carriageway and
 * scooters on the 8 m frontage road. Everything is non-racing scenery: kinematic bodies slow a racing car that hits
 * them and never damage anything. Vehicles follow the (3D) racing line, so they ride the bridge, the underpass and the
 * U-turn hump at the road's own height and pitch.
 */

/** Kind indices, in `ambientTraffic` order. `debugTrafficTs(kind)` uses these (cars = 1, buses = 2 as on Map 2). */

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
  sim: TrafficMover;
  slot: number;
  set: VehicleSet;
}

/** Moving trucks, cars, buses and scooters for Hanoi Highway: draws what `XaLoTrafficSim` simulates. */
export class XaLoTraffic {
  readonly group = new THREE.Group();
  /** Traffic kinds that were not spawned because the data lists no model for them. */
  readonly skippedKinds: string[] = [];

  private readonly raw: RawXaLo;
  private readonly movers: Mover[] = [];
  private readonly sets: VehicleSet[] = [];
  private readonly mats: { body: THREE.MeshStandardMaterial; glow: THREE.MeshStandardMaterial };
  private sim: XaLoTrafficSim | null = null;
  private focus: { x: number; z: number } | null = null;
  // Reused every step (no per-frame allocation).
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly R: Rapier,
    private readonly world: RAPIER.World,
    private readonly assets: Assets,
    track: TrackDef,
    private readonly path: TrackPath,
  ) {
    this.raw = track.raw as unknown as RawXaLo;
    this.group.name = 'xalo_traffic';
    this.mats = makeMaterials();
    if (userSettings.preset !== 'low') this.build(track);
    scene.add(this.group);
  }

  private build(track: TrackDef): void {
    const cfg = this.raw.ambientTraffic;
    const sim = new XaLoTrafficSim(this.R, this.world, track, this.path);
    this.sim = sim;
    this.skippedKinds.push(...sim.skippedKinds);
    for (const key of KIND_KEYS) {
      const mine = sim.movers.filter((m) => m.key === key);
      const models = cfg.models[key] ?? [];
      if (mine.length === 0) continue;
      const perModel = models.map((m, mi) => ({
        path: m,
        n: mine.filter((m2) => m2.spec.model === mi).length,
        used: 0,
        set: null as VehicleSet | null,
      }));
      for (const pm of perModel) {
        if (pm.n === 0) continue;
        pm.set = new VehicleSet(this.group, this.assets, pm.path, pm.n, this.mats);
        this.sets.push(pm.set);
      }
      for (const mv of mine) {
        const pm = perModel[mv.spec.model];
        const set = pm.set as VehicleSet;
        const slot = pm.used++;
        set.setTint(slot, mv.spec.tint);
        this.movers.push({ sim: mv, slot, set });
      }
    }
    this.placeTraffic();
  }

  /** Tell the traffic where the camera is so sets with nothing within TRAFFIC_DRAW_RADIUS_M skip their draw calls. */
  setFocus(x: number, z: number): void {
    this.focus = this.focus ?? { x, z };
    this.focus.x = x;
    this.focus.z = z;
  }

  /** Dev/e2e: along-track t (0..1) of every ambient vehicle of a kind (0 trucks, 1 cars, 2 buses, 3 scooters). */
  debugTrafficTs(kind: number): number[] {
    const sim = this.sim;
    if (!sim) return [];
    const section = frontageSection(this.raw);
    return this.movers
      .filter((m) => m.sim.spec.kind === kind)
      .map((m) => trafficT(m.sim.spec, sim.time, this.path.lengthM, section));
  }

  /** Copy every ambient vehicle's simulated pose into its instance matrix. */
  private placeTraffic(): void {
    if (this.movers.length === 0) return;
    const sets = this.sets;
    for (const set of sets) set.near = this.focus === null;
    for (const mv of this.movers) {
      const p = mv.sim;
      this.q.set(p.qx, p.qy, p.qz, p.qw);
      this.m4.compose(this.pos.set(p.x, p.y, p.z), this.q, this.one);
      mv.set.set(mv.slot, this.m4);
      if (this.focus) {
        const dx = p.x - this.focus.x;
        const dz = p.z - this.focus.z;
        if (dx * dx + dz * dz < TRAFFIC_DRAW_RADIUS_M * TRAFFIC_DRAW_RADIUS_M) mv.set.near = true;
      }
    }
    for (const set of sets) {
      set.setVisible(set.near);
      set.commit();
    }
  }

  /** Fixed-step update, after world.step(). */
  update(dt: number): void {
    if (!this.sim) return;
    this.sim.update(dt);
    this.placeTraffic();
  }

  dispose(): void {
    this.sim?.dispose();
    this.movers.length = 0;
    for (const s of this.sets) s.dispose();
    this.sets.length = 0;
    this.mats.body.dispose();
    this.mats.glow.dispose();
    this.group.removeFromParent();
    this.scene.remove(this.group);
  }
}
