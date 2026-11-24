import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { RACE, type TrackDef } from '../core/Data';
import { InstancedModel } from './InstancedModel';
import { DistanceCull, drawDistance, windowInstances } from './Windowed';
import type { TrackPath } from './TrackPath';
import { buildTrackColliders, computeTrackShape, trackEdge, type TrackShape } from '../sim/TrackColliders';

type Rapier = typeof RAPIER;

const BARRIER = 'models/props/barrier_jersey.glb';
const GATE = 'models/props/checkpoint_gate.glb';
const GANTRY = 'models/props/start_gantry.glb';

const RAMP = 'models/props/jump_ramp.glb';
export const TRACK_MODELS = [BARRIER, GATE, GANTRY, RAMP];
/** Road textures of every map (the track picks its own via TrackDef.roadTexture). */
export const TRACK_TEXTURES = ['textures/road_lanes.png'];

const up = new THREE.Vector3(0, 1, 0);
/** Depth of the safety sheet under the driving surface of an elevated road. */
/** The start gantry and jump ramp are only worth their 9 / 3 draw calls when you can make out their detail. */
const LANDMARK_DRAW_M = 300;

/** Road ribbon, barriers (instanced), physics walls, checkpoint gates and the start gantry. */
export class Track {
  readonly group = new THREE.Group();
  private readonly lamps: THREE.MeshStandardMaterial[] = [];
  /** The road surface materials (one per texture run), so a wet map's weather can give them a reflection map. */
  readonly roadMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly body: RAPIER.RigidBody;
  private gates: InstancedModel | null = null;
  /** Wall handles (see `buildTrackColliders`). */
  readonly wallHandles: Set<number>;
  private readonly shape: TrackShape;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly R: Rapier,
    private readonly world: RAPIER.World,
    assets: Assets,
    readonly def: TrackDef,
    readonly path: TrackPath,
  ) {
    this.group.name = 'track';
    this.shape = computeTrackShape(def, path);
    this.group.add(this.buildRoad(assets));
    if (def.timeOfDay === 'night') this.buildBarriers(assets);
    else if (!this.shape.circuit) this.group.add(this.buildKerbs());
    const colliders = buildTrackColliders(R, world, def, path, this.shape);
    this.body = colliders.body;
    this.wallHandles = colliders.wallHandles;
    if (!this.shape.circuit) this.buildGates(assets);
    this.buildRamps(assets);
    scene.add(this.group);
  }

  /** Half width on one side (+1 left, -1 right) at sample `i`, shortened inside a very tight bend. */
  private edge(i: number, side: number): number {
    return trackEdge(this.shape, i, side);
  }

  /** Left-pointing unit vector (+X is left for a car facing +Z). */
  private left(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.path.tz[i], 0, -this.path.tx[i]);
  }

  private buildRoad(assets: Assets): THREE.Group {
    const { path, def } = this;
    const n = path.count;
    const out = new THREE.Group();
    out.name = 'road';
    // The main carriageway and any narrower stretch (frontage road) use different textures: one ribbon per run.
    const cuts = [0, ...def.widthProfile.flatMap((p) => [p.fromT, p.toT]), 1];
    const textures = [def.roadTexture, ...def.widthProfile.flatMap((p) => [p.texture, def.roadTexture])];
    const worldTiles = [0, ...def.widthProfile.flatMap((p) => [p.worldTileM ?? 0, 0])];
    for (let r = 0; r + 1 < cuts.length; r++) {
      const i0 = Math.floor(cuts[r] * n);
      const i1 = r + 2 === cuts.length ? n : Math.floor(cuts[r + 1] * n);
      if (i1 <= i0) continue;
      out.add(this.ribbon(assets, textures[r], i0, i1, worldTiles[r]));
    }
    return out;
  }

  /** Road surface for samples [i0, i1] (inclusive end, wrapping), following the spline height. */
  private ribbon(assets: Assets, texture: string, i0: number, i1: number, worldTileM = 0): THREE.Mesh {
    const { path, def } = this;
    const n = path.count;
    const tex = assets.texture(texture);
    tex.wrapS = worldTileM ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;

    const rows = i1 - i0 + 1;
    const pos = new Float32Array(rows * 2 * 3);
    const uv = new Float32Array(rows * 2 * 2);
    const l = new THREE.Vector3();
    for (let r = 0; r < rows; r++) {
      const k = (i0 + r) % n;
      this.left(k, l);
      const v = ((i0 + r) * path.spacingM) / def.roadTextureRepeatM;
      for (let side = 0; side < 2; side++) {
        const s = side === 0 ? 1 : -1; // vertex 0 = left edge, 1 = right edge
        const o = (r * 2 + side) * 3;
        pos[o] = path.px[k] + l.x * this.edge(k, s) * s;
        pos[o + 1] = path.py[k] + RACE.track.roadY;
        pos[o + 2] = path.pz[k] + l.z * this.edge(k, s) * s;
        // Concrete aprons are tiled in world space so the slabs line up with the ground around them.
        uv[(r * 2 + side) * 2] = worldTileM ? pos[o] / worldTileM : side === 0 ? 0 : 1;
        uv[(r * 2 + side) * 2 + 1] = worldTileM ? pos[o + 2] / worldTileM : v;
      }
    }
    const idx: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      const a = r * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // Wet maps (`lighting.road`): low roughness so lamps and car lights streak on the tarmac.
    const wet = def.daylight?.road;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: wet?.roughness ?? 0.9,
      metalness: wet?.metalness ?? 0,
    });
    this.roadMaterials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * Day maps: no jersey barriers. A low concrete kerb + sidewalk strip runs along both edges (one mesh, flat-shaded);
   * collisions still come from the invisible walls in buildWalls().
   */
  private buildKerbs(): THREE.Mesh {
    const { path } = this;
    const n = path.count;
    const widths = [0.35, 4]; // kerb stone, then sidewalk
    const heights = [0.22, 0.15];
    const colors = ['#8F8B82', '#BDB8AC'].map((c) => new THREE.Color(c));
    const positions: number[] = [];
    const colorsOut: number[] = [];
    const indices: number[] = [];
    const l = new THREE.Vector3();
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      widths.forEach((w, band) => {
        const h = heights[band];
        const base = positions.length / 3;
        for (let i = 0; i < n; i++) {
          this.left(i, l);
          const inner = this.edge(i, sgn) + (band === 0 ? 0 : widths[0]);
          const outer = inner + w;
          const y0 = path.py[i];
          const ring: [number, number][] = [
            [inner, RACE.track.roadY],
            [inner, h],
            [outer, h],
            [outer, RACE.track.roadY],
          ];
          for (const [d, y] of ring) {
            positions.push(path.px[i] + l.x * d * sgn, y0 + y, path.pz[i] + l.z * d * sgn);
            colorsOut.push(colors[band].r, colors[band].g, colors[band].b);
          }
        }
        for (let i = 0; i < n; i++) {
          // Map 1 lines only the public road with a kerb and sidewalk, not the port.
          if (!this.hasSidewalk(i) || !this.hasSidewalk((i + 1) % n)) continue;
          const a = base + i * 4;
          const b = base + ((i + 1) % n) * 4;
          for (let r = 0; r < 4; r++) {
            const r2 = (r + 1) % 4;
            indices.push(a + r, b + r, b + r2, a + r, b + r2, a + r2);
          }
        }
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colorsOut, 3));
    geo.setIndex(indices);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, side: THREE.DoubleSide }),
    );
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.name = 'kerbs';
    return mesh;
  }

  /** Whether sample `i` has a kerb and sidewalk beside it (every sample unless the map lists its sidewalk stretches). */
  private hasSidewalk(i: number): boolean {
    const ranges = this.def.sidewalkT;
    if (!ranges) return true;
    const t = i / this.path.count;
    return ranges.some(([from, to]) => t >= from && t <= to);
  }

  private buildBarriers(assets: Assets): void {
    const { path } = this;
    const proto = assets.cloneModel(BARRIER);
    proto.updateMatrixWorld(true);
    const perSide = Math.ceil(path.lengthM / RACE.track.barrierSpacingM);

    const mats: THREE.Matrix4[] = [];
    const l = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    for (let side = 0; side < 2; side++) {
      for (let j = 0; j < perSide; j++) {
        const t = j / perSide;
        const i = Math.min(path.count - 1, Math.floor(t * path.count));
        this.left(i, l);
        const s = side === 0 ? 1 : -1;
        const offset = this.edge(i, s) + RACE.track.barrierOffsetM;
        p.set(path.px[i] + l.x * offset * s, path.py[i], path.pz[i] + l.z * offset * s);
        q.setFromAxisAngle(up, Math.atan2(path.tx[i], path.tz[i]));
        mats.push(new THREE.Matrix4().compose(p, q, one));
      }
    }

    const total = mats.length;
    const local = new THREE.Matrix4();
    const m = new THREE.Matrix4();
    const barrierMeshes: THREE.InstancedMesh[] = [];
    proto.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      local.copy(o.matrixWorld);
      const inst = new THREE.InstancedMesh(o.geometry, o.material, total);
      for (let k = 0; k < total; k++) inst.setMatrixAt(k, m.multiplyMatrices(mats[k], local));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      this.group.add(inst);
      barrierMeshes.push(inst);
    });
    // 1578 barriers over the whole lap: draw (and shadow) only those the fog hasn't hidden.
    windowInstances(barrierMeshes, drawDistance(this.def.daylight, 12));
  }

  private buildGates(assets: Assets): void {
    const { path, def } = this;
    const place = (obj: THREE.Object3D, t: number): void => {
      const p = path.pointAt(t);
      const tg = path.tangentAt(t);
      obj.position.set(p.x, p.y, p.z);
      obj.rotation.y = Math.atan2(tg.x, tg.z);
      this.group.add(obj);
    };
    // All checkpoint gates share one instanced model: 8 gates cost the draw calls of one.
    const gates = new InstancedModel(this.group, assets, GATE, def.checkpoints.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    def.checkpoints.forEach((cp, i) => {
      const p = path.pointAt(cp.t);
      const tg = path.tangentAt(cp.t);
      pos.set(p.x, p.y, p.z);
      q.setFromAxisAngle(up, Math.atan2(tg.x, tg.z));
      gates.set(i, m.compose(pos, q, one));
    });
    gates.commit();
    gates.window(drawDistance(this.def.daylight, 30)); // 24 m span
    this.gates = gates;
    const gantry = assets.cloneModel(GANTRY);
    gantry.name = 'start_gantry';
    place(gantry, 0);
    // 9 draw calls: only while the start line is within the fog's reach.
    const gantryCull = new DistanceCull(
      gantry.position.clone(),
      Math.min(drawDistance(this.def.daylight), LANDMARK_DRAW_M),
      16,
    );
    this.group.add(gantryCull);
    gantryCull.add(gantry);
    for (let k = 1; k <= 5; k++) {
      const lamp = gantry.getObjectByName(`lamp_${k}`);
      if (lamp instanceof THREE.Mesh && lamp.material instanceof THREE.MeshStandardMaterial) {
        this.lamps.push(lamp.material);
      }
    }
  }

  /** Jump ramps: visual model plus a convex-hull collider built from its world-space vertices. */
  private buildRamps(assets: Assets): void {
    const v = new THREE.Vector3();
    for (const r of this.def.ramps) {
      const ramp = assets.cloneModel(RAMP);
      const p = this.path.pointAt(r.t);
      const tg = this.path.tangentAt(r.t);
      ramp.position.set(p.x, 0, p.z);
      ramp.rotation.y = Math.atan2(tg.x, tg.z);
      ramp.name = 'jump_ramp';
      const rampCull = new DistanceCull(
        ramp.position.clone(),
        Math.min(drawDistance(this.def.daylight), LANDMARK_DRAW_M),
        14,
      );
      this.group.add(rampCull);
      rampCull.add(ramp);
      ramp.updateMatrixWorld(true);
      // Collider = the driving surface (not the 0.39 m corner trim, whose hull would put a lip across the entrance)
      // plus a gentle lead-in. The model's surface steps from 2 cm to 82 cm within 1.5 m (a ~28° face): every car
      // stops dead against it, even at 30 m/s. A 1.6 m lead-in at ground level brings the entry slope to ~14°.
      const inv = ramp.matrixWorld.clone().invert();
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
      local.push(minX, 0, minZ - RACE.track.rampLeadInM, maxX, 0, minZ - RACE.track.rampLeadInM);
      const pts: number[] = [];
      for (let i = 0; i < local.length; i += 3) {
        v.set(local[i], local[i + 1], local[i + 2]).applyMatrix4(ramp.matrixWorld);
        pts.push(v.x, v.y, v.z);
      }
      const hull = this.R.ColliderDesc.convexHull(new Float32Array(pts));
      if (hull) this.world.createCollider(hull.setFriction(0.8), this.body);
    }
  }

  /** Light the first `lit` lamps in `color` (0 = all off). */
  setLamps(lit: number, color: string): void {
    this.lamps.forEach((m, k) => {
      const on = k < lit;
      m.emissive.set(on ? color : '#000000');
      m.emissiveIntensity = on ? RACE.countdown.lampOnIntensity : 0;
    });
  }

  dispose(): void {
    this.gates?.dispose();
    this.world.removeRigidBody(this.body);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
    this.group.removeFromParent();
    this.scene.remove(this.group);
  }
}
