import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { HANDLING, CAT_LAI, RACE, getCarDef } from '../src/core/Data';
import { EventBus } from '../src/core/Events';
import { RaceManager } from '../src/race/RaceManager';
import { gridPose } from '../src/race/Respawn';
import { CarPhysics, type CarControls } from '../src/vehicle/CarPhysics';
import { TrackPath } from '../src/world/TrackPath';

beforeAll(async () => {
  await RAPIER.init();
});

describe('solo time trial (headless)', () => {
  it('a pure-pursuit driver completes 3 laps through the real checkpoint pipeline', () => {
    const path = new TrackPath(CAT_LAI.spline.points, RACE.track.sampleSpacingM, RACE.track.projectWindowSamples);
    expect(path.lengthM).toBeGreaterThan(2000);
    expect(path.lengthM).toBeLessThan(3000);

    const world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
    world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setTranslation(0, -0.5, 0));
    const [lat, behind] = CAT_LAI.startLine.grid[0];
    const g = gridPose(path, lat, Math.abs(behind), path.lengthM);
    const car = new CarPhysics(RAPIER, world, getCarDef('kestrel_gt'), HANDLING, {
      x: g.x,
      y: 0.4,
      z: g.z,
      yaw: g.yaw,
    });

    const events = new EventBus();
    const race = new RaceManager(
      {
        carId: 'p',
        totalLaps: CAT_LAI.laps,
        checkpointTs: CAT_LAI.checkpoints.map((c) => c.t),
        countdownSteps: RACE.countdown.steps,
        countdownStepSec: RACE.countdown.stepSec,
        goHoldSec: RACE.countdown.goHoldSec,
      },
      events,
    );
    let cps = 0;
    events.on('checkpoint', () => cps++);
    let t = path.project(g.x, g.z);
    race.restart(t);

    const ctl: CarControls = {
      throttle: 0,
      brake: 0,
      steer: 0,
      drift: false,
      nitro: false,
      fire: false,
      fireSecondary: false,
    };
    let maxOff = 0;
    for (let step = 0; step < 60 * 400 && race.phase !== 'finished'; step++) {
      // Pure pursuit: aim at a point `look` metres ahead on the centreline.
      const p = car.curr.p;
      const look = 12 + car.forwardSpeed * 0.5;
      const tgt = path.pointAt(t + look / path.lengthM);
      const yaw = car.yaw;
      const dx = tgt.x - p.x;
      const dz = tgt.z - p.z;
      const want = Math.atan2(dx, dz);
      let err = want - yaw;
      err = Math.atan2(Math.sin(err), Math.cos(err));
      ctl.steer = Math.max(-1, Math.min(1, -err * 2.5));
      // Slow for the corner ahead.
      const far = path.pointAt(t + (30 + car.forwardSpeed * 1.2) / path.lengthM);
      const farErr = Math.abs(
        Math.atan2(
          Math.sin(Math.atan2(far.x - p.x, far.z - p.z) - yaw),
          Math.cos(Math.atan2(far.x - p.x, far.z - p.z) - yaw),
        ),
      );
      const vTarget = farErr > 0.35 ? 22 : farErr > 0.15 ? 35 : 55;
      const locked = race.controlsLocked;
      ctl.throttle = !locked && car.forwardSpeed < vTarget ? 1 : 0;
      ctl.brake = !locked && car.forwardSpeed > vTarget + 3 ? 0.6 : 0;
      car.preStep(1 / 60, ctl);
      world.step();
      car.postStep();
      t = path.project(car.curr.p.x, car.curr.p.z, t);
      race.update(1 / 60, t);
      const pt = path.pointAt(t);
      maxOff = Math.max(maxOff, Math.hypot(car.curr.p.x - pt.x, car.curr.p.z - pt.z));
    }
    console.log(
      `TT finished=${race.phase} total=${race.timeSec.toFixed(1)}s laps=${race.laps.lapTimes.map((x) => x.toFixed(1))} cps=${cps} maxOff=${maxOff.toFixed(1)}`,
    );
    expect(race.phase).toBe('finished');
    expect(race.laps.lapTimes).toHaveLength(3);
    expect(cps).toBe(24);
  });
});
