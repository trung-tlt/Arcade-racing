import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { COMBAT, WEAPONS } from '../core/Data';
import type { Particles } from '../fx/Particles';
import { homingStep } from './Rockets';

type Rapier = typeof RAPIER;
export const ROCKET_MODEL = WEAPONS.hornet_rocket.model;

interface Rocket {
  mesh: THREE.Object3D;
  trail: THREE.Object3D | null;
  active: boolean;
  owner: string;
  target: string | null;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  age: number;
  trailT: number;
}

export interface RocketHit {
  pos: THREE.Vector3;
  owner: string;
  /** Collider the rocket struck, or null when it timed out / proximity-fused. */
  collider: RAPIER.Collider | null;
}

const Z = new THREE.Vector3(0, 0, 1);
const tmp = new THREE.Vector3();

/** Fixed pool of Hornet rockets: mild homing, ray-swept collision, smoke trail. */
export class RocketPool {
  private readonly rockets: Rocket[] = [];
  private readonly ray: RAPIER.Ray;
  private readonly cfg = WEAPONS.hornet_rocket;

  constructor(
    R: Rapier,
    private readonly world: RAPIER.World,
    private readonly scene: THREE.Scene,
    assets: Assets,
    private readonly particles: Particles,
  ) {
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    for (let i = 0; i < COMBAT.rocket.poolSize; i++) {
      const mesh = assets.cloneModel(ROCKET_MODEL);
      mesh.visible = false;
      scene.add(mesh);
      this.rockets.push({
        mesh,
        trail: mesh.getObjectByName('trail') ?? null,
        active: false,
        owner: '',
        target: null,
        pos: new THREE.Vector3(),
        dir: new THREE.Vector3(0, 0, 1),
        age: 0,
        trailT: 0,
      });
    }
  }

  /** Visit every rocket in flight (HUD warnings): owner, position, heading. */
  forEachActive(cb: (owner: string, pos: THREE.Vector3, dir: THREE.Vector3) => void): void {
    for (const r of this.rockets) if (r.active) cb(r.owner, r.pos, r.dir);
  }

  /** Launch from the pool; returns false when every slot is in flight. */
  launch(owner: string, pos: THREE.Vector3, dir: THREE.Vector3, target: string | null): boolean {
    const r = this.rockets.find((x) => !x.active);
    if (!r) return false;
    r.active = true;
    r.owner = owner;
    r.target = target;
    r.pos.copy(pos);
    r.dir.copy(dir).normalize();
    r.age = 0;
    r.trailT = 0;
    r.mesh.visible = true;
    return true;
  }

  /**
   * Advance every rocket. `targetPos` resolves a target id to a world position (null = lost);
   * `onHit` is called once per detonation. `proximity` lets the caller fuse next to cars.
   */
  update(
    dt: number,
    targetPos: (id: string) => THREE.Vector3 | null,
    proximity: (pos: THREE.Vector3, owner: string, age: number) => boolean,
    ownerBody: (id: string) => RAPIER.RigidBody | null,
    onHit: (h: RocketHit) => void,
  ): void {
    const turn = (this.cfg.turnRateDegPerSec * Math.PI) / 180;
    for (const r of this.rockets) {
      if (!r.active) continue;
      r.age += dt;
      if (r.target) {
        const tp = targetPos(r.target);
        if (tp) {
          tmp.copy(tp).sub(r.pos);
          const d = homingStep(r.dir, tmp, turn * dt);
          r.dir.set(d.x, d.y, d.z);
        } else r.target = null;
      }
      const step = this.cfg.speedMps * dt;
      this.ray.origin.x = r.pos.x;
      this.ray.origin.y = r.pos.y;
      this.ray.origin.z = r.pos.z;
      this.ray.dir.x = r.dir.x;
      this.ray.dir.y = r.dir.y;
      this.ray.dir.z = r.dir.z;
      const exclude = r.age < COMBAT.rocket.armSec ? (ownerBody(r.owner) ?? undefined) : undefined;
      const hit = this.world.castRay(this.ray, step + 0.3, true, undefined, undefined, undefined, exclude);
      if (hit) {
        r.pos.addScaledVector(r.dir, hit.timeOfImpact);
        this.detonate(r, hit.collider, onHit);
        continue;
      }
      r.pos.addScaledVector(r.dir, step);
      if (r.pos.y < 0.2 || r.age >= this.cfg.lifetimeSec || proximity(r.pos, r.owner, r.age)) {
        this.detonate(r, null, onHit);
        continue;
      }
      r.mesh.position.copy(r.pos);
      r.mesh.quaternion.setFromUnitVectors(Z, r.dir);
      r.trailT -= dt;
      if (r.trailT <= 0) {
        r.trailT = COMBAT.rocket.trailIntervalSec;
        tmp.copy(r.pos).addScaledVector(r.dir, -0.4);
        this.particles.spawn('smoke', tmp, undefined, 0.8);
      }
    }
  }

  private detonate(r: Rocket, collider: RAPIER.Collider | null, onHit: (h: RocketHit) => void): void {
    r.active = false;
    r.mesh.visible = false;
    onHit({ pos: r.pos.clone(), owner: r.owner, collider });
  }

  dispose(): void {
    for (const r of this.rockets) {
      r.mesh.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
        }
      });
      this.scene.remove(r.mesh);
    }
  }
}
