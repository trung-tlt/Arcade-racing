import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { gateByDistance, windowInstances } from './Windowed';

interface Part {
  name: string;
  inst: THREE.InstancedMesh;
  /** Mesh transform inside the model (relative to the model root). */
  local: THREE.Matrix4;
}

const tmp = new THREE.Matrix4();
const spinM = new THREE.Matrix4();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Many copies of one GLB as one InstancedMesh per sub-mesh (so N copies cost the same draw calls as one).
 * Per-instance state is just a matrix; `spin` rotates parts named `icon` about their own Y axis.
 */
export class InstancedModel {
  readonly parts: Part[] = [];

  constructor(
    private readonly parent: THREE.Object3D,
    assets: Assets,
    path: string,
    count: number,
    castShadow = false,
  ) {
    const proto = assets.cloneModel(path);
    proto.updateMatrixWorld(true);
    proto.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const inst = new THREE.InstancedMesh(o.geometry, o.material, count);
      inst.name = o.name;
      inst.castShadow = castShadow;
      inst.frustumCulled = false;
      for (let i = 0; i < count; i++) inst.setMatrixAt(i, ZERO);
      parent.add(inst);
      this.parts.push({ name: o.name, inst, local: o.matrixWorld.clone() });
    });
  }

  /** Place instance `i`; `spin` (radians) turns the `icon` part. */
  set(i: number, base: THREE.Matrix4, spin = 0): void {
    for (const p of this.parts) {
      tmp.multiplyMatrices(base, p.local);
      if (p.name === 'icon' && spin !== 0) tmp.multiply(spinM.makeRotationY(spin));
      p.inst.setMatrixAt(i, tmp);
    }
  }

  hide(i: number): void {
    for (const p of this.parts) p.inst.setMatrixAt(i, ZERO);
  }

  /** The instanced meshes (one per sub-mesh). */
  get meshes(): THREE.InstancedMesh[] {
    return this.parts.map((p) => p.inst);
  }

  /** Static sets: draw only the instances within `radius` of the camera. Call after the final `commit()`. */
  window(radius: number): void {
    windowInstances(this.meshes, radius);
  }

  /** Moving sets (e.g. bobbing pickups): draw nothing while the camera is further than `radius` from every `xz` pair. */
  gate(xz: Float32Array, radius: number): void {
    gateByDistance(this.meshes, xz, radius);
  }

  commit(): void {
    for (const p of this.parts) p.inst.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const p of this.parts) {
      this.parent.remove(p.inst);
      p.inst.dispose();
      const m = p.inst.material;
      for (const mm of Array.isArray(m) ? m : [m]) mm.dispose();
    }
    this.parts.length = 0;
  }
}
