import { contactDamage, isSideHit, wallHit } from '../combat/Contact';
import { COMBAT } from '../core/Data';
import type { CarSim } from './CarSim';

/**
 * Hits that aren't weapons. A car that loses speed to a wall (maps whose JSON has `barriers.armco`) takes hull damage,
 * loses speed on a head-on hit and throws sparks on a scrape. Open-wheel cars (Fulmine FX) also take extra damage from
 * contact with another car, and clipping a car from the side makes it hop. Numbers: data/combat.json `wall` / `contact`.
 */
export class HitRules {
  private readonly cooldown = new Map<string, number>();

  constructor(
    /** The map has armco walls that hurt (JSON `barriers.armco`). */
    private readonly walls: boolean,
    /** Browser only: sparks where a car scraped a wall. */
    private readonly onWallSparks?: (x: number, y: number, z: number) => void,
  ) {}

  clear(): void {
    this.cooldown.clear();
  }

  apply(
    dt: number,
    cars: readonly CarSim[],
    damage: (victim: CarSim, amount: number, attackerId: string | null) => void,
  ): void {
    const W = COMBAT.wall;
    const C = COMBAT.contact;
    for (const [id, left] of this.cooldown) {
      if (left <= dt) this.cooldown.delete(id);
      else this.cooldown.set(id, left - dt);
    }
    for (const car of cars) {
      const p = car.physics;
      if (car.hull.wrecked || p.airborne || p.impactStrength < Math.min(W.minGlancingImpactMps, C.minImpactMps))
        continue;
      if (this.cooldown.has(car.id)) continue;
      let other: CarSim | null = null;
      let best = C.radiusM;
      for (const o of cars) {
        if (o === car || o.hull.wrecked) continue;
        const d = Math.hypot(o.physics.curr.p.x - p.curr.p.x, o.physics.curr.p.z - p.curr.p.z);
        if (d < best) {
          best = d;
          other = o;
        }
      }
      if (other) {
        const open = !!car.def.openWheel;
        const dmg = open ? contactDamage(p.impactStrength, true, C) : 0;
        if (dmg > 0) damage(car, dmg, other.id);
        const op = other.physics.curr.p;
        if (
          open &&
          p.impactStrength >= C.minImpactMps &&
          isSideHit(other.physics.yaw, p.curr.p.x - op.x, p.curr.p.z - op.z, C)
        ) {
          other.physics.hop(C.sideLaunchMps);
        }
        if (dmg > 0 || open) this.cooldown.set(car.id, C.cooldownSec);
      } else if (this.walls) {
        const hit = wallHit(p.velBefore, p.velAfter, W);
        if (!hit) continue;
        damage(car, hit.hull, null);
        if (hit.speedMul < 1) p.scaleHorizontalVelocity(hit.speedMul);
        this.onWallSparks?.(p.curr.p.x, p.curr.p.y + 0.5, p.curr.p.z);
        this.cooldown.set(car.id, W.cooldownSec);
      }
    }
  }
}
