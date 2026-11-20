import type { COMBAT as CombatData } from '../core/Data';

type Wall = typeof CombatData.wall;
type Contact = typeof CombatData.contact;

/** Pure rules for hits that aren't weapons: barrier walls (Map 5's Armco) and car-to-car contact. No physics here. */

export interface WallResult {
  /** Hull damage to apply. */
  hull: number;
  /** Multiplier for the car's horizontal velocity (1 = leave it). */
  speedMul: number;
  /** True for a scrape: sparks only. */
  glancing: boolean;
}

const RAD = 180 / Math.PI;

/**
 * A hit on a static wall, from the horizontal velocity just before and just after the step. The incidence angle against
 * the wall is estimated from how the velocity changed: a car that slides along a wall keeps `cos(angle)` of its speed
 * and turns by `angle`; one that hits it square loses almost everything. Under `glancingMaxDeg` the hit is a scrape
 * (needs `minGlancingImpactMps` of speed loss); otherwise it needs `minImpactMps`. Returns null for anything lighter.
 */
export function wallHit(pre: { x: number; z: number }, post: { x: number; z: number }, cfg: Wall): WallResult | null {
  const preSpeed = Math.hypot(pre.x, pre.z);
  const postSpeed = Math.hypot(post.x, post.z);
  const loss = preSpeed - postSpeed;
  if (loss < cfg.minGlancingImpactMps) return null;
  const byLoss = Math.acos(Math.min(1, postSpeed / preSpeed)) * RAD;
  const byTurn =
    postSpeed < 0.5
      ? 180
      : Math.acos(Math.min(1, Math.max(-1, (pre.x * post.x + pre.z * post.z) / (preSpeed * postSpeed)))) * RAD;
  const deg = Math.max(byLoss, byTurn);
  if (deg < cfg.glancingMaxDeg) return { hull: cfg.glancingHullDamage, speedMul: 1, glancing: true };
  if (loss < cfg.minImpactMps) return null;
  return { hull: cfg.hullDamage, speedMul: cfg.speedMul, glancing: false };
}

/** Hull damage from car-to-car contact: scales with the speed lost above the threshold; open-wheel cars take extra. */
export function contactDamage(impactMps: number, openWheel: boolean, cfg: Contact): number {
  if (impactMps < cfg.minImpactMps) return 0;
  const base = (impactMps - cfg.minImpactMps + 1) * cfg.damagePerMps;
  return Math.round(base * (openWheel ? cfg.openWheelDamageMul : 1) * 10) / 10;
}

/**
 * Is `other` beside `victim` (a wheel-to-wheel hit) rather than ahead or behind? `yaw` is the victim's heading (0 = +Z,
 * + = turning left), (dx, dz) the offset from the victim to the other car.
 */
export function isSideHit(yaw: number, dx: number, dz: number, cfg: Contact): boolean {
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return false;
  // Victim's left axis is (cos yaw, -sin yaw) in (x, z); forward is (sin yaw, cos yaw).
  const lateral = Math.abs(dx * Math.cos(yaw) - dz * Math.sin(yaw)) / d;
  return lateral >= cfg.sideDotMin;
}
