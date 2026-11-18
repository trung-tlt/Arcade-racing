import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { AIDriver, type OtherCar } from '../src/ai/AIDriver';
import { RacingLine } from '../src/ai/RacingLine';
import { AI, HANDLING, CAT_LAI, RACE, getCarDef } from '../src/core/Data';
import { EventBus } from '../src/core/Events';
import { RaceManager } from '../src/race/RaceManager';
import { gridPose } from '../src/race/Respawn';
import { type CarRaceView, effectiveT, rankCars, rubberBandSignal } from '../src/race/Standings';
import { CarPhysics, IDLE_CONTROLS, type CarControls } from '../src/vehicle/CarPhysics';
import { TrackPath } from '../src/world/TrackPath';

beforeAll(async () => {
  await RAPIER.init();
});

interface Entry {
  id: string;
  car: CarPhysics;
  race: RaceManager;
  t: number;
  ctl: () => CarControls;
}

/** Pure-pursuit bot standing in for a competent human (no nitro, no combat). */
function botController(path: TrackPath, car: () => CarPhysics, t: () => number, paceMul: number): () => CarControls {
  const ctl: CarControls = { ...IDLE_CONTROLS };
  return () => {
    const c = car();
    const p = c.curr.p;
    const look = 12 + c.forwardSpeed * 0.5;
    const tgt = path.pointAt(t() + look / path.lengthM);
    let err = Math.atan2(tgt.x - p.x, tgt.z - p.z) - c.yaw;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    ctl.steer = Math.max(-1, Math.min(1, -err * 2.5));
    const far = path.pointAt(t() + (30 + c.forwardSpeed * 1.2) / path.lengthM);
    let fe = Math.atan2(far.x - p.x, far.z - p.z) - c.yaw;
    fe = Math.abs(Math.atan2(Math.sin(fe), Math.cos(fe)));
    const v = (fe > 0.35 ? 22 : fe > 0.15 ? 35 : 55) * paceMul;
    ctl.throttle = c.forwardSpeed < v ? 1 : 0;
    ctl.brake = c.forwardSpeed > v + 3 ? 0.6 : 0;
    return ctl;
  };
}

export function runRace(botPace: number, laps: number): { order: string[]; botPlace: number; time: number } {
  const path = new TrackPath(CAT_LAI.spline.points, RACE.track.sampleSpacingM, RACE.track.projectWindowSamples);
  const line = new RacingLine(path, RACE.track.sampleSpacingM);
  const world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setTranslation(0, -0.5, 0));
  const events = new EventBus();
  const entries: Entry[] = [];
  const views: CarRaceView[] = [];
  const mkRace = (id: string): RaceManager =>
    new RaceManager(
      {
        carId: id,
        totalLaps: laps,
        checkpointTs: CAT_LAI.checkpoints.map((c) => c.t),
        countdownSteps: RACE.countdown.steps,
        countdownStepSec: RACE.countdown.stepSec,
        goHoldSec: RACE.countdown.goHoldSec,
      },
      events,
    );
  const mkCar = (carId: string, slot: number): CarPhysics => {
    const [lat, behind] = CAT_LAI.startLine.grid[slot];
    const g = gridPose(path, lat, Math.abs(behind), path.lengthM);
    return new CarPhysics(RAPIER, world, getCarDef(carId), HANDLING, { x: g.x, y: 0.4, z: g.z, yaw: g.yaw });
  };
  const progress = (id: string): number => {
    const e = entries.find((x) => x.id === id) as Entry;
    return (
      e.race.laps.lap + effectiveT({ lap: e.race.laps.lap, t: e.t, checkpointsPassed: e.race.laps.nextCheckpoint })
    );
  };

  const others = new Map<string, OtherCar[]>();
  AI.rivals.forEach((r, i) => {
    const car = mkCar(r.car, i);
    const entry: Entry = { id: r.id, car, race: mkRace(r.id), t: 0, ctl: () => IDLE_CONTROLS };
    const driver = new AIDriver({
      carId: r.id,
      line,
      laneOffsetM: r.laneOffsetM,
      skill: r.skill,
      topSpeedMps: getCarDef(r.car).topSpeedKmh / 3.6,
      self: () => ({
        x: car.curr.p.x,
        z: car.curr.p.z,
        yaw: car.yaw,
        forwardSpeed: car.forwardSpeed,
        lateralSpeed: car.lateralSpeed,
        t: entry.t,
        nitroBars: car.nitro.bars,
        airborne: car.airborne,
      }),
      others: () => others.get(r.id) ?? [],
      pickups: () => [],
      rubberBand: () => rubberBandSignal(progress(r.id), progress('bot'), RACE.ai.rubberBandScaleLaps),
      rocketAmmo: () => 0,
      hullFraction: () => 1,
    });
    entry.ctl = () =>
      entry.race.controlsLocked
        ? IDLE_CONTROLS
        : entry.race.phase === 'finished'
          ? { ...IDLE_CONTROLS, brake: 0.6 }
          : driver.read();
    entries.push(entry);
  });
  const botCar = mkCar('kestrel_gt', RACE.ai.playerGridSlot);
  const bot: Entry = { id: 'bot', car: botCar, race: mkRace('bot'), t: 0, ctl: () => IDLE_CONTROLS };
  const drive = botController(
    path,
    () => botCar,
    () => bot.t,
    botPace,
  );
  bot.ctl = () => (bot.race.controlsLocked ? IDLE_CONTROLS : drive());
  entries.push(bot);

  for (const e of entries) {
    e.t = path.project(e.car.curr.p.x, e.car.curr.p.z);
    e.race.restart(e.t);
    views.push({ id: e.id, lap: 1, t: e.t, nextGateT: 0, checkpointsPassed: 0, finished: false, finishTimeSec: null });
    others.set(
      e.id,
      entries.filter((o) => o !== e).map((o) => ({ id: o.id, x: 0, y: 0, z: 0, wrecked: false })),
    );
  }
  for (let step = 0; step < 60 * 600; step++) {
    for (const e of entries) e.car.preStep(1 / 60, e.ctl());
    world.step();
    for (const e of entries) e.car.postStep();
    entries.forEach((e, i) => {
      e.t = path.project(e.car.curr.p.x, e.car.curr.p.z, e.t);
      e.race.update(1 / 60, e.t);
      const v = views[i];
      v.lap = e.race.laps.lap;
      v.t = e.t;
      v.nextGateT = e.race.nextGateT;
      v.checkpointsPassed = e.race.laps.nextCheckpoint;
      v.finished = e.race.phase === 'finished';
      v.finishTimeSec = e.race.finishTimeSec;
      for (const o of others.get(e.id) ?? []) {
        const oe = entries.find((x) => x.id === o.id) as Entry;
        o.x = oe.car.curr.p.x;
        o.y = oe.car.curr.p.y;
        o.z = oe.car.curr.p.z;
      }
    });
    if (bot.race.phase === 'finished') break;
  }
  const order = rankCars(views);
  return { order, botPlace: order.indexOf('bot') + 1, time: bot.race.timeSec };
}

describe('tuning sweep', () => {
  it.skipIf(!process.env.AI_SWEEP)(
    'sweep',
    () => {
      const base = AI.rivals.map((r) => r.skill);
      const lines: string[] = [];
      for (const lat of [15, 18, 21, 24]) {
        for (const add of [0, 0.03, 0.06]) {
          AI.speed.maxLatAccelMps2 = lat;
          AI.rivals.forEach((r, i) => (r.skill = base[i] + add));
          const out = [1.0, 1.1].map((pace) => {
            const r = runRace(pace, CAT_LAI.laps);
            return `p${pace}:${r.botPlace}(${r.time.toFixed(0)}s) win=${r.order[0]}`;
          });
          lines.push(`lat=${lat} skill+${add}: ${out.join(' | ')}`);
        }
      }
      console.log('TUNE\n' + lines.join('\n'));
    },
    300_000,
  );
});

describe('6-car race (headless, no combat)', () => {
  it('everyone finishes a 1-lap race and the standings are sane', () => {
    const r = runRace(1, 1);
    console.log(`RACE1 order=${r.order.join(',')} botPlace=${r.botPlace} botTime=${r.time.toFixed(1)}`);
    expect(r.order).toHaveLength(6);
    expect(r.time).toBeLessThan(200);
  });
  it('win-rate sweep: bot pace vs AI (3 laps)', () => {
    const rows: string[] = [];
    for (const pace of [0.9, 1.0, 1.1, 1.2]) {
      const r = runRace(pace, CAT_LAI.laps);
      rows.push(`pace ${pace}: place ${r.botPlace} time ${r.time.toFixed(0)} order ${r.order.join('>')}`);
    }
    console.log('SWEEP\n' + rows.join('\n'));
    expect(rows).toHaveLength(4);
  }, 120_000);
});
