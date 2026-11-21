import RAPIER from '@dimforge/rapier3d-compat';
import { AIDriver, type OtherCar } from '../ai/AIDriver';
import { RacingLine } from '../ai/RacingLine';
import { AI, HANDLING, RACE, getCarDef, getTrack, roadWidthAt, type TrackDef } from '../core/Data';
import { EventBus } from '../core/Events';
import { STEP } from '../core/Loop';
import { RaceManager } from '../race/RaceManager';
import { gridPose, respawnPose } from '../race/Respawn';
import { type CarRaceView, effectiveT, rankCars, rubberBandSignal } from '../race/Standings';
import { IDLE_CONTROLS } from '../vehicle/CarPhysics';
import { expandPickups } from '../combat/Pickups';
import { noFireZoneAt } from '../race/NoFire';
import { relaxTightBends } from '../world/relaxBends';
import { TrackPath } from '../world/TrackPath';
import { buildBaked } from './BakedColliders';
import { loadBaked } from './bakedNode';
import { CatLaiYardSim } from './CatLaiYardSim';
import { CongHoaTrafficSim } from './CongHoaTrafficSim';
import { PvdTrafficSim } from './PvdTrafficSim';
import { XaLoTrafficSim } from './XaLoTrafficSim';
import { CarSim } from './CarSim';
import { CombatSim } from './CombatSim';
import { HitRules } from './HitRules';
import { pickupPositions } from './pickupPositions';
import { hasFallen, StuckWatch, upY } from './Recovery';
import { buildTrackColliders, computeTrackShape } from './TrackColliders';

export interface HeadlessRaceOpts {
  trackId: string;
  laps: number;
  /** Cars on the grid: the autopilot player plus the first `cars - 1` rivals in `data/ai.json` (default 6). */
  cars?: number;
  /** The autopilot player's vehicle (default kestrel_gt). */
  playerCar?: string;
  /** Guns, rockets, pickups, wrecks and contact damage (default true). */
  combat?: boolean;
  /** Rivals never fire (the browser's `debugAiHoldFire`); pickups are still collected. */
  holdFire?: boolean;
  /** Ambient traffic (default true). */
  traffic?: boolean;
  /** Rebuild the baked scenery colliders (default true; skipped if the map has no bake). */
  scenery?: boolean;
  /** Safety stop in simulated seconds. */
  maxSec?: number;
}

export interface HeadlessRaceResult {
  /** Car ids, first to last. */
  order: string[];
  /** Finish time per car in seconds (null = did not finish). */
  finishSec: Record<string, number | null>;
  /** Fastest lap per car in seconds (null = none completed). */
  bestLapSec: Record<string, number | null>;
  /** Times each car was put back on the road (stuck, flipped or fallen). */
  recoveries: Record<string, number>;
  /** Wrecks suffered / takedowns scored per car (combat on). */
  wrecks: Record<string, number>;
  takedowns: Record<string, number>;
  simSec: number;
  steps: number;
  /** Wall-clock ms spent in one fixed step (all cars + world.step), per step. */
  stepMs: number[];
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
function centreRanges(def: TrackDef): { fromT: number; toT: number }[] {
  const narrow = def.widthProfile.filter((p) => p.widthM < def.roadWidthM * 0.75);
  const sections = (def.raw.sections as { name: string; fromT: number; toT: number }[] | undefined) ?? [];
  return [...narrow, ...sections.filter((x) => /gate/i.test(x.name))].map((x) => ({ fromT: x.fromT, toT: x.toT }));
}

interface Entry {
  id: string;
  car: CarSim;
  race: RaceManager;
  t: number;
  driver: AIDriver;
  others: OtherCar[];
  lane: number;
  stuck: StuckWatch;
  recoveries: number;
  pilot: boolean;
}

/**
 * An AI-only race with no three.js, DOM or audio: the same `CarSim`, `AIDriver`, `RaceManager`, `CombatSim` and
 * standings code the browser runs, on the same colliders, traffic and pickups. No weather yet.
 */
export async function runHeadlessRace(opts: HeadlessRaceOpts): Promise<HeadlessRaceResult> {
  await initSim();
  const def = getTrack(opts.trackId);
  const count = opts.cars ?? 6;
  const combatOn = opts.combat !== false;
  const path = new TrackPath(
    relaxTightBends(def.spline.points, RACE.track.minTurnRadiusM),
    RACE.track.sampleSpacingM,
    RACE.track.projectWindowSamples,
  );
  const line = new RacingLine(path, RACE.track.sampleSpacingM);
  const world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
  world.timestep = STEP;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, (def.groundY ?? 0) - 0.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setFriction(HANDLING.world.groundFriction), ground);
  buildTrackColliders(RAPIER, world, def, path, computeTrackShape(def, path));
  const baked = opts.scenery === false ? null : loadBaked(def.id);
  if (baked) buildBaked(RAPIER, world, baked);
  const traffic: { update(dt: number): void }[] = [];
  if (opts.traffic !== false && def.id === 'xa_lo_ha_noi') traffic.push(new XaLoTrafficSim(RAPIER, world, def, path));
  if (opts.traffic !== false && def.id === 'cat_lai') traffic.push(new CatLaiYardSim(RAPIER, world, def, path));
  if (opts.traffic !== false && def.id === 'cong_hoa') traffic.push(new CongHoaTrafficSim(RAPIER, world, def, path));
  if (opts.traffic !== false && def.id === 'pham_van_dong') traffic.push(new PvdTrafficSim(RAPIER, world, def, path));

  const events = new EventBus();
  const entries: Entry[] = [];
  const views: CarRaceView[] = [];
  const byId = new Map<string, Entry>();
  const progress = (e: Entry): number =>
    e.race.laps.lap +
    effectiveT({ lap: e.race.laps.lap, t: e.race.progressT, checkpointsPassed: e.race.laps.nextCheckpoint });
  const player = (): Entry => byId.get('player') as Entry;
  const pickupDefs = expandPickups(def.pickups);
  const pickupPos = pickupPositions(pickupDefs, path, def);
  let combat: CombatSim | null = null;
  const holdFire = opts.holdFire === true;

  /** Same as `Game.aiControls` (and the player autopilot): idle on the grid, brake after the flag, hold fire early. */
  const controlsOf = (e: Entry): ReturnType<AIDriver['read']> => {
    if (e.race.controlsLocked) return IDLE_CONTROLS;
    if (e.pilot) return { ...e.driver.read() };
    if (e.race.phase === 'finished') return { ...IDLE_CONTROLS, brake: RACE.ai.finishedCoastBrake };
    const c = e.driver.read();
    if (holdFire || e.race.timeSec < RACE.ai.holdFireSec) return { ...c, fire: false, fireSecondary: false };
    return c;
  };

  // Same layout as `Game`: the player (here an autopilot, like `debugAutopilot`) on its grid slot, rivals on the rest.
  const playerSlot = RACE.ai.playerGridSlot;
  const free = Array.from({ length: RACE.track.gridSlotCount }, (_, i) => i).filter((i) => i !== playerSlot);
  const specs = [
    { id: 'player', car: opts.playerCar ?? 'kestrel_gt', lane: 0, skill: 0.9, slot: playerSlot, pilot: true },
    ...AI.rivals.slice(0, count - 1).map((r, i) => ({
      id: r.id,
      car: r.car,
      lane: laneFor(def, r.laneOffsetM),
      skill: r.skill,
      slot: free[i],
      pilot: false,
    })),
  ];
  for (const sp of specs) {
    const { id, lane, slot } = sp;
    const carDef = getCarDef(sp.car);
    const [lateral, behind] = def.startLine.grid[slot];
    const g = gridPose(path, lateral, Math.abs(behind), path.lengthM);
    const entry: Entry = {
      id,
      car: null as unknown as CarSim,
      race: new RaceManager(
        {
          carId: id,
          totalLaps: opts.laps,
          checkpointTs: def.checkpoints.map((k) => k.t),
          countdownSteps: RACE.countdown.steps,
          countdownStepSec: RACE.countdown.stepSec,
          goHoldSec: RACE.countdown.goHoldSec,
        },
        events,
      ),
      t: 0,
      driver: null as unknown as AIDriver,
      others: [],
      lane,
      stuck: new StuckWatch(),
      recoveries: 0,
      pilot: sp.pilot,
    };
    const car = new CarSim({
      id,
      kind: sp.pilot ? 'player' : 'ai',
      R: RAPIER,
      world,
      def: carDef,
      handling: HANDLING,
      controller: { read: () => controlsOf(entry) },
      events,
      spawn: { x: g.x, y: g.y + 0.4, z: g.z, yaw: g.yaw },
    });
    entry.car = car;
    const phys = car.physics;
    entry.driver = new AIDriver({
      carId: id,
      line,
      laneOffsetM: lane,
      centreRanges: centreRanges(def),
      halfWidthAt: (t) => roadWidthAt(def, t) / 2,
      skill: sp.skill,
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
        ...(sp.pilot ? { locked: entry.race.controlsLocked } : {}),
      }),
      others: () => (sp.pilot ? [] : entry.others),
      pickups: () => (sp.pilot || !combat ? [] : combat.availablePickups()),
      rubberBand: () =>
        sp.pilot ? 0 : rubberBandSignal(progress(entry), progress(player()), RACE.ai.rubberBandScaleLaps),
      rocketAmmo: () => (sp.pilot ? 0 : car.ammo.count),
      hullFraction: () => car.hull.fraction,
    });
    entries.push(entry);
    byId.set(id, entry);
  }
  for (const e of entries) {
    e.t = path.project(e.car.physics.curr.p.x, e.car.physics.curr.p.z);
    e.race.restart(e.t);
    e.others = entries.filter((o) => o !== e).map((o) => ({ id: o.id, x: 0, y: 0, z: 0, wrecked: false }));
    views.push({ id: e.id, lap: 1, t: e.t, nextGateT: 0, checkpointsPassed: 0, finished: false, finishTimeSec: null });
  }
  const hitRules = new HitRules(!!(def.raw.barriers as { armco?: unknown } | undefined)?.armco);
  if (combatOn) {
    combat = new CombatSim({
      R: RAPIER,
      world,
      events,
      cars: () => entries.map((e) => e.car),
      respawnPoseFor: (car) => {
        const e = byId.get(car.id) as Entry;
        return respawnPose(path, e.race.respawnT, e.lane);
      },
      pickupDefs,
      pickupPositions: pickupPos,
    });
  }

  const bestLap: Record<string, number | null> = Object.fromEntries(entries.map((e) => [e.id, null]));
  const wrecks: Record<string, number> = Object.fromEntries(entries.map((e) => [e.id, 0]));
  const takedowns: Record<string, number> = Object.fromEntries(entries.map((e) => [e.id, 0]));
  const lapStart = new Map<string, number>();
  events.on('lapComplete', (ev) => {
    const e = byId.get(ev.carId);
    if (!e) return;
    const since = lapStart.get(ev.carId) ?? 0;
    const lap = e.race.timeSec - since;
    lapStart.set(ev.carId, e.race.timeSec);
    const best = bestLap[ev.carId];
    if (best === null || lap < best) bestLap[ev.carId] = lap;
  });
  events.on('carWrecked', (ev) => {
    wrecks[ev.carId]++;
    if (ev.attackerId && ev.attackerId !== ev.carId) takedowns[ev.attackerId]++;
  });

  const maxSteps = Math.round((opts.maxSec ?? 900) / STEP);
  const stepMs: number[] = [];
  const sunkRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const cars = entries.map((e) => e.car);
  const zones = def.noFireZones;
  let step = 0;
  for (; step < maxSteps; step++) {
    const t0 = performance.now();
    if (zones.length > 0) for (const e of entries) e.car.weaponsLocked = noFireZoneAt(zones, e.t) !== null;
    for (const e of entries) e.car.preStep(STEP);
    world.step();
    for (const e of entries) e.car.postStep();
    if (combat) {
      hitRules.apply(STEP, cars, (v, amount, by) => combat?.damageCar(v, amount, by));
      combat.update(STEP);
    }
    for (const tr of traffic) tr.update(STEP);
    // Only the player is recovered from a fall (as in `Game.recoverFallen`); rivals are recovered when stuck.
    const pe = player();
    if (pe.race.phase !== 'finished' && !pe.car.hull.wrecked) {
      const p = pe.car.physics.curr.p;
      const fell = hasFallen(
        {
          hasElevation: def.hasElevation,
          groundY: def.groundY ?? 0,
          x: p.x,
          y: p.y,
          z: p.z,
          speedMps: pe.car.physics.speedMps,
          roadY: path.pointAt(pe.t).y,
        },
        world,
        RAPIER,
        sunkRay,
      );
      if (fell) {
        const pose = respawnPose(path, pe.t, 0);
        pe.car.respawn(pose);
        pe.recoveries++;
      }
    }
    for (const e of entries) {
      if (e.pilot || e.car.hull.wrecked || e.race.phase !== 'racing' || e.race.timeSec < AI.recovery.graceSec) continue;
      if (!e.stuck.update(STEP, e.t, upY(e.car.physics.curr.q), path.lengthM)) continue;
      e.car.respawn(respawnPose(path, e.t + AI.recovery.stepAheadM / path.lengthM, e.lane));
      e.recoveries++;
    }
    entries.forEach((e, i) => {
      e.t = path.project(e.car.physics.curr.p.x, e.car.physics.curr.p.z, e.t);
      e.race.update(STEP, e.t);
      const v = views[i];
      v.lap = e.race.laps.lap;
      v.t = e.t;
      v.nextGateT = e.race.nextGateT;
      v.checkpointsPassed = e.race.laps.nextCheckpoint;
      v.finished = e.race.phase === 'finished';
      v.finishTimeSec = e.race.finishTimeSec;
      for (const o of e.others) {
        const oc = (byId.get(o.id) as Entry).car;
        o.x = oc.physics.curr.p.x;
        o.y = oc.physics.curr.p.y;
        o.z = oc.physics.curr.p.z;
        o.wrecked = oc.hull.wrecked;
      }
    });
    stepMs.push(performance.now() - t0);
    if (entries.every((e) => e.race.phase === 'finished')) {
      step++;
      break;
    }
  }
  const finishSec: Record<string, number | null> = {};
  for (const e of entries) finishSec[e.id] = e.race.finishTimeSec;
  return {
    order: rankCars(views),
    finishSec,
    bestLapSec: bestLap,
    recoveries: Object.fromEntries(entries.map((e) => [e.id, e.recoveries])),
    wrecks,
    takedowns,
    simSec: step * STEP,
    steps: step,
    stepMs,
  };
}
