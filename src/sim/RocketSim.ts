import type RAPIER from '@dimforge/rapier3d-compat';
import { COMBAT, WEAPONS } from '../core/Data';
import type { V3 } from '../combat/AutoAim';
import { homingStep } from '../combat/Rockets';

type Rapier = typeof RAPIER;

/** What the browser draws for a rocket slot; the server passes nothing. */
export interface RocketFx {
  show(slot: number, on: boolean): void;
  /** Rocket in flight this step: world position and unit heading. */
  pose(slot: number, pos: V3, dir: V3): void;
  /** Smoke puff behind the rocket. */
  trail(pos: V3): void;
}

interface Rocket {
  active: boolean;
  owner: string;
  target: string | null;
  pos: V3;
  dir: V3;
  age: number;
  trailT: number;
}

export interface RocketHit {
  pos: V3;
  owner: string;
  /** Collider the rocket struck, or null when it timed out / proximity-fused. */
  collider: RAPIER.Collider | null;
}

const tmp: V3 = { x: 0, y: 0, z: 0 };
const hitPos: V3 = { x: 0, y: 0, z: 0 };

/** Fixed pool of Hornet rockets: mild homing, ray-swept collision. No rendering (see `RocketFx`). */
export class RocketSim {
  private readonly rockets: Rocket[] = [];
  private readonly ray: RAPIER.Ray;
  private readonly cfg = WEAPONS.hornet_rocket;

  constructor(
    R: Rapier,
    private readonly world: RAPIER.World,
    private readonly fx?: RocketFx,
  ) {
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    for (let i = 0; i < COMBAT.rocket.poolSize; i++) {
      this.rockets.push({
        active: false,
        owner: '',
        target: null,
        pos: { x: 0, y: 0, z: 0 },
        dir: { x: 0, y: 0, z: 1 },
        age: 0,
        trailT: 0,
      });
    }
  }

  /** Visit every rocket in flight (HUD warnings): owner, position, heading. */
  forEachActive(cb: (owner: string, pos: V3, dir: V3, slot: number) => void): void {
    this.rockets.forEach((r, i) => {
      if (r.active) cb(r.owner, r.pos, r.dir, i);
    });
  }

  /** Launch from the pool; returns false when every slot is in flight. */
  launch(owner: string, pos: V3, dir: V3, target: string | null): boolean {
    const i = this.rockets.findIndex((x) => !x.active);
    if (i < 0) return false;
    const r = this.rockets[i];
    r.active = true;
    r.owner = owner;
    r.target = target;
    r.pos.x = pos.x;
    r.pos.y = pos.y;
    r.pos.z = pos.z;
    const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z) || 1;
    r.dir.x = dir.x / len;
    r.dir.y = dir.y / len;
    r.dir.z = dir.z / len;
    r.age = 0;
    r.trailT = 0;
    this.fx?.show(i, true);
    return true;
  }

  /**
   * Advance every rocket. `targetPos` resolves a target id to a world position (null = lost);
   * `onHit` is called once per detonation. `proximity` lets the caller fuse next to cars.
   */
  update(
    dt: number,
    targetPos: (id: string) => V3 | null,
    proximity: (pos: V3, owner: string, age: number) => boolean,
    ownerBody: (id: string) => RAPIER.RigidBody | null,
    onHit: (h: RocketHit) => void,
  ): void {
    const turn = (this.cfg.turnRateDegPerSec * Math.PI) / 180;
    this.rockets.forEach((r, slot) => {
      if (!r.active) return;
      r.age += dt;
      if (r.target) {
        const tp = targetPos(r.target);
        if (tp) {
          tmp.x = tp.x - r.pos.x;
          tmp.y = tp.y - r.pos.y;
          tmp.z = tp.z - r.pos.z;
          const d = homingStep(r.dir, tmp, turn * dt);
          r.dir.x = d.x;
          r.dir.y = d.y;
          r.dir.z = d.z;
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
        r.pos.x += r.dir.x * hit.timeOfImpact;
        r.pos.y += r.dir.y * hit.timeOfImpact;
        r.pos.z += r.dir.z * hit.timeOfImpact;
        this.detonate(slot, r, hit.collider, onHit);
        return;
      }
      r.pos.x += r.dir.x * step;
      r.pos.y += r.dir.y * step;
      r.pos.z += r.dir.z * step;
      if (r.pos.y < 0.2 || r.age >= this.cfg.lifetimeSec || proximity(r.pos, r.owner, r.age)) {
        this.detonate(slot, r, null, onHit);
        return;
      }
      this.fx?.pose(slot, r.pos, r.dir);
      r.trailT -= dt;
      if (r.trailT <= 0) {
        r.trailT = COMBAT.rocket.trailIntervalSec;
        tmp.x = r.pos.x - r.dir.x * 0.4;
        tmp.y = r.pos.y - r.dir.y * 0.4;
        tmp.z = r.pos.z - r.dir.z * 0.4;
        this.fx?.trail(tmp);
      }
    });
  }

  private detonate(slot: number, r: Rocket, collider: RAPIER.Collider | null, onHit: (h: RocketHit) => void): void {
    r.active = false;
    this.fx?.show(slot, false);
    hitPos.x = r.pos.x;
    hitPos.y = r.pos.y;
    hitPos.z = r.pos.z;
    onHit({ pos: hitPos, owner: r.owner, collider });
  }
}
