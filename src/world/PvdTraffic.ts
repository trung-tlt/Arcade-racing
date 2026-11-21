import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/Assets';
import type { TrackDef } from '../core/Data';
import { userSettings } from '../core/Settings';
import type { TrackPath } from './TrackPath';
import { TRAFFIC_DRAW_RADIUS_M } from '../sim/trafficCommon';
import { PvdTrafficSim, type PvdMover } from '../sim/PvdTrafficSim';
import { KIND_KEYS, MODEL_KEY, type RawPvd } from '../sim/pvdTrafficCommon';

export * from '../sim/pvdTrafficCommon';

type Rapier = typeof RAPIER;

/**
 * Ambient traffic for Map 4, Pham Van Dong Boulevard: poncho-clad scooters in the motorbike lanes, cars and taxis in the
 * car lanes and buses that dwell at the rain shelters. Everything is scenery: scripted kinematic bodies on a clock, in
 * the style of XaLoTraffic. Each vehicle loops inside one *zone* of the lap (never over the Binh Loi bridge, the
 * U-turn flyover or the start grid) and sits in one lateral *band* relative to the racing line:
 *
 *   outbound half (racing on the east car lanes):  car lanes (the racing line) = band 0, east motorbike lanes = band +Δ
 *   return half (racing on the west motorbike lanes): motorbike lanes (the racing line) = band 0, west car lanes = band −Δ
 *
 * where Δ is the distance between the car-lane and motorbike-lane centres, read from `roadLayout`.
 */

const P_PVD = 'models/props_pvd/';
const P_CONGHOA = 'models/props_conghoa/';

/** Every model file this class loads (the same files as `ambientTraffic.models` in pham_van_dong.json). */
export const PVD_TRAFFIC_MODELS: string[] = [
  `${P_PVD}poncho_rider_blue.glb`,
  `${P_PVD}poncho_rider_yellow.glb`,
  `${P_PVD}poncho_rider_pink.glb`,
  `${P_PVD}poncho_rider_clear.glb`,
  `${P_CONGHOA}car_sedan_white.glb`,
  `${P_CONGHOA}car_sedan_silver.glb`,
  `${P_CONGHOA}car_hatch_red.glb`,
  `${P_CONGHOA}car_hatch_blue.glb`,
  `${P_CONGHOA}car_taxi.glb`,
  `${P_CONGHOA}city_bus.glb`,
];

// ---------------------------------------------------------------------------------------------
// Rendering: one merged, vertex-coloured mesh per model (lights marked per vertex), instanced.
// ---------------------------------------------------------------------------------------------

const isGlowMaterial = (m: THREE.MeshStandardMaterial): boolean =>
  (m.emissiveIntensity > 0 && m.emissive.getHex() !== 0) || /^(Light_|Route_Sign|Taxi_Sign)/.test(m.name);

/**
 * Flattens a model into ONE geometry: material colours baked into vertex colours, plus a per-vertex `glow` flag (1 on
 * the lamps and signs) that the shader turns into emission. One mesh per model keeps the draw calls down.
 */
export function bakeVehicle(root: THREE.Object3D): THREE.BufferGeometry | null {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!(mat instanceof THREE.MeshStandardMaterial)) return;
    let g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    const glow = isGlowMaterial(mat);
    const c = glow && mat.emissive.getHex() !== 0 ? mat.emissive : mat.color;
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(glow ? 1 : 0), 1));
    parts.push(g);
  });
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts, false) ?? parts[0];
  for (const g of parts) if (g !== merged) g.dispose();
  return merged;
}

/** Vertex-coloured paint whose lamp vertices (`glow` = 1) also emit their colour, so lights glow in the storm. */
function makeMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 });
  m.name = 'Pvd_Traffic';
  m.onBeforeCompile = (shader): void => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float glow;\nvarying float vGlow;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vGlow;\n#include <common>')
      .replace(
        'vec3 totalEmissiveRadiance = emissive;',
        'vec3 totalEmissiveRadiance = emissive + vColor.rgb * 2.2 * vGlow;',
      );
  };
  m.customProgramCacheKey = (): string => 'pvd-traffic';
  return m;
}

/** Instances of one model: one InstancedMesh. */
class VehicleSet {
  readonly mesh: THREE.InstancedMesh | null;
  /** Scratch flag for distance culling. */
  near = true;
  private readonly geo: THREE.BufferGeometry | null;

  constructor(
    private readonly parent: THREE.Object3D,
    assets: Assets,
    path: string,
    count: number,
    mat: THREE.Material,
  ) {
    this.geo = bakeVehicle(assets.cloneModel(path));
    if (!this.geo) {
      this.mesh = null;
      return;
    }
    const inst = new THREE.InstancedMesh(this.geo, mat, count);
    inst.name = path.split('/').pop() ?? path;
    inst.frustumCulled = false;
    inst.castShadow = false;
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) inst.setMatrixAt(i, zero);
    parent.add(inst);
    this.mesh = inst;
  }

  set(i: number, m: THREE.Matrix4): void {
    this.mesh?.setMatrixAt(i, m);
  }

  setTint(i: number, v: number): void {
    this.mesh?.instanceColor?.setXYZ(i, v, v, v);
  }

  setVisible(on: boolean): void {
    if (this.mesh) this.mesh.visible = on;
  }

  commit(): void {
    if (!this.mesh) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    if (this.mesh) {
      this.parent.remove(this.mesh);
      this.mesh.dispose();
    }
    this.geo?.dispose();
  }
}

interface Mover {
  sim: PvdMover;
  slot: number;
  set: VehicleSet;
}

/** Moving scooters, cars and buses for Pham Van Dong Boulevard: draws what `PvdTrafficSim` simulates. */
export class PvdTraffic {
  readonly group = new THREE.Group();

  private readonly raw: RawPvd;
  private readonly movers: Mover[] = [];
  private readonly sets: VehicleSet[] = [];
  private readonly mat: THREE.MeshStandardMaterial;
  private sim: PvdTrafficSim | null = null;
  private wetMul = 1;
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
    this.raw = track.raw as unknown as RawPvd;
    this.group.name = 'pvd_traffic';
    this.mat = makeMaterial();
    if (userSettings.preset !== 'low') this.build(track);
    scene.add(this.group);
  }

  private build(track: TrackDef): void {
    const cfg = this.raw.ambientTraffic;
    const sim = new PvdTrafficSim(this.R, this.world, track, this.path);
    sim.setWetSpeedMul(this.wetMul);
    this.sim = sim;
    for (const key of KIND_KEYS) {
      const models = cfg.models[MODEL_KEY[key]] ?? [];
      const mine = sim.movers.filter((m) => m.key === key);
      if (models.length === 0 || mine.length === 0) continue;
      const perModel = models.map((m, mi) => ({
        path: m,
        n: mine.filter((s) => s.spec.model === mi).length,
        used: 0,
        set: null as VehicleSet | null,
      }));
      for (const pm of perModel) {
        if (pm.n === 0) continue;
        pm.set = new VehicleSet(this.group, this.assets, pm.path, pm.n, this.mat);
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

  /** Tell the traffic where the camera is so sets with nothing within TRAFFIC_DRAW_RADIUS_M skip their draw call. */
  setFocus(x: number, z: number): void {
    this.focus = this.focus ?? { x, z };
    this.focus.x = x;
    this.focus.z = z;
  }

  /** The storm slows the road: every vehicle's clock runs at `mul` times real speed (1 = dry). */
  setWetSpeedMul(mul: number): void {
    this.wetMul = Math.max(0, mul);
    this.sim?.setWetSpeedMul(mul);
  }

  /** Dev/e2e: along-track t (0..1) of every ambient vehicle of a kind (1 cars, 2 buses, 3 scooters). */
  debugTrafficTs(kind: number): number[] {
    return this.sim?.tsOfKind(kind) ?? [];
  }

  /** Dev/e2e: where every ambient vehicle is right now (x, z, kind, along-track t). */
  debugPositions(): { kind: number; x: number; z: number; t: number }[] {
    return this.sim?.positions() ?? [];
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
    this.mat.dispose();
    this.group.removeFromParent();
    this.scene.remove(this.group);
  }
}
