import type RAPIER from '@dimforge/rapier3d-compat';
import { WEAPONS, type CarDef, type HandlingDef } from '../core/Data';
import type { EventBus } from '../core/Events';
import { Hull, type HullConfig } from '../combat/Damage';
import { PulseGun, type PulseCfg } from '../combat/PulseMG';
import { RocketAmmo } from '../combat/Rockets';
import { CarPhysics, IDLE_CONTROLS, type CarControls } from '../vehicle/CarPhysics';

export interface CarController {
  read(): CarControls;
}

export type CarKind = 'player' | 'ai' | 'dummy';

/** Shared between the car (written by combat) and its visual (read each frame). */
export interface TurretAim {
  /** Requested gun-mount yaw in radians, + = towards the car's left. */
  yawRad: number;
  /** Seconds left to keep that yaw before the turret returns to centre. */
  holdSec: number;
}

export interface CarSimOptions {
  id: string;
  kind: CarKind;
  R: typeof RAPIER;
  world: RAPIER.World;
  def: CarDef;
  handling: HandlingDef;
  controller: CarController;
  events: EventBus;
  spawn: { x: number; y: number; z: number; yaw: number };
}

/** The Pulse MG tuned for one vehicle: fast cars overheat sooner, slow ones run cooler. */
export function gunConfig(def: CarDef): PulseCfg {
  const c = WEAPONS.pulse_mg;
  return { ...c, heatPerShot: c.heatPerShot * def.gunHeatMul };
}

/**
 * Player and AI cars are the same class; only the controller differs. No rendering: the browser's `Car` adds a visual,
 * the server uses this directly.
 */
export class CarSim {
  readonly id: string;
  readonly kind: CarKind;
  readonly def: CarDef;
  readonly physics: CarPhysics;
  hull: Hull;
  gun: PulseGun;
  ammo = new RocketAmmo();
  private readonly hullCfg: HullConfig;
  /** Gun-mount yaw requested by combat (radians, + = left) and how long to hold it after the last shot. */
  readonly aim: TurretAim = { yawRad: 0, holdSec: 0 };
  score = 0;
  takedowns = 0;
  /** True inside a no-fire zone: the trigger does nothing (set by the game from the track's `noFireZones`). */
  weaponsLocked = false;
  /** Controls actually applied this step (idle while wrecked). */
  controls: CarControls = { ...IDLE_CONTROLS };
  private nitroWhole = 0;
  private readonly controller: CarController;
  private readonly events: EventBus;

  constructor(o: CarSimOptions) {
    this.id = o.id;
    this.kind = o.kind;
    this.def = o.def;
    this.gun = new PulseGun(gunConfig(o.def));
    this.controller = o.controller;
    this.events = o.events;
    this.physics = new CarPhysics(o.R, o.world, o.def, o.handling, o.spawn);
    this.hullCfg = {
      maxHp: o.def.hp,
      respawnDelaySec: WEAPONS.wreck.respawnDelaySec,
      invulnerableSec: WEAPONS.wreck.invulnerableSec,
      smokeBelow: WEAPONS.damageStates[0].above,
      fireBelow: WEAPONS.damageStates[1].above,
    };
    this.hull = new Hull(this.hullCfg);
  }

  /** Fixed-step update, before world.step(). Wrecked cars are frozen. */
  preStep(dt: number): void {
    const c = this.controller.read(); // always read: gamepad edge detection happens inside
    if (this.hull.wrecked) {
      this.controls = { ...IDLE_CONTROLS };
      return;
    }
    this.controls = this.weaponsLocked ? { ...c, fire: false, fireSecondary: false } : c;
    this.physics.preStep(dt, this.controls);
  }

  postStep(): void {
    if (this.hull.wrecked) return;
    this.physics.postStep();
    const whole = Math.floor(this.physics.nitro.bars);
    if (whole > this.nitroWhole) this.events.emit('nitroBarEarned', { carId: this.id, source: 'drift' });
    this.nitroWhole = whole;
  }

  /** Fresh hull, gun, rockets, score and nitro (race restart). */
  resetCombat(): void {
    this.hull = new Hull(this.hullCfg);
    this.gun = new PulseGun(gunConfig(this.def));
    this.ammo = new RocketAmmo();
    this.score = 0;
    this.takedowns = 0;
    this.physics.nitro.bars = 0;
    this.physics.nitro.active = false;
  }

  /** Remove from play until respawn: hidden and physically disabled. */
  freeze(): void {
    this.physics.body.setEnabled(false);
    this.onFreeze();
  }

  /** A frozen (wrecked) car comes back without moving it: a puppet follows its snapshot pose by itself. */
  unfreeze(): void {
    this.physics.body.setEnabled(true);
    this.onRespawn();
  }

  /** Subclass hook: hide the car's visual. */
  protected onFreeze(): void {}

  /** Subclass hook: show the car's visual. */
  protected onRespawn(): void {}

  /** Put the car upright at a track pose (checkpoint respawn or grid slot). */
  respawn(pose: { x: number; y?: number; z: number; yaw: number }): void {
    this.physics.body.setEnabled(true);
    this.physics.reset(pose.x, pose.z, pose.yaw, pose.y ?? 0);
    this.onRespawn();
    this.events.emit('carReset', { carId: this.id });
  }

  dispose(): void {
    this.physics.dispose();
  }
}
