import * as THREE from 'three';
import type { HandlingDef } from '../core/Data';
import { userSettings } from '../core/Settings';
import type { CarPhysics } from './CarPhysics';

const up = new THREE.Vector3(0, 1, 0);
const target = new THREE.Vector3();
const desired = new THREE.Vector3();
const dir = new THREE.Vector3();

/** Sits behind the car on its −Z side, with positional lag, nitro FOV kick and shake. */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private yaw = 0;
  private readonly pos = new THREE.Vector3();
  private shake = 0;
  private fov: number;
  private first = true;

  constructor(
    aspect: number,
    private readonly h: HandlingDef,
  ) {
    this.fov = h.camera.fovBase;
    this.camera = new THREE.PerspectiveCamera(this.fov, aspect, 0.1, 1500);
  }

  addShake(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  /** Jump straight to the car on the next update (after a respawn). */
  snap(): void {
    this.first = true;
    this.pos.set(0, 0, 0);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** `carPos` / `carYaw` are the render-interpolated pose of the followed car. */
  update(dt: number, carPos: THREE.Vector3, carYaw: number, physics: CarPhysics): void {
    const c = this.h.camera;
    if (this.first) {
      this.yaw = carYaw;
      this.first = false;
    }
    // Shortest-arc yaw lag.
    let d = carYaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * (1 - Math.exp(-c.yawLagPerSec * dt));

    dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    desired.copy(carPos).addScaledVector(dir, -c.distance).addScaledVector(up, c.height);
    if (this.pos.lengthSq() === 0) this.pos.copy(desired);
    this.pos.lerp(desired, 1 - Math.exp(-c.positionLagPerSec * dt));

    this.camera.position.copy(this.pos);
    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.5;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.5;
      this.shake *= Math.exp(-8 * dt);
    }
    target.copy(carPos).addScaledVector(dir, c.lookAheadM).addScaledVector(up, c.lookHeight);
    this.camera.lookAt(target);

    const goalFov = physics.nitroActive && userSettings.fovKick ? c.fovNitro : c.fovBase;
    this.fov += (goalFov - this.fov) * (1 - Math.exp(-c.fovLerpPerSec * dt));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
