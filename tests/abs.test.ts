import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { CARS, HANDLING, type CarDef } from '../src/core/Data';
import { CarPhysics, IDLE_CONTROLS, type CarControls } from '../src/vehicle/CarPhysics';

beforeAll(async () => {
  await RAPIER.init();
});

function makeSim(def: CarDef) {
  const world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
  world.timestep = 1 / 60;
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0)).setFriction(1);
  const car = new CarPhysics(RAPIER, world, def, HANDLING, { x: 0, y: 0.5, z: 0, yaw: 0 });
  const run = (sec: number, c: Partial<CarControls>, each?: () => void): void => {
    const ctl = { ...IDLE_CONTROLS, ...c };
    for (let i = 0; i < Math.round(sec * 60); i++) {
      car.preStep(1 / 60, ctl);
      world.step();
      car.postStep();
      each?.();
    }
  };
  return { car, run };
}

/** Pitch of the body about its left axis, degrees (nose down is negative). */
function pitchDeg(car: CarPhysics): number {
  const q = car.body.rotation();
  return (Math.asin(Math.max(-1, Math.min(1, 2 * (q.y * q.z - q.w * q.x)))) * 180) / Math.PI;
}

// ABS: a full brake from speed slows the car at about what its tyres can hold, keeps all wheels down, and never hops.
describe.each(CARS.map((c) => [c.id, c] as const))('ABS %s', (_id, def) => {
  it('brakes hard from speed without lifting a wheel off the road, hopping or pitching over', () => {
    const { car, run } = makeSim(def);
    run(1, {});
    run(25, { throttle: 1 });
    const v0 = car.forwardSpeed;
    expect(v0).toBeGreaterThan(20);
    let maxPitch = 0;
    let maxY = -Infinity;
    let air = 0;
    let peakDecel = 0;
    let prev = v0;
    const y0 = car.curr.p.y;
    run(2, { brake: 1 }, () => {
      maxPitch = Math.max(maxPitch, Math.abs(pitchDeg(car)));
      maxY = Math.max(maxY, car.curr.p.y - y0);
      if (car.airborne) air++;
      peakDecel = Math.max(peakDecel, (prev - car.forwardSpeed) * 60);
      prev = car.forwardSpeed;
    });
    expect(air).toBe(0);
    expect(maxY).toBeLessThan(0.15);
    expect(maxPitch).toBeLessThan(14);
    // never more than the tyres allow (μ × g, with a little room for downforce), never a sudden jolt
    const limit = HANDLING.brake.absMu * def.grip * Math.abs(HANDLING.world.gravity);
    expect(peakDecel).toBeLessThan(limit * 1.6 + 6);
    expect(car.forwardSpeed).toBeLessThan(v0 - 5);
  });

  it('lifting off the throttle only gives gentle engine braking', () => {
    const { car, run } = makeSim(def);
    run(1, {});
    run(25, { throttle: 1 });
    const v0 = car.forwardSpeed;
    run(1, {});
    expect(v0 - car.forwardSpeed).toBeLessThan(HANDLING.engine.coastDecelMps2 + (def.openWheel ? 8 : 3)); // open-wheel cars add aero drag
  });
});
