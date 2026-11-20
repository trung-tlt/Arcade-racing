import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { COMBAT, WEAPONS } from '../core/Data';
import { userSettings } from '../core/Settings';
import type { EventBus } from '../core/Events';
import type { Particles } from '../fx/Particles';
import type { Tracers } from '../fx/Tracers';
import type { Car } from '../vehicle/Car';
import { turretYaw } from '../vehicle/Turret';
import { type AimTarget, pickAimTarget } from './AutoAim';
import { PickupField, type PickupDef, type PickupType, grantFor } from './Pickups';
import type { PickupVisuals } from './PickupVisuals';
import { RocketPool } from './RocketPool';
import { splashDamage } from './Rockets';

type Rapier = typeof RAPIER;

export interface CombatDeps {
  R: Rapier;
  world: RAPIER.World;
  scene: THREE.Scene;
  assets: Assets;
  events: EventBus;
  particles: Particles;
  tracers: Tracers;
  cars: () => readonly Car[];
  /** Where a wrecked car comes back (checkpoint pose / its own spawn). */
  respawnPoseFor: (car: Car) => { x: number; z: number; yaw: number };
  pickupDefs: readonly PickupDef[];
  pickupVisuals: PickupVisuals;
}

const PICKUP_TYPES = Object.keys(WEAPONS.pickups) as PickupType[];
const origin = new THREE.Vector3();
const fwd = new THREE.Vector3();
const endPt = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const aimDir = new THREE.Vector3();

/** Glue for guns, rockets, pickups, damage states, wrecks and respawns. Gameplay rules live in the pure modules. */
export class CombatSystem {
  private readonly field: PickupField;
  private readonly rockets: RocketPool;
  private readonly ray: RAPIER.Ray;
  private readonly byCollider = new Map<number, Car>();
  private readonly aim = new Map<string, AimTarget>();
  private readonly aimList: AimTarget[] = [];
  private readonly prevSecondary = new Map<string, boolean>();
  private readonly fxTimer = new Map<string, number>();
  private time = 0;
  private readonly centre = new THREE.Vector3();

  constructor(private readonly d: CombatDeps) {
    const respawn = {} as Record<PickupType, number>;
    const grants = {} as Record<PickupType, Record<string, number>>;
    for (const k of PICKUP_TYPES) {
      respawn[k] = WEAPONS.pickups[k].respawnSec;
      grants[k] = WEAPONS.pickups[k].grants;
    }
    this.grants = grants;
    this.field = new PickupField(d.pickupDefs, respawn);
    this.rockets = new RocketPool(d.R, d.world, d.scene, d.assets, d.particles);
    this.ray = new d.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    for (const c of d.cars()) {
      this.byCollider.set(c.physics.collider.handle, c);
      this.aim.set(c.id, { id: c.id, pos: { x: 0, y: 0, z: 0 } });
    }
  }

  private readonly grants: Record<PickupType, Record<string, number>>;

  private readonly hints: { x: number; z: number; type: PickupType }[] = [];

  /** Currently available pickups (world x/z + type) for AI drivers. The array is reused between calls. */
  availablePickups(): readonly { x: number; z: number; type: PickupType }[] {
    this.hints.length = 0;
    for (const def of this.d.pickupDefs) {
      if (!this.field.isAvailable(def.id)) continue;
      const p = this.d.pickupVisuals.positions[def.id];
      this.hints.push({ x: p.x, z: p.z, type: def.type });
    }
    return this.hints;
  }

  update(dt: number): void {
    this.time += dt;
    const cars = this.d.cars();
    for (const car of cars) {
      if (car.hull.update(dt) === 'respawn') car.respawn(this.d.respawnPoseFor(car));
      if (car.hull.wrecked) continue;
      car.visual.root.visible = !car.hull.invulnerable || Math.floor(this.time * COMBAT.blinkHz * 2) % 2 === 0;
      this.refreshAim(cars);
      this.fireGun(car, dt);
      this.fireRocket(car);
      this.damageFx(car, dt);
      this.collectPickups(car);
    }
    this.field.update(dt);
    this.d.pickupVisuals.update(dt, this.field);
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
  private muzzle(car: Car, yaw = 0): void {
    const { p, q } = car.physics.curr;
    const gm = car.def.gunMount;
    const mo = COMBAT.muzzleOffset;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    tmpQ.set(q.x, q.y, q.z, q.w);
    origin
      .set(gm[0] + mo[0] * cos + mo[2] * sin, gm[1] + mo[1], gm[2] - mo[0] * sin + mo[2] * cos)
      .applyQuaternion(tmpQ)
      .add(tmpV.set(p.x, p.y, p.z));
    fwd.set(0, 0, 1).applyQuaternion(tmpQ);
  }

  /** Full-circle turrets (hauler, APC) search every direction; everything else keeps its soft cone. */
  private isFullTurret(car: Car): boolean {
    return car.def.turretYawDeg >= COMBAT.turret.fullTurretDeg;
  }

  /** Point the visual turret at `dir` (world) for a while; returns the yaw used. */
  private aimTurret(car: Car, dir: THREE.Vector3): number {
    const yaw = turretYaw(fwd, dir, car.def.turretYawDeg);
    car.aim.yawRad = yaw;
    car.aim.holdSec = COMBAT.turret.holdSec;
    return yaw;
  }

  private refreshAim(cars: readonly Car[]): void {
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
  private othersOf(self: Car): AimTarget[] {
    return this.aimList.filter((t) => t.id !== self.id);
  }

  private fireGun(car: Car, dt: number): void {
    const cfg = WEAPONS.pulse_mg;
    const shots = car.gun.update(dt, car.controls.fire, !car.physics.airborne);
    if (car.gun.justOverheated) {
      this.d.events.emit('gunOverheated', { carId: car.id, pos: car.physics.curr.p });
    }
    const full = this.isFullTurret(car);
    const assist = car.kind === 'player' && !userSettings.aimAssist ? 0 : full ? 180 : cfg.autoAimConeDeg;
    for (let i = 0; i < shots; i++) {
      this.muzzle(car);
      const aim = pickAimTarget(origin, fwd, this.othersOf(car), assist, cfg.rangeM);
      if (aim) aimDir.set(aim.dir.x, aim.dir.y, aim.dir.z);
      else aimDir.copy(fwd);
      // The mount turns toward the shot (within its limit); the muzzle follows it.
      const yaw = this.aimTurret(car, aimDir);
      this.muzzle(car, yaw);
      this.setRay(origin, aimDir);
      const hit = this.d.world.castRay(this.ray, cfg.rangeM, true, undefined, undefined, undefined, car.physics.body);
      const dist = hit ? hit.timeOfImpact : cfg.rangeM;
      endPt.copy(origin).addScaledVector(aimDir, dist);
      this.d.tracers.fire(origin, endPt);
      this.d.tracers.muzzleFlash(origin, aimDir);
      this.d.events.emit('gunFired', { carId: car.id, pos: origin });
      if (!hit) continue;
      this.d.particles.burst('spark', endPt, 3, 6, 0.25);
      const victim = this.byCollider.get(hit.collider.handle);
      if (victim && victim !== car) {
        this.applyDamage(victim, cfg.damage * car.def.gunDamageMul, car.id);
        car.physics.nitro.add(cfg.nitroGainOnHit);
      }
    }
  }

  private fireRocket(car: Car): void {
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
    if (full && aim) aimDir.set(aim.dir.x, aim.dir.y, aim.dir.z);
    else aimDir.copy(fwd);
    const yaw = full ? this.aimTurret(car, aimDir) : 0;
    this.muzzle(car, yaw);
    if (!this.rockets.launch(car.id, origin, aimDir, aim?.id ?? null)) return;
    car.ammo.consume();
    this.d.events.emit('rocketLaunched', { carId: car.id, pos: origin });
  }

  private carCentre(id: string): THREE.Vector3 | null {
    const c = this.d.cars().find((x) => x.id === id);
    if (!c || c.hull.wrecked) return null;
    const p = c.physics.curr.p;
    return this.centre.set(p.x, p.y + COMBAT.aimTargetHeightM, p.z);
  }

  private proximityFuse(pos: THREE.Vector3, owner: string, age: number): boolean {
    if (age < COMBAT.rocket.armSec) return false;
    for (const c of this.d.cars()) {
      if (c.hull.wrecked || c.id === owner) continue;
      const p = c.physics.curr.p;
      tmpV.set(p.x, p.y + COMBAT.aimTargetHeightM, p.z);
      if (tmpV.distanceTo(pos) < COMBAT.rocket.proximityM) return true;
    }
    return false;
  }

  private explode(pos: THREE.Vector3, owner: string): void {
    const cfg = WEAPONS.hornet_rocket;
    this.d.particles.explosion(pos, cfg.splashRadiusM);
    this.d.events.emit('explosion', { pos: { x: pos.x, y: pos.y, z: pos.z }, radius: cfg.splashRadiusM });
    for (const c of this.d.cars()) {
      if (c.hull.wrecked) continue;
      const p = c.physics.curr.p;
      tmpV.set(p.x, p.y + COMBAT.aimTargetHeightM, p.z);
      // Measure to the car's hull, not its centre, so a direct hit does full damage.
      const dist = Math.max(0, tmpV.distanceTo(pos) - c.def.collider.halfExtents[2] * 0.5);
      const dmg = splashDamage(cfg.damage, dist, cfg.splashRadiusM);
      if (dmg > 0) this.applyDamage(c, dmg, owner);
    }
  }

  /** Damage that isn't a weapon hit: a wall, or another car's bodywork. `attackerId` is null for scenery. */
  damageCar(victim: Car, amount: number, attackerId: string | null): void {
    this.applyDamage(victim, amount, attackerId);
  }

  private applyDamage(victim: Car, amount: number, attackerId: string | null): void {
    const r = victim.hull.damage(amount, attackerId);
    if (r.applied <= 0) return;
    this.d.events.emit('carHit', { carId: victim.id, attackerId, damage: r.applied });
    if (r.wrecked) this.wreck(victim, attackerId);
  }

  private wreck(victim: Car, attackerId: string | null): void {
    const p = victim.physics.curr.p;
    tmpV.set(p.x, p.y + 0.8, p.z);
    this.d.particles.explosion(tmpV, 5);
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

  private collectPickups(car: Car): void {
    const p = car.physics.curr.p;
    const r2 = COMBAT.pickupRadiusM * COMBAT.pickupRadiusM;
    for (const def of this.d.pickupDefs) {
      if (!this.field.isAvailable(def.id)) continue;
      const pp = this.d.pickupVisuals.positions[def.id];
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

  private damageFx(car: Car, dt: number): void {
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
    tmpQ.set(q.x, q.y, q.z, q.w);
    tmpV
      .set(0, 0.9, 1.2)
      .applyQuaternion(tmpQ)
      .add(origin.set(p.x, p.y, p.z));
    this.d.particles.spawn('smoke', tmpV, undefined, fire ? 1.2 : 0.9);
    if (fire) {
      this.d.particles.spawn('fire', tmpV, undefined, 0.8);
      this.d.particles.burst('spark', tmpV, 1, 5, 0.2);
    }
  }

  private setRay(o: THREE.Vector3, dir: THREE.Vector3): void {
    this.ray.origin.x = o.x;
    this.ray.origin.y = o.y;
    this.ray.origin.z = o.z;
    this.ray.dir.x = dir.x;
    this.ray.dir.y = dir.y;
    this.ray.dir.z = dir.z;
  }

  dispose(): void {
    this.rockets.dispose();
    this.d.pickupVisuals.dispose();
  }
}
