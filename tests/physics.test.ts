import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { HANDLING, getCarDef } from '../src/core/Data';
import { CarPhysics, IDLE_CONTROLS, type CarControls } from '../src/vehicle/CarPhysics';

function makeSim(carId = 'kestrel_gt') {
  const world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
  world.timestep = 1 / 60;
  const g = world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setTranslation(0, -0.5, 0));
  g.setFriction(1);
  const car = new CarPhysics(RAPIER, world, getCarDef(carId), HANDLING, { x: 0, y: 0.4, z: 0, yaw: 0 });
  const run = (sec: number, c: Partial<CarControls>) => {
    const ctl = { ...IDLE_CONTROLS, ...c };
    for (let i = 0; i < sec * 60; i++) {
      car.preStep(1 / 60, ctl);
      world.step();
      car.postStep();
    }
  };
  return { car, run };
}

beforeAll(async () => {
  await RAPIER.init();
});

describe('CarPhysics (headless)', () => {
  it('settles on its suspension without bouncing away', () => {
    const { car, run } = makeSim();
    run(2, {});
    expect(car.curr.p.y).toBeGreaterThan(-0.2);
    expect(car.curr.p.y).toBeLessThan(0.3);
    expect(car.airborne).toBe(false);
  });
  it('accelerates forward (+Z) and respects top speed', () => {
    const { car, run } = makeSim();
    run(1, {});
    run(4, { throttle: 1 });
    expect(car.forwardSpeed).toBeGreaterThan(22);
    expect(car.curr.p.z).toBeGreaterThan(20);
    run(30, { throttle: 1 });
    expect(car.forwardSpeed).toBeLessThan((290 / 3.6) * 1.02);
    expect(car.forwardSpeed).toBeGreaterThan((290 / 3.6) * 0.8);
  });
  it('steering right turns toward -X', () => {
    const { car, run } = makeSim();
    run(1, {});
    run(3, { throttle: 1 });
    run(2, { throttle: 1, steer: 1 });
    expect(car.curr.p.x).toBeLessThan(-1);
  });
  it('drifting builds slip and charges nitro without flipping', () => {
    const { car, run } = makeSim();
    run(1, {});
    run(8, { throttle: 1 });
    run(3, { throttle: 1, steer: 1, drift: true });
    expect(car.slipDeg).toBeGreaterThan(9);
    expect(car.nitro.bars).toBeGreaterThan(0);
    const q = car.body.rotation();
    expect(1 - 2 * (q.x * q.x + q.z * q.z)).toBeGreaterThan(0.8); // still upright
  });
  it('brakes to a stop and reverses', () => {
    const { car, run } = makeSim();
    run(1, {});
    run(4, { throttle: 1 });
    run(6, { brake: 1 });
    expect(car.forwardSpeed).toBeLessThan(0);
  });
});
