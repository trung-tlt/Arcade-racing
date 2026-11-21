import RAPIER from '@dimforge/rapier3d-compat';
import { AIDriver, type OtherCar } from '../ai/AIDriver';
import { RacingLine } from '../ai/RacingLine';
import { expandPickups } from '../combat/Pickups';
import { AI, HANDLING, RACE, getCarDef, getTrack, roadWidthAt, type TrackDef } from '../core/Data';
import { EventBus } from '../core/Events';
import { STEP } from '../core/Loop';
import { noFireZoneAt } from '../race/NoFire';
import { RaceManager } from '../race/RaceManager';
import { gridPose, respawnPose } from '../race/Respawn';
import { type CarRaceView, effectiveT, rankCars, rubberBandSignal } from '../race/Standings';
import { IDLE_CONTROLS, type CarControls } from '../vehicle/CarPhysics';
import { relaxTightBends } from '../world/relaxBends';
import { TrackPath } from '../world/TrackPath';
import { buildBaked } from './BakedColliders';
import { loadBaked } from './bakedNode';
import { CarSim } from './CarSim';
import { CatLaiYardSim } from './CatLaiYardSim';
import { CombatSim } from './CombatSim';
import { CongHoaTrafficSim } from './CongHoaTrafficSim';
import { HitRules } from './HitRules';
import { pickupPositions } from './pickupPositions';
import { PvdTrafficSim } from './PvdTrafficSim';
import { hasFallen, StuckWatch, upY } from './Recovery';
import { buildTrackColliders, computeTrackShape } from './TrackColliders';
import { XaLoTrafficSim } from './XaLoTrafficSim';

export type SlotKind = 'human' | 'ai' | 'pilot';

/** One car on the grid. `pilot` is the autopilot stand-in for a human (parity runs); `human` reads `setInput`. */
export interface SlotSpec {
  id: string;
  carId: string;
  kind: SlotKind;
  /** AI skill 0..1 (ai and pilot). */
  skill?: number;
  /** AI lane offset as authored for the reference road width (scaled to this map). Pilots always use 0. */
  laneOffsetM?: number;
  /** Grid slot (default: the spec's index). */
  gridSlot?: number;
}

export interface RaceSimOpts {
  trackId: string;
  laps: number;
  slots: SlotSpec[];
  /** Guns, rockets, pickups, wrecks and contact damage (default true). */
  combat?: boolean;
  /** Rivals never fire (the browser's `debugAiHoldFire`); pickups are still collected. */
  holdFire?: boolean;
  /** Ambient traffic (default true). */
  traffic?: boolean;
  /** Rebuild the baked scenery colliders (default true; skipped if the map has no bake). */
  scenery?: boolean;
}

let ready: Promise<void> | null = null;
/** Rapier's wasm must be initialised once per process. */
export function initSim(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

/** Same lane scaling as `Game.laneFor`: rival lane offsets are authored for the reference road width. */
function laneFor(def: TrackDef, offsetM: number): number {
  const width = Math.min(def.roadWidthM, ...def.widthProfile.map((p) => p.widthM));
  const half = width / 2 - 1.8;
  const laneW = def.roadWidthM / def.laneOffsetsM.length;
  const lowest = def.raw.truckQueue || def.raw.ambientTraffic ? -(def.roadWidthM / 2 - laneW - 2) : -half;
  return Math.max(lowest, Math.min(half, (offsetM * width) / RACE.ai.laneReferenceWidthM));
}

/** Same as `Game.centreRanges`: stretches where rivals hold the centre line. */
export function centreRanges(def: TrackDef): { fromT: number; toT: number }[] {
  const narrow = def.widthProfile.filter((p) => p.widthM < def.roadWidthM * 0.75);
  const sections = (def.raw.sections as { name: string; fromT: number; toT: number }[] | undefined) ?? [];
  return [...narrow, ...sections.filter((x) => /gate/i.test(x.name))].map((x) => ({ fromT: x.fromT, toT: x.toT }));
}

export interface SimEntry {
  readonly id: string;
  kind: SlotKind;
  readonly car: CarSim;
  readonly race: RaceManager;
  /** Along-track position t in [0, 1). */
  t: number;
  recoveries: number;
  driver: AIDriver | null;
  others: OtherCar[];
  lane: number;
  readonly stuck: StuckWatch;
  /** Latest controls received for a human car. */
  input: CarControls;
  resetRequested: boolean;
}

/**
 * One race on one Rapier world, stepped at 60 Hz: the same `CarSim`, `AIDriver`, `RaceManager`, `CombatSim` and
 * standings code the browser runs. No three.js, DOM or audio. Human cars are driven by `setInput`.
 */
export class RaceSim {
  readonly def: TrackDef;
  readonly path: TrackPath;
  readonly world: RAPIER.World;
  readonly events = new EventBus();
  readonly entries: SimEntry[] = [];
  readonly views: CarRaceView[] = [];
  /** Simulated seconds since the race was created. */
  time = 0;
  tick = 0;
  private readonly byId = new Map<string, SimEntry>();
  private readonly cars: CarSim[] = [];
  private readonly traffic: { update(dt: number): void; time: number }[] = [];
  private combat: CombatSim | null = null;
  private readonly hitRules: HitRules;
  private readonly sunkRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly holdFire: boolean;
  private readonly reference: () => SimEntry;
  private readonly line: RacingLine;

  /** Build a race. Call `initSim()` (or `await RaceSim.create`) first so Rapier's wasm is ready. */
  constructor(opts: RaceSimOpts) {
    const def = getTrack(opts.trackId);
    this.def = def;
    this.holdFire = opts.holdFire === true;
    const path = new TrackPath(
      relaxTightBends(def.spline.points, RACE.track.minTurnRadiusM),
      RACE.track.sampleSpacingM,
      RACE.track.projectWindowSamples,
    );
    this.path = path;
    const line = new RacingLine(path, RACE.track.sampleSpacingM);
    this.line = line;
    const world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
    world.timestep = STEP;
    this.world = world;
    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, (def.groundY ?? 0) - 0.5, 0));
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setFriction(HANDLING.world.groundFriction),
      ground,
    );
    buildTrackColliders(RAPIER, world, def, path, computeTrackShape(def, path));
    const baked = opts.scenery === false ? null : loadBaked(def.id);
    if (baked) buildBaked(RAPIER, world, baked);
    if (opts.traffic !== false) {
      if (def.id === 'xa_lo_ha_noi') this.traffic.push(new XaLoTrafficSim(RAPIER, world, def, path));
      if (def.id === 'cat_lai') this.traffic.push(new CatLaiYardSim(RAPIER, world, def, path));
      if (def.id === 'cong_hoa') this.traffic.push(new CongHoaTrafficSim(RAPIER, world, def, path));
      if (def.id === 'pham_van_dong') this.traffic.push(new PvdTrafficSim(RAPIER, world, def, path));
    }

    const events = this.events;
    // Rivals are balanced against the first human (or the autopilot standing in for one), else the first car.
    this.reference = () =>
      this.entries.find((e) => e.kind === 'human') ??
      this.entries.find((e) => e.kind === 'pilot') ??
      (this.entries[0] as SimEntry);
    const pickupDefs = expandPickups(def.pickups);
    const pickupPos = pickupPositions(pickupDefs, path, def);

    opts.slots.forEach((sp, index) => {
      const carDef = getCarDef(sp.carId);
      const [lateral, behind] = def.startLine.grid[sp.gridSlot ?? index];
      const g = gridPose(path, lateral, Math.abs(behind), path.lengthM);
      const lane = sp.kind === 'ai' ? laneFor(def, sp.laneOffsetM ?? 0) : 0;
      const race = new RaceManager(
        {
          carId: sp.id,
          totalLaps: opts.laps,
          checkpointTs: def.checkpoints.map((k) => k.t),
          countdownSteps: RACE.countdown.steps,
          countdownStepSec: RACE.countdown.stepSec,
          goHoldSec: RACE.countdown.goHoldSec,
        },
        events,
      );
      const entry: SimEntry = {
        id: sp.id,
        kind: sp.kind,
        car: null as unknown as CarSim,
        race,
        t: 0,
        recoveries: 0,
        driver: null,
        others: [],
        lane,
        stuck: new StuckWatch(),
        input: { ...IDLE_CONTROLS },
        resetRequested: false,
      };
      const car = new CarSim({
        id: sp.id,
        kind: sp.kind === 'ai' ? 'ai' : 'player',
        R: RAPIER,
        world,
        def: carDef,
        handling: HANDLING,
        controller: { read: () => this.controlsOf(entry) },
        events,
        spawn: { x: g.x, y: g.y + 0.4, z: g.z, yaw: g.yaw },
      });
      (entry as { car: CarSim }).car = car;
      if (sp.kind !== 'human') entry.driver = this.makeDriver(entry, sp.kind === 'pilot', sp.skill ?? 0.9);
      this.entries.push(entry);
      this.cars.push(car);
      this.byId.set(sp.id, entry);
    });
    for (const e of this.entries) {
      e.t = path.project(e.car.physics.curr.p.x, e.car.physics.curr.p.z);
      e.race.restart(e.t);
      e.others = this.entries.filter((o) => o !== e).map((o) => ({ id: o.id, x: 0, y: 0, z: 0, wrecked: false }));
      this.views.push({
        id: e.id,
        lap: 1,
        t: e.t,
        nextGateT: 0,
        checkpointsPassed: 0,
        finished: false,
        finishTimeSec: null,
      });
    }
    this.hitRules = new HitRules(!!(def.raw.barriers as { armco?: unknown } | undefined)?.armco);
    if (opts.combat !== false) {
      this.combat = new CombatSim({
        R: RAPIER,
        world,
        events,
        cars: () => this.cars,
        respawnPoseFor: (car) => {
          const e = this.byId.get(car.id) as SimEntry;
          return respawnPose(path, e.race.respawnT, e.lane);
        },
        pickupDefs,
        pickupPositions: pickupPos,
      });
    }
  }

  static async create(opts: RaceSimOpts): Promise<RaceSim> {
    await initSim();
    return new RaceSim(opts);
  }

  private progressOf(e: SimEntry): number {
    return (
      e.race.laps.lap +
      effectiveT({ lap: e.race.laps.lap, t: e.race.progressT, checkpointsPassed: e.race.laps.nextCheckpoint })
    );
  }

  /** An AI driver for one car: the rivals' racing-line driver, or (`pilot`) the stripped autopilot used for parity runs. */
  private makeDriver(entry: SimEntry, pilot: boolean, skill: number): AIDriver {
    const def = this.def;
    const car = entry.car;
    const phys = car.physics;
    const carDef = car.def;
    return new AIDriver({
      carId: entry.id,
      line: this.line,
      laneOffsetM: entry.lane,
      centreRanges: centreRanges(def),
      halfWidthAt: (t) => roadWidthAt(def, t) / 2,
      skill,
      difficulty: 'normal',
      handling: carDef.handling,
      topSpeedMps: carDef.topSpeedKmh / 3.6,
      self: () => ({
        x: phys.curr.p.x,
        z: phys.curr.p.z,
        yaw: phys.yaw,
        forwardSpeed: phys.forwardSpeed,
        lateralSpeed: phys.lateralSpeed,
        t: entry.t,
        nitroBars: phys.nitro.bars,
        airborne: phys.airborne,
        ...(pilot ? { locked: entry.race.controlsLocked } : {}),
      }),
      others: () => (pilot ? [] : entry.others),
      pickups: () => (pilot || !this.combat ? [] : this.combat.availablePickups()),
      rubberBand: () =>
        pilot
          ? 0
          : rubberBandSignal(this.progressOf(entry), this.progressOf(this.reference()), RACE.ai.rubberBandScaleLaps),
      rocketAmmo: () => (pilot ? 0 : car.ammo.count),
      hullFraction: () => car.hull.fraction,
    });
  }

  /** A human left mid-race: their car now follows the racing line like a rival (v1 disconnect rule). */
  handToAI(id: string, skill = 0.9): void {
    const e = this.byId.get(id);
    if (!e || e.kind !== 'human') return;
    e.kind = 'ai';
    e.lane = 0;
    e.driver = this.makeDriver(e, false, skill);
  }

  entry(id: string): SimEntry | undefined {
    return this.byId.get(id);
  }

  /** The latest controls from a human's client (already validated and clamped by the caller). */
  setInput(id: string, controls: CarControls): void {
    const e = this.byId.get(id);
    if (e && e.kind === 'human') e.input = controls;
  }

  /** A human asked to be put back on the track at their last checkpoint (executed on the next step). */
  requestReset(id: string): void {
    const e = this.byId.get(id);
    if (e) e.resetRequested = true;
  }

  /** Put every ambient-traffic clock at `timeSec` (a client keeps its local traffic in step with the server's). */
  setTrafficTime(timeSec: number): void {
    for (const t of this.traffic) t.time = timeSec;
  }

  /** Every car has taken the flag. */
  get finished(): boolean {
    return this.entries.every((e) => e.race.phase === 'finished');
  }

  /** Same as `Game.aiControls` (and the player autopilot): idle on the grid, brake after the flag, hold fire early. */
  private controlsOf(e: SimEntry): CarControls {
    if (e.race.controlsLocked) return IDLE_CONTROLS;
    if (e.kind === 'human') {
      return e.race.phase === 'finished' ? { ...IDLE_CONTROLS, brake: RACE.ai.finishedCoastBrake } : e.input;
    }
    const driver = e.driver as AIDriver;
    if (e.kind === 'pilot') return { ...driver.read() };
    if (e.race.phase === 'finished') return { ...IDLE_CONTROLS, brake: RACE.ai.finishedCoastBrake };
    const c = driver.read();
    if (this.holdFire || e.race.timeSec < RACE.ai.holdFireSec) return { ...c, fire: false, fireSecondary: false };
    return c;
  }

  /** Advance the whole race by one fixed 60 Hz step (same order as `Game.step`). */
  step(): void {
    const { def, path, world } = this;
    const zones = def.noFireZones;
    if (zones.length > 0) for (const e of this.entries) e.car.weaponsLocked = noFireZoneAt(zones, e.t) !== null;
    for (const e of this.entries) {
      if (e.resetRequested) {
        e.resetRequested = false;
        if (!e.car.hull.wrecked && e.race.phase !== 'finished') e.car.respawn(respawnPose(path, e.race.respawnT, 0));
      }
    }
    for (const e of this.entries) e.car.preStep(STEP);
    world.step();
    for (const e of this.entries) e.car.postStep();
    if (this.combat) {
      const combat = this.combat;
      this.hitRules.apply(STEP, this.cars, (v, amount, by) => combat.damageCar(v, amount, by));
      combat.update(STEP);
    }
    for (const tr of this.traffic) tr.update(STEP);
    // Humans (and the autopilot) are recovered from a fall (as in `Game.recoverFallen`); rivals when stuck.
    for (const e of this.entries) {
      if (e.kind === 'ai' || e.race.phase === 'finished' || e.car.hull.wrecked) continue;
      const p = e.car.physics.curr.p;
      const fell = hasFallen(
        {
          hasElevation: def.hasElevation,
          groundY: def.groundY ?? 0,
          x: p.x,
          y: p.y,
          z: p.z,
          speedMps: e.car.physics.speedMps,
          roadY: path.pointAt(e.t).y,
        },
        world,
        RAPIER,
        this.sunkRay,
      );
      if (fell) {
        e.car.respawn(respawnPose(path, e.t, 0));
        e.recoveries++;
      }
    }
    for (const e of this.entries) {
      if (e.kind !== 'ai' || e.car.hull.wrecked || e.race.phase !== 'racing' || e.race.timeSec < AI.recovery.graceSec)
        continue;
      if (!e.stuck.update(STEP, e.t, upY(e.car.physics.curr.q), path.lengthM)) continue;
      e.car.respawn(respawnPose(path, e.t + AI.recovery.stepAheadM / path.lengthM, e.lane));
      e.recoveries++;
    }
    this.entries.forEach((e, i) => {
      e.t = path.project(e.car.physics.curr.p.x, e.car.physics.curr.p.z, e.t);
      e.race.update(STEP, e.t);
      const v = this.views[i];
      v.lap = e.race.laps.lap;
      v.t = e.t;
      v.nextGateT = e.race.nextGateT;
      v.checkpointsPassed = e.race.laps.nextCheckpoint;
      v.finished = e.race.phase === 'finished';
      v.finishTimeSec = e.race.finishTimeSec;
      for (const o of e.others) {
        const oc = (this.byId.get(o.id) as SimEntry).car;
        o.x = oc.physics.curr.p.x;
        o.y = oc.physics.curr.p.y;
        o.z = oc.physics.curr.p.z;
        o.wrecked = oc.hull.wrecked;
      }
    });
    this.tick++;
    this.time += STEP;
  }

  /** Car ids, first to last. */
  ranking(): string[] {
    return rankCars(this.views);
  }

  /** Dispose the Rapier world. */
  dispose(): void {
    this.world.free();
  }
}
