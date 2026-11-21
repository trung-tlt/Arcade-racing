import type RAPIER from '@dimforge/rapier3d-compat';
import { AI, RACE } from '../core/Data';

/**
 * Rivals that stop moving (or end up on their roof) are put back on the road a few metres ahead. Progress is measured
 * along the track, not by speed: a car rocking against an obstacle still "moves".
 */
export class StuckWatch {
  private anchorT = 0;
  private anchorSec = 0;
  private flipped = 0;
  private primed = false;

  /** `upY` is the car's up vector Y (1 = upright). Returns true when the car should be put back on the road. */
  update(dt: number, t: number, upY: number, lapLengthM: number): boolean {
    const cfg = AI.recovery;
    if (!this.primed) {
      this.anchorT = t;
      this.primed = true;
    }
    this.flipped = upY < cfg.flippedUpY ? this.flipped + dt : 0;
    this.anchorSec += dt;
    const moved = (((t - this.anchorT + 1.5) % 1) - 0.5) * lapLengthM; // signed metres along the lap
    if (moved >= cfg.minProgressM) {
      this.anchorT = t;
      this.anchorSec = 0;
    }
    if (this.anchorSec < cfg.progressWindowSec && this.flipped < cfg.flippedSec) return false;
    this.anchorT = t;
    this.anchorSec = 0;
    this.flipped = 0;
    return true;
  }
}

/** Up vector Y from a unit quaternion. */
export const upY = (q: { x: number; z: number }): number => 1 - 2 * (q.x * q.x + q.z * q.z);

export interface FallInput {
  hasElevation: boolean;
  groundY: number;
  x: number;
  y: number;
  z: number;
  speedMps: number;
  /** Road height at the car's place along the track. */
  roadY: number;
}

/**
 * Elevated maps: a car that dropped into the pit, off a raised road, or sank through the road surface goes back to
 * its last track position. `ray` casts down onto fixed colliders (the sunk test); same rules as the browser game.
 */
export function hasFallen(f: FallInput, world: RAPIER.World, R: typeof RAPIER, ray: RAPIER.Ray): boolean {
  if (!f.hasElevation) return false;
  if (f.groundY <= -1 && f.y <= f.groundY + RACE.fall.belowGroundM) return true;
  if (f.groundY > -1 && f.y < f.roadY - RACE.fall.belowRoadM) return true;
  if (f.speedMps > RACE.fall.sunkSlowBelowMps) return false;
  if (f.y > f.roadY - RACE.fall.sunkBelowRoadM / 2) return false;
  ray.origin.x = f.x;
  ray.origin.y = f.y + RACE.fall.sunkRayAboveM;
  ray.origin.z = f.z;
  const hit = world.castRay(
    ray,
    RACE.fall.sunkRayAboveM + RACE.fall.sunkBelowRoadM + 1,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    (col) => col.parent()?.bodyType() === R.RigidBodyType.Fixed,
  );
  return !!hit && ray.origin.y - hit.timeOfImpact > f.y + RACE.fall.sunkBelowRoadM;
}
