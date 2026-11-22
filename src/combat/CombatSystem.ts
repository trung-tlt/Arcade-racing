import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { userSettings } from '../core/Settings';
import type { EventBus } from '../core/Events';
import type { Particles } from '../fx/Particles';
import type { Tracers } from '../fx/Tracers';
import { CombatSim, type CombatFx } from '../sim/CombatSim';
import type { CarSim } from '../sim/CarSim';
import type { Car } from '../vehicle/Car';
import type { V3 } from './AutoAim';
import { PickupField, type PickupDef, type PickupType } from './Pickups';
import type { PickupVisuals } from './PickupVisuals';
import { RocketPool } from './RocketPool';

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
  /** First-person view: where this car's tracers start instead of its gun muzzle (false = use the muzzle). */
  tracerOrigin?: (car: Car, out: THREE.Vector3) => boolean;
  /** Online: the server runs the combat; this only draws its rockets, pickups and damage smoke. */
  remote?: boolean;
}

/** Pickup availability as the server last said it. */
class RemotePickupField extends PickupField {
  readonly taken = new Set<number>();

  override isAvailable(id: number): boolean {
    return !this.taken.has(id);
  }
}

const from = new THREE.Vector3();
const to = new THREE.Vector3();
const dir = new THREE.Vector3();
const at = new THREE.Vector3();

/** Browser glue around `CombatSim`: tracers, particles, rocket models and pickup cubes. Gameplay lives in the sim. */
export class CombatSystem {
  private readonly sim: CombatSim;
  private readonly rockets: RocketPool;
  private remoteField: RemotePickupField | null = null;
  private remoteRockets: { i: number; owner: string; p: V3; d: V3 }[] = [];
  private rocketsShown = new Set<number>();

  constructor(private readonly d: CombatDeps) {
    this.rockets = new RocketPool(d.scene, d.assets, d.particles);
    const fx: CombatFx = {
      tracer: (car, o, end) => {
        const start = d.tracerOrigin?.(car as Car, from) ? from : from.set(o.x, o.y, o.z);
        d.tracers.fire(start, to.set(end.x, end.y, end.z));
      },
      muzzleFlash: (o, v) => d.tracers.muzzleFlash(from.set(o.x, o.y, o.z), dir.set(v.x, v.y, v.z)),
      sparks: (p, count, speed, size) => d.particles.burst('spark', at.set(p.x, p.y, p.z), count, speed, size),
      explosion: (p, radius) => d.particles.explosion(at.set(p.x, p.y, p.z), radius),
      carVisible: (car, visible) => {
        (car as Car).visual.root.visible = visible;
      },
      damageSmoke: (p, fire) => {
        at.set(p.x, p.y, p.z);
        d.particles.spawn('smoke', at, undefined, fire ? 1.2 : 0.9);
        if (fire) {
          d.particles.spawn('fire', at, undefined, 0.8);
          d.particles.burst('spark', at, 1, 5, 0.2);
        }
      },
      show: (slot, on) => this.rockets.show(slot, on),
      pose: (slot, p, v) => this.rockets.pose(slot, p, v),
      trail: (p) => this.rockets.trail(p),
    };
    this.sim = new CombatSim({
      R: d.R,
      world: d.world,
      events: d.events,
      cars: d.cars,
      respawnPoseFor: (car: CarSim) => d.respawnPoseFor(car as Car),
      pickupDefs: d.pickupDefs,
      pickupPositions: d.pickupVisuals.positions,
      aimAssistFor: (car) => !(car.kind === 'player' && !userSettings.aimAssist),
      fx,
    });
  }

  /** Currently available pickups (world x/z + type) for AI drivers. The array is reused between calls. */
  availablePickups(): readonly { x: number; z: number; type: PickupType }[] {
    return this.sim.availablePickups();
  }

  /** Rockets in flight, for the incoming-rocket warning. */
  forEachRocket(cb: (owner: string, pos: V3, dir: V3) => void): void {
    if (this.d.remote) for (const r of this.remoteRockets) cb(r.owner, r.p, r.d);
    else this.sim.forEachRocket(cb);
  }

  /** Online: the server's rockets in flight (already extrapolated to now) and the pickups it says are taken. */
  setRemoteState(rockets: { i: number; owner: string; p: V3; d: V3 }[], taken: readonly number[]): void {
    this.remoteRockets = rockets;
    const field = (this.remoteField ??= new RemotePickupField(this.d.pickupDefs, { rocket: 0, repair: 0, nitro: 0 }));
    field.taken.clear();
    for (const id of taken) field.taken.add(id);
  }

  update(dt: number): void {
    if (this.d.remote) {
      this.sim.effects(dt);
      const live = new Set<number>();
      for (const r of this.remoteRockets) {
        this.rockets.pose(r.i, r.p, r.d);
        if (!this.rocketsShown.has(r.i)) this.rockets.show(r.i, true);
        live.add(r.i);
      }
      for (const i of this.rocketsShown) if (!live.has(i)) this.rockets.show(i, false);
      this.rocketsShown = live;
      if (this.remoteField) this.d.pickupVisuals.update(dt, this.remoteField);
      return;
    }
    this.sim.update(dt);
    this.d.pickupVisuals.update(dt, this.sim.field);
  }

  /** Damage that isn't a weapon hit: a wall, or another car's bodywork. `attackerId` is null for scenery. */
  damageCar(victim: Car, amount: number, attackerId: string | null): void {
    this.sim.damageCar(victim, amount, attackerId);
  }

  dispose(): void {
    this.rockets.dispose();
    this.d.pickupVisuals.dispose();
  }
}
