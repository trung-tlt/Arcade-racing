import aiJson from '../../data/ai.json';

export const AI = aiJson;
export type AI = typeof aiJson;

export interface GunnerState {
  /** Pause between bursts: no MG while > 0. */
  fireCooldown: number;
  rocketCooldown: number;
  /** Time left before the gunner reacts to a fresh target. */
  reactionLeft: number;
}

export interface GunTarget {
  id: string;
  x: number;
  y: number;
  z: number;
  wrecked: boolean;
}

const RAD = 180 / Math.PI;

export function newGunnerState(cfg: AI['gunner']): GunnerState {
  return { fireCooldown: 0, rocketCooldown: 0, reactionLeft: cfg.reactionSec };
}

/** Angle (deg) between the nose (yaw 0 = +Z) and the direction to a point; also returns the distance. */
function aimError(self: { x: number; y: number; z: number; yaw: number }, t: GunTarget): { deg: number; dist: number } {
  const dx = t.x - self.x;
  const dy = t.y - self.y;
  const dz = t.z - self.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return { deg: 0, dist: 0 };
  const dot = (dx * Math.sin(self.yaw) + dz * Math.cos(self.yaw)) / dist;
  return { deg: Math.acos(Math.min(1, Math.max(-1, dot))) * RAD, dist };
}

/** Decides MG / rocket triggers for one tick. Never targets wrecked cars. */
export function decideFire(
  self: { x: number; y: number; z: number; yaw: number },
  targets: readonly GunTarget[],
  ammo: number,
  cfg: AI['gunner'],
  st: GunnerState,
  dt: number,
  rnd: () => number,
): { fire: boolean; fireSecondary: boolean } {
  st.fireCooldown = Math.max(0, st.fireCooldown - dt);
  st.rocketCooldown = Math.max(0, st.rocketCooldown - dt);

  let mg = false;
  let rocket = false;
  for (const t of targets) {
    if (t.wrecked) continue;
    const { deg, dist } = aimError(self, t);
    if (deg <= cfg.coneDeg && dist <= cfg.rangeM) mg = true;
    if (deg <= cfg.rocketConeDeg && dist >= cfg.rocketMinRangeM && dist <= cfg.rocketMaxRangeM) rocket = true;
  }
  if (!mg && !rocket) {
    st.reactionLeft = cfg.reactionSec;
    return { fire: false, fireSecondary: false };
  }
  st.reactionLeft = Math.max(0, st.reactionLeft - dt);
  if (st.reactionLeft > 0) return { fire: false, fireSecondary: false };

  const fireSecondary = rocket && ammo > 0 && st.rocketCooldown === 0;
  if (fireSecondary) st.rocketCooldown = cfg.rocketCooldownSec;

  let fire = mg && st.fireCooldown === 0;
  // Fire in bursts: now and then let the trigger go so the gun can cool.
  if (fire && rnd() < dt / cfg.burstEverySec) {
    st.fireCooldown = cfg.pauseSec;
    fire = false;
  }
  return { fire, fireSecondary };
}
