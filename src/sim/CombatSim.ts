import type RAPIER from '@dimforge/rapier3d-compat';
import { type AimTarget, type V3, pickAimTarget } from '../combat/AutoAim';
import { PickupField, type PickupDef, type PickupType, grantFor } from '../combat/Pickups';
import { splashDamage } from '../combat/Rockets';
import { COMBAT, HANDLING, WEAPONS } from '../core/Data';
import type { EventBus } from '../core/Events';
import { turretYaw } from '../vehicle/Turret';
import type { CarSim } from './CarSim';
import { boxCentre, rayVsObb, type Quat } from './lagcomp';
import { RocketSim, type RocketFx } from './RocketSim';

type Rapier = typeof RAPIER;

/** What the browser draws for combat; the server passes nothing (all calls are optional no-ops). */
export interface CombatFx extends RocketFx {
  /** Tracer from the gun muzzle `from` to the impact (or max range) `to`. `car` lets the view override the origin. */
  tracer(car: CarSim, from: V3, to: V3, hit: boolean): void;
  muzzleFlash(origin: V3, dir: V3): void;
  sparks(pos: V3, count: number, speed: number, size: number): void;
  explosion(pos: V3, radius: number): void;
  /** Invulnerability blink: whether the car's model is shown this step. */
  carVisible(car: CarSim, visible: boolean): void;
  /** Damage smoke (and fire + sparks when `fire`) rising from a hurt car. */
  damageSmoke(pos: V3, fire: boolean): void;
}

/**
 * Lag compensation for a shooter whose client draws the other cars slightly in the past: where the shooter saw `target`
 * is where a hitscan shot is tested. Shooters without it (bots, offline play) shoot at live positions.
 */
export interface LagComp {
  active(shooter: CarSim): boolean;
  /** Fills p/q with `target`'s pose as `shooter` saw it; false means "use the live pose". */
  poseOf(shooter: CarSim, target: CarSim, p: V3, q: Quat): boolean;
}

export interface CombatSimDeps {
  lagComp?: LagComp;
  R: Rapier;
  world: RAPIER.World;
  events: EventBus;
  cars: () => readonly CarSim[];
  /** Where a wrecked car comes back (checkpoint pose / its own spawn). */
  respawnPoseFor: (car: CarSim) => { x: number; z: number; yaw: number };
  pickupDefs: readonly PickupDef[];
  /** World position of every pickup, indexed by pickup id. */
  pickupPositions: readonly V3[];
  /** Whether the soft aim cone applies to this car's gun (a player setting in the browser). Default: always. */
  aimAssistFor?: (car: CarSim) => boolean;
  fx?: CombatFx;
}

const PICKUP_TYPES = Object.keys(WEAPONS.pickups) as PickupType[];
const origin: V3 = { x: 0, y: 0, z: 0 };
const fwd: V3 = { x: 0, y: 0, z: 1 };
const endPt: V3 = { x: 0, y: 0, z: 0 };
const tmpV: V3 = { x: 0, y: 0, z: 0 };
const aimDir: V3 = { x: 0, y: 0, z: 1 };
const centre: V3 = { x: 0, y: 0, z: 0 };
const rwP: V3 = { x: 0, y: 0, z: 0 };
const rwQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
const boxC: V3 = { x: 0, y: 0, z: 0 };

const dist3 = (a: V3, b: V3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/** Rotates (x, y, z) by the unit quaternion q into `out` (same arithmetic as THREE.Vector3.applyQuaternion). */
function rotate(x: number, y: number, z: number, q: { x: number; y: number; z: number; w: number }, out: V3): void {
  const ix = q.w * x + q.y * z - q.z * y;
  const iy = q.w * y + q.z * x - q.x * z;
  const iz = q.w * z + q.x * y - q.y * x;
  const iw = -q.x * x - q.y * y - q.z * z;
  out.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
  out.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
  out.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
}

/**
 * Guns, rockets, pickups, damage states, wrecks and respawns. Gameplay only: no rendering, no DOM, no client settings,
 * so the server runs it too. Drawing goes through the optional `fx` sink.
 */
export class CombatSim {
  readonly field: PickupField;
  private readonly rockets: RocketSim;
  private readonly ray: RAPIER.Ray;
  private readonly byCollider = new Map<number, CarSim>();
  private readonly aim = new Map<string, AimTarget>();
  private readonly aimList: AimTarget[] = [];
  private readonly prevSecondary = new Map<string, boolean>();
  private readonly fxTimer = new Map<string, number>();
  private readonly grants: Record<PickupType, Record<string, number>>;
  private readonly hints: { x: number; z: number; type: PickupType }[] = [];
  private time = 0;

  constructor(private readonly d: CombatSimDeps) {
    const respawn = {} as Record<PickupType, number>;
    const grants = {} as Record<PickupType, Record<string, number>>;
    for (const k of PICKUP_TYPES) {
      respawn[k] = WEAPONS.pickups[k].respawnSec;
      grants[k] = WEAPONS.pickups[k].grants;
    }
    this.grants = grants;
    this.field = new PickupField(d.pickupDefs, respawn);
    this.rockets = new RocketSim(d.R, d.world, d.fx);
    this.ray = new d.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    for (const c of d.cars()) {
      this.byCollider.set(c.physics.collider.handle, c);
      this.aim.set(c.id, { id: c.id, pos: { x: 0, y: 0, z: 0 } });
    }
  }

  /** Currently available pickups (world x/z + type) for AI drivers. The array is reused between calls. */
  availablePickups(): readonly { x: number; z: number; type: PickupType }[] {
    this.hints.length = 0;
    for (const def of this.d.pickupDefs) {
      if (!this.field.isAvailable(def.id)) continue;
      const p = this.d.pickupPositions[def.id];
      this.hints.push({ x: p.x, z: p.z, type: def.type });
    }
    return this.hints;
  }

  /** Ids of the pickups that are currently taken (respawning). */
  takenPickups(out: number[] = []): number[] {
    out.length = 0;
    for (const def of this.d.pickupDefs) if (!this.field.isAvailable(def.id)) out.push(def.id);
    return out;
  }

  /** Rockets in flight, for the incoming-rocket warning. */
  forEachRocket(cb: (owner: string, pos: V3, dir: V3, slot: number) => void): void {
    this.rockets.forEachActive(cb);
  }

  /** Online clients: only the smoke and fire of hurt cars (the server runs everything else). */
  effects(dt: number): void {
    for (const car of this.d.cars()) if (!car.hull.wrecked) this.damageFx(car, dt);
  }

  update(dt: number): void {
    this.time += dt;
    const cars = this.d.cars();
    for (const car of cars) {
      if (car.hull.update(dt) === 'respawn') car.respawn(this.d.respawnPoseFor(car));
      if (car.hull.wrecked) continue;
      this.d.fx?.carVisible(car, !car.hull.invulnerable || Math.floor(this.time * COMBAT.blinkHz * 2) % 2 === 0);
      this.refreshAim(cars);
      this.fireGun(car, dt);
      this.fireRocket(car);
      this.damageFx(car, dt);
      this.collectPickups(car);
    }
    this.field.update(dt);
    this.rockets.update(
      dt,
      (id) => this.carCentre(id),
      (pos, owner, age) => this.proximityFuse(pos, owner, age),
      (id) => cars.find((c) => c.id === id)?.physics.body ?? null,
      (h) => this.explode(h.pos, h.owner),
    );
  }

  /**
   * World-space muzzle position and nose direction for a car. `yaw` turns the gun mount about +Y first
   * (radians, + = left), so the muzzle follows a rotated turret.
   */
  private muzzle(car: CarSim, yaw = 0): void {
    const { p, q } = car.physics.curr;
    const gm = car.def.gunMount;
    const mo = COMBAT.muzzleOffset;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    rotate(gm[0] + mo[0] * cos + mo[2] * sin, gm[1] + mo[1], gm[2] - mo[0] * sin + mo[2] * cos, q, origin);
    origin.x += p.x;
    origin.y += p.y;
    origin.z += p.z;
    rotate(0, 0, 1, q, fwd);
  }

  /** Full-circle turrets (hauler, APC) search every direction; everything else keeps its soft cone. */
  private isFullTurret(car: CarSim): boolean {
    return car.def.turretYawDeg >= COMBAT.turret.fullTurretDeg;
  }

  /** Point the visual turret at `dir` (world) for a while; returns the yaw used. */
  private aimTurret(car: CarSim, dir: V3): number {
    const yaw = turretYaw(fwd, dir, car.def.turretYawDeg);
    car.aim.yawRad = yaw;
    car.aim.holdSec = COMBAT.turret.holdSec;
    return yaw;
  }

  private refreshAim(cars: readonly CarSim[]): void {
    this.aimList.length = 0;
    for (const c of cars) {
      if (c.hull.wrecked) continue;
      const t = this.aim.get(c.id);
      if (!t) continue;
      const p = c.physics.curr.p;
      t.pos.x = p.x;
      t.pos.y = p.y + COMBAT.aimTargetHeightM;
      t.pos.z = p.z;
      this.aimList.push(t);
    }
  }

  /** Targets other than `self`; the shared list is filtered in place per call. */
  private othersOf(self: CarSim): AimTarget[] {
    return this.aimList.filter((t) => t.id !== self.id);
  }

  private fireGun(car: CarSim, dt: number): void {
    const cfg = WEAPONS.pulse_mg;
    const shots = car.gun.update(dt, car.controls.fire, !car.physics.airborne);
    if (car.gun.justOverheated) {
      this.d.events.emit('gunOverheated', { carId: car.id, pos: car.physics.curr.p });
    }
    const full = this.isFullTurret(car);
    const aimAssist = this.d.aimAssistFor ? this.d.aimAssistFor(car) : true;
    const assist = !aimAssist ? 0 : full ? 180 : cfg.autoAimConeDeg;
    const lag = this.d.lagComp?.active(car) ?? false;
    for (let i = 0; i < shots; i++) {
      this.muzzle(car);
      const aim = pickAimTarget(origin, fwd, lag ? this.rewoundTargets(car) : this.othersOf(car), assist, cfg.rangeM);
      if (aim) {
        aimDir.x = aim.dir.x;
        aimDir.y = aim.dir.y;
        aimDir.z = aim.dir.z;
      } else {
        aimDir.x = fwd.x;
        aimDir.y = fwd.y;
        aimDir.z = fwd.z;
      }
      // The mount turns toward the shot (within its limit); the muzzle follows it.
      const yaw = this.aimTurret(car, aimDir);
      this.muzzle(car, yaw);
      this.setRay(origin, aimDir);
      let dist: number = cfg.rangeM;
      let hit = false;
      let victim: CarSim | undefined;
      if (lag) {
        const r = this.rewoundShot(car, cfg.rangeM);
        dist = r.dist;
        hit = r.hit;
        victim = r.victim ?? undefined;
      } else {
        const h = this.d.world.castRay(this.ray, cfg.rangeM, true, undefined, undefined, undefined, car.physics.body);
        if (h) {
          dist = h.timeOfImpact;
          hit = true;
          victim = this.byCollider.get(h.collider.handle);
        }
      }
      endPt.x = origin.x + aimDir.x * dist;
      endPt.y = origin.y + aimDir.y * dist;
      endPt.z = origin.z + aimDir.z * dist;
      this.d.fx?.tracer(car, origin, endPt, hit);
      this.d.fx?.muzzleFlash(origin, aimDir);
      this.d.events.emit('gunFired', { carId: car.id, pos: origin });
      if (!hit) continue;
      this.d.fx?.sparks(endPt, 3, 6, 0.25);
      if (victim && victim !== car) {
        this.applyDamage(victim, cfg.damage * car.def.gunDamageMul, car.id);
        car.physics.nitro.add(cfg.nitroGainOnHit);
      }
    }
  }

  /** Aim targets at the poses `shooter` saw (lag compensation): a fresh list, only used for lag-compensated shooters. */
  private rewoundTargets(shooter: CarSim): AimTarget[] {
    const out: AimTarget[] = [];
    for (const c of this.d.cars()) {
      if (c === shooter || c.hull.wrecked) continue;
      const lc = this.d.lagComp as LagComp;
      const rewound = lc.poseOf(shooter, c, rwP, rwQ);
      const p = rewound ? rwP : c.physics.curr.p;
      out.push({ id: c.id, pos: { x: p.x, y: p.y + COMBAT.aimTargetHeightM, z: p.z } });
    }
    return out;
  }

  /**
   * One hitscan shot with lag compensation: walls and scenery are tested in the live world (they do not move), cars
   * as boxes at the pose the shooter saw. The nearest thing along the ray wins.
   */
  private rewoundShot(shooter: CarSim, range: number): { dist: number; hit: boolean; victim: CarSim | null } {
    const lc = this.d.lagComp as LagComp;
    const stat = this.d.world.castRay(
      this.ray,
      range,
      true,
      undefined,
      undefined,
      undefined,
      shooter.physics.body,
      (col) => !this.byCollider.has(col.handle),
    );
    let best = stat ? stat.timeOfImpact : range;
    let hit = !!stat;
    let victim: CarSim | null = null;
    const boost = HANDLING.body.chassisClearanceBoostM;
    for (const c of this.d.cars()) {
      if (c === shooter || c.hull.wrecked) continue;
      const rewound = lc.poseOf(shooter, c, rwP, rwQ);
      const p = rewound ? rwP : c.physics.curr.p;
      const q = rewound ? rwQ : c.physics.curr.q;
      const col = c.def.collider;
      const centreLocal: [number, number, number] = [col.center[0], col.center[1] + boost / 2, col.center[2]];
      const half: [number, number, number] = [col.halfExtents[0], col.halfExtents[1] - boost / 2, col.halfExtents[2]];
      const t = rayVsObb(origin, aimDir, boxCentre(p, q, centreLocal, boxC), q, half, best);
      if (t !== null && t < best) {
        best = t;
        hit = true;
        victim = c;
      }
    }
    return { dist: best, hit, victim };
  }

  private fireRocket(car: CarSim): void {
    const pressed = car.controls.fireSecondary;
    const was = this.prevSecondary.get(car.id) ?? false;
    this.prevSecondary.set(car.id, pressed);
    if (!pressed || was || car.physics.airborne || car.ammo.count <= 0) return;
    this.muzzle(car);
    const full = this.isFullTurret(car);
    const aim = pickAimTarget(
      origin,
      fwd,
      this.othersOf(car),
      full ? 180 : COMBAT.rocket.homingConeDeg,
      COMBAT.rocket.homingRangeM,
    );
    // Full-circle turrets launch along the aim line; others keep launching along the nose.
    if (full && aim) {
      aimDir.x = aim.dir.x;
      aimDir.y = aim.dir.y;
      aimDir.z = aim.dir.z;
    } else {
      aimDir.x = fwd.x;
      aimDir.y = fwd.y;
      aimDir.z = fwd.z;
    }
    const yaw = full ? this.aimTurret(car, aimDir) : 0;
    this.muzzle(car, yaw);
    if (!this.rockets.launch(car.id, origin, aimDir, aim?.id ?? null)) return;
    car.ammo.consume();
    this.d.events.emit('rocketLaunched', { carId: car.id, pos: origin });
  }

  private carCentre(id: string): V3 | null {
    const c = this.d.cars().find((x) => x.id === id);
    if (!c || c.hull.wrecked) return null;
    const p = c.physics.curr.p;
    centre.x = p.x;
    centre.y = p.y + COMBAT.aimTargetHeightM;
    centre.z = p.z;
    return centre;
  }

  private proximityFuse(pos: V3, owner: string, age: number): boolean {
    if (age < COMBAT.rocket.armSec) return false;
    for (const c of this.d.cars()) {
      if (c.hull.wrecked || c.id === owner) continue;
      const p = c.physics.curr.p;
      tmpV.x = p.x;
      tmpV.y = p.y + COMBAT.aimTargetHeightM;
      tmpV.z = p.z;
      if (dist3(tmpV, pos) < COMBAT.rocket.proximityM) return true;
    }
    return false;
  }

  private explode(pos: V3, owner: string): void {
    const cfg = WEAPONS.hornet_rocket;
    this.d.fx?.explosion(pos, cfg.splashRadiusM);
    this.d.events.emit('explosion', { pos: { x: pos.x, y: pos.y, z: pos.z }, radius: cfg.splashRadiusM });
    for (const c of this.d.cars()) {
      if (c.hull.wrecked) continue;
      const p = c.physics.curr.p;
      tmpV.x = p.x;
      tmpV.y = p.y + COMBAT.aimTargetHeightM;
      tmpV.z = p.z;
      // Measure to the car's hull, not its centre, so a direct hit does full damage.
      const dist = Math.max(0, dist3(tmpV, pos) - c.def.collider.halfExtents[2] * 0.5);
      const dmg = splashDamage(cfg.damage, dist, cfg.splashRadiusM);
      if (dmg > 0) this.applyDamage(c, dmg, owner);
    }
  }

  /** Damage that isn't a weapon hit: a wall, or another car's bodywork. `attackerId` is null for scenery. */
  damageCar(victim: CarSim, amount: number, attackerId: string | null): void {
    this.applyDamage(victim, amount, attackerId);
  }

  private applyDamage(victim: CarSim, amount: number, attackerId: string | null): void {
    const r = victim.hull.damage(amount, attackerId);
    if (r.applied <= 0) return;
    this.d.events.emit('carHit', { carId: victim.id, attackerId, damage: r.applied });
    if (r.wrecked) this.wreck(victim, attackerId);
  }

  private wreck(victim: CarSim, attackerId: string | null): void {
    const p = victim.physics.curr.p;
    tmpV.x = p.x;
    tmpV.y = p.y + 0.8;
    tmpV.z = p.z;
    this.d.fx?.explosion(tmpV, 5);
    this.d.events.emit('explosion', { pos: { x: tmpV.x, y: tmpV.y, z: tmpV.z }, radius: 6 });
    this.d.events.emit('carWrecked', { carId: victim.id, attackerId });
    victim.freeze();
    const atk = attackerId === null ? undefined : this.d.cars().find((c) => c.id === attackerId);
    if (!atk || atk === victim) return;
    atk.score += WEAPONS.wreck.takedownScore;
    atk.takedowns++;
    atk.physics.nitro.add(WEAPONS.wreck.takedownNitroBars);
    this.d.events.emit('nitroBarEarned', { carId: atk.id, source: 'takedown' });
  }

  private collectPickups(car: CarSim): void {
    const p = car.physics.curr.p;
    const r2 = COMBAT.pickupRadiusM * COMBAT.pickupRadiusM;
    for (const def of this.d.pickupDefs) {
      if (!this.field.isAvailable(def.id)) continue;
      const pp = this.d.pickupPositions[def.id];
      const dx = pp.x - p.x;
      const dz = pp.z - p.z;
      if (dx * dx + dz * dz > r2 || Math.abs(pp.y - p.y) > 3) continue;
      const type = this.field.take(def.id);
      if (!type) continue;
      const g = grantFor(type, this.grants);
      if (g.rockets) car.ammo.add(g.rockets);
      if (g.hp) car.hull.heal(g.hp);
      if (g.nitroBars) {
        car.physics.nitro.add(g.nitroBars);
        this.d.events.emit('nitroBarEarned', { carId: car.id, source: 'pickup' });
      }
      this.d.events.emit('pickupTaken', { carId: car.id, kind: type, pos: { x: pp.x, y: pp.y, z: pp.z } });
    }
  }

  private damageFx(car: CarSim, dt: number): void {
    const s = car.hull.state;
    if (s !== 'smoke' && s !== 'fire') return;
    const t = (this.fxTimer.get(car.id) ?? 0) - dt;
    if (t > 0) {
      this.fxTimer.set(car.id, t);
      return;
    }
    const fire = s === 'fire';
    this.fxTimer.set(car.id, fire ? COMBAT.damageFx.fireIntervalSec : COMBAT.damageFx.smokeIntervalSec);
    const { p, q } = car.physics.curr;
    rotate(0, 0.9, 1.2, q, tmpV);
    tmpV.x += p.x;
    tmpV.y += p.y;
    tmpV.z += p.z;
    this.d.fx?.damageSmoke(tmpV, fire);
  }

  private setRay(o: V3, dir: V3): void {
    this.ray.origin.x = o.x;
    this.ray.origin.y = o.y;
    this.ray.origin.z = o.z;
    this.ray.dir.x = dir.x;
    this.ray.dir.y = dir.y;
    this.ray.dir.z = dir.z;
  }
}
