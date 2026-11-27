import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/Assets';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import { protectSpecialMaterials } from './MonteCarlo';
import { materialKey } from './Sponsors';
import type { Pixels } from './ardennesLayout';

export const up = new THREE.Vector3(0, 1, 0);

/** The pixels of a loaded texture (the heightmap, mask and splat are data, read once). */
export function readPixels(tex: THREE.Texture): Pixels {
  const img = tex.image as CanvasImageSource & { width: number; height: number };
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: d.width, height: d.height };
}

/**
 * Bakes placements into one static mesh per material (vertex-colour parts into two shared materials). Plain
 * two-sided parts (flags, tent cloth, awnings) get a flipped copy of their triangles and go one-sided, so they merge
 * too instead of costing a draw call per colour.
 */
export class StaticBake {
  private readonly buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();
  private readonly protos = new Map<string, THREE.Object3D>();

  constructor(private readonly assets: Assets) {}

  private static flipDouble(mesh: THREE.Mesh, mat: THREE.MeshStandardMaterial): void {
    const src = mesh.geometry;
    const pos = src.getAttribute('position');
    const n = pos.count;
    const geo = new THREE.BufferGeometry();
    for (const name of Object.keys(src.attributes)) {
      const a = src.getAttribute(name);
      const arr = new (a.array.constructor as new (n: number) => Float32Array)(a.array.length * 2);
      arr.set(a.array as ArrayLike<number>, 0);
      arr.set(a.array as ArrayLike<number>, a.array.length);
      if (name === 'normal') for (let i = a.array.length; i < arr.length; i++) arr[i] = -arr[i];
      geo.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
    }
    const idx = src.index;
    const count = idx ? idx.count : n;
    const out = new Uint32Array(count * 2);
    for (let i = 0; i < count; i += 3) {
      const [a, b, c] = idx ? [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)] : [i, i + 1, i + 2];
      out.set([a, b, c], i);
      out.set([a + n, c + n, b + n], count + i);
    }
    geo.setIndex(new THREE.BufferAttribute(out, 1));
    mesh.geometry = geo;
    mat.side = THREE.FrontSide;
  }

  add(model: string, at: THREE.Matrix4, panelsOnly = false): void {
    let proto = this.protos.get(model);
    if (!proto) {
      proto = this.assets.cloneModel(model);
      proto.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
        const m = o.material as THREE.MeshStandardMaterial;
        if (m.side === THREE.DoubleSide && !m.map && !m.transparent && m.alphaTest === 0) StaticBake.flipDouble(o, m);
      });
      protectSpecialMaterials(proto);
      mergePropMaterials(proto);
      proto.updateMatrixWorld(true);
      this.protos.set(model, proto);
    }
    const world = new THREE.Matrix4();
    proto.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      if (panelsOnly && !(o.material as THREE.MeshStandardMaterial).map) return;
      const key = materialKey(o.material);
      let b = this.buckets.get(key);
      if (!b) {
        b = { material: o.material, geos: [] };
        this.buckets.set(key, b);
      }
      world.multiplyMatrices(at, o.matrixWorld);
      b.geos.push(o.geometry.clone().applyMatrix4(world));
    });
  }

  addAt(model: string, x: number, y: number, z: number, yaw: number, scale = 1, panelsOnly = false): void {
    this.add(
      model,
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromAxisAngle(up, yaw),
        new THREE.Vector3(scale, scale, scale),
      ),
      panelsOnly,
    );
  }

  build(parent: THREE.Object3D, name: string): void {
    for (const [key, b] of this.buckets) {
      const common = Object.keys(b.geos[0].attributes).filter((a) => b.geos.every((g) => g.getAttribute(a)));
      for (const g of b.geos) for (const a of Object.keys(g.attributes)) if (!common.includes(a)) g.deleteAttribute(a);
      const merged = mergeGeometries(b.geos, false);
      b.geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.name = `${name}:${key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      parent.add(mesh);
    }
    this.buckets.clear();
  }

  dispose(): void {
    const freed = new Set<THREE.Material>();
    for (const p of this.protos.values()) {
      p.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
          if (mat.userData.shared || freed.has(mat)) continue;
          freed.add(mat);
          mat.dispose();
        }
      });
    }
    this.protos.clear();
  }
}

export interface Placed {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  tint?: [number, number, number];
}

/**
 * A fixed-capacity InstancedMesh set (one per sub-mesh of a model) that is refilled as the camera moves: trees, grass
 * and forest cards. `fill` writes the matrices (and per-instance HSL tints) and sets the draw count.
 */
export class InstancePool {
  readonly meshes: THREE.InstancedMesh[] = [];
  private readonly local: THREE.Matrix4[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly tmp = new THREE.Matrix4();

  constructor(
    parent: THREE.Object3D,
    assets: Assets,
    model: string,
    readonly capacity: number,
    tinted: boolean,
  ) {
    const proto = assets.cloneModel(model);
    protectSpecialMaterials(proto);
    mergePropMaterials(proto);
    proto.updateMatrixWorld(true);
    proto.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const inst = new THREE.InstancedMesh(o.geometry, o.material, capacity);
      inst.name = `${model.split('/').pop()}:${o.name}`;
      inst.count = 0;
      inst.frustumCulled = false;
      inst.castShadow = false;
      inst.receiveShadow = true;
      if (tinted) inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      this.meshes.push(inst);
      this.local.push(o.matrixWorld.clone());
      parent.add(inst);
    });
  }

  fill(items: readonly Placed[]): void {
    const n = Math.min(items.length, this.capacity);
    for (let k = 0; k < n; k++) {
      const it = items[k];
      this.p.set(it.x, it.y, it.z);
      this.q.setFromAxisAngle(up, it.yaw);
      this.s.set(it.scale, it.scale, it.scale);
      this.m.compose(this.p, this.q, this.s);
      for (let i = 0; i < this.meshes.length; i++) {
        this.meshes[i].setMatrixAt(k, this.tmp.multiplyMatrices(this.m, this.local[i]));
        if (it.tint && this.meshes[i].instanceColor) {
          this.meshes[i].setColorAt(k, this.c.setHSL(it.tint[0], it.tint[1], it.tint[2]));
        }
      }
    }
    for (const mesh of this.meshes) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mat.dispose();
      mesh.dispose();
    }
  }
}
