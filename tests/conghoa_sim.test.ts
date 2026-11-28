import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { AIDriver } from '../src/ai/AIDriver';
import { RacingLine } from '../src/ai/RacingLine';
import { CONG_HOA, HANDLING, RACE, getCarDef } from '../src/core/Data';
import { EventBus } from '../src/core/Events';
import { RaceManager } from '../src/race/RaceManager';
import { gridPose } from '../src/race/Respawn';
import { CarPhysics } from '../src/vehicle/CarPhysics';
import { TrackPath } from '../src/world/TrackPath';

beforeAll(async () => {
  await RAPIER.init();
});

/** One AI lap on Cong Hoa with no walls: how far off the 11 m carriageway does it stray, and how long does it take? */
function lap(
  carId: string,
  skill: number,
  laneOffsetM = 0,
): { time: number; maxOff: number; maxAt: number; finished: boolean; minSpeed: number } {
  const path = new TrackPath(CONG_HOA.spline.points, RACE.track.sampleSpacingM, RACE.track.projectWindowSamples);
  const line = new RacingLine(path, RACE.track.sampleSpacingM);
  const world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0));
  const [lat, behind] = CONG_HOA.startLine.grid[0];
  const g = gridPose(path, lat, Math.abs(behind), path.lengthM);
  const def = getCarDef(carId);
  const car = new CarPhysics(RAPIER, world, def, HANDLING, { x: g.x, y: 0.4, z: g.z, yaw: g.yaw });
  const race = new RaceManager(
    {
      carId,
      totalLaps: 1,
      checkpointTs: CONG_HOA.checkpoints.map((c) => c.t),
      countdownSteps: 0,
      countdownStepSec: 1,
      goHoldSec: 0,
    },
    new EventBus(),
  );
  let t = path.project(g.x, g.z);
  race.restart(t);
  const driver = new AIDriver({
    carId,
    line,
    laneOffsetM,
    handling: def.handling,
    skill,
    topSpeedMps: def.topSpeedKmh / 3.6,
    self: () => ({
      x: car.curr.p.x,
      z: car.curr.p.z,
      yaw: car.yaw,
      forwardSpeed: car.forwardSpeed,
      lateralSpeed: car.lateralSpeed,
      t,
      nitroBars: car.nitro.bars,
      airborne: car.airborne,
    }),
    others: () => [],
    pickups: () => [],
    rubberBand: () => 0,
    rocketAmmo: () => 0,
    hullFraction: () => 1,
  });
  let maxOff = 0;
  let maxAt = 0;
  let minSpeed = 1e9;
  for (let step = 0; step < 60 * 400 && race.phase !== 'finished'; step++) {
    car.preStep(1 / 60, driver.read());
    world.step();
    car.postStep();
    t = path.project(car.curr.p.x, car.curr.p.z, t);
    race.update(1 / 60, t);
    const c = path.pointAt(t);
    const off = Math.hypot(car.curr.p.x - c.x, car.curr.p.z - c.z);
    if (off > maxOff) {
      maxOff = off;
      maxAt = t;
    }
    if (step > 600) minSpeed = Math.min(minSpeed, car.speedMps);
  }
  return { time: race.timeSec, maxOff, maxAt, finished: race.phase === 'finished', minSpeed };
}

const RIVAL_CARS: [string, number][] = [
  ['kestrel_gt', 8],
  ['wisp_r', 8],
  ['facet_xt', 20],
];

describe('Cong Hoa Boulevard is drivable by the AI rivals (no walls)', () => {
  for (const [id, maxOffAllowed] of RIVAL_CARS) {
    it(`${id} completes a lap and keeps within ${maxOffAllowed} m of the centre line`, () => {
      const r = lap(id, 0.95);
      console.log(
        `CH ${id} lap=${r.time.toFixed(1)}s maxOff=${r.maxOff.toFixed(1)}m at t=${r.maxAt.toFixed(3)} minV=${r.minSpeed.toFixed(1)}`,
      );
      expect(r.finished).toBe(true);
      expect(r.time).toBeLessThan(120);
      expect(r.maxOff).toBeLessThan(maxOffAllowed);
    });
  }
});
