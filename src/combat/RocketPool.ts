import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { COMBAT, WEAPONS } from '../core/Data';
import type { Particles } from '../fx/Particles';
import type { RocketFx } from '../sim/RocketSim';
import type { V3 } from './AutoAim';

export const ROCKET_MODEL = WEAPONS.hornet_rocket.model;

const Z = new THREE.Vector3(0, 0, 1);
const tmp = new THREE.Vector3();
const dirV = new THREE.Vector3();

/** The Hornet rockets' models: `RocketSim` flies them, this shows, poses and trails them. */
export class RocketPool implements RocketFx {
  private readonly meshes: THREE.Object3D[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    assets: Assets,
    private readonly particles: Particles,
  ) {
    for (let i = 0; i < COMBAT.rocket.poolSize; i++) {
      const mesh = assets.cloneModel(ROCKET_MODEL);
      mesh.visible = false;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  show(slot: number, on: boolean): void {
    this.meshes[slot].visible = on;
  }

  pose(slot: number, pos: V3, dir: V3): void {
    const m = this.meshes[slot];
    m.position.set(pos.x, pos.y, pos.z);
    m.quaternion.setFromUnitVectors(Z, dirV.set(dir.x, dir.y, dir.z));
  }

  trail(pos: V3): void {
    this.particles.spawn('smoke', tmp.set(pos.x, pos.y, pos.z), undefined, 0.8);
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
        }
      });
      this.scene.remove(mesh);
    }
  }
}
