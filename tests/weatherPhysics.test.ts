import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { HANDLING, getCarDef } from '../src/core/Data';
import { CarPhysics, IDLE_CONTROLS, type CarControls } from '../src/vehicle/CarPhysics';

function makeSim(setup?: (car: CarPhysics) => void) {
  const world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
  world.timestep = 1 / 60;
  world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setTranslation(0, -0.5, 0).setFriction(1));
  const car = new CarPhysics(RAPIER, world, getCarDef('kestrel_gt'), HANDLING, { x: 0, y: 0.4, z: 0, yaw: 0 });
  setup?.(car);
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

const trace = (car: CarPhysics) => [car.curr.p.x, car.curr.p.y, car.curr.p.z, car.forwardSpeed, car.lateralSpeed];

describe('CarPhysics weather hooks', () => {
  it('are neutral by default, so every other map is unchanged', () => {
    const a = makeSim();
    const b = makeSim((c) => {
      c.surfaceGripMul = 1;
      c.brakeDistanceMul = 1;
      c.dragMul = 1;
      c.addYawKick(0);
    });
    for (const s of [a, b]) {
      s.run(1, {});
      s.run(4, { throttle: 1 });
      s.run(2, { throttle: 1, steer: 0.5 });
      s.run(2, { brake: 1 });
    }
    expect(trace(b.car)).toEqual(trace(a.car));
  });
  it('lower grip makes the car turn less for the same steering', () => {
    const dry = makeSim();
    const wet = makeSim((c) => (c.surfaceGripMul = 0.55));
    for (const s of [dry, wet]) {
      s.run(1, {});
      s.run(5, { throttle: 1 });
      s.run(2, { throttle: 0.6, steer: 0.8 });
    }
    // less grip: the car turns less (understeers), so it ends up less far to the side
    expect(Math.abs(wet.car.curr.p.x)).toBeLessThan(Math.abs(dry.car.curr.p.x) * 0.97);
  });
  it('brakeDistanceMul 1.2 stretches the braking distance by about 20%', () => {
    const stop = (mul: number) => {
      const s = makeSim((c) => (c.brakeDistanceMul = mul));
      s.run(1, {});
      s.run(5, { throttle: 1 });
      const z0 = s.car.curr.p.z;
      const v0 = s.car.forwardSpeed;
      for (let i = 0; i < 600 && s.car.forwardSpeed > 1; i++) s.run(1 / 60, { brake: 1 });
      return { d: s.car.curr.p.z - z0, v0 };
    };
    const dry = stop(1);
    const wet = stop(1.2);
    expect(wet.d).toBeGreaterThan(dry.d * 1.1);
    expect(wet.d).toBeLessThan(dry.d * 1.35);
  });
  it('dragMul slows the car in standing water', () => {
    const free = makeSim();
    const flood = makeSim((c) => (c.dragMul = 1.6));
    for (const s of [free, flood]) {
      s.run(1, {});
      s.run(5, { throttle: 1 });
    }
    expect(flood.car.forwardSpeed).toBeLessThan(free.car.forwardSpeed * 0.9);
  });
  it('a yaw kick turns the car once, then clears', () => {
    const { car, run } = makeSim();
    run(1, {});
    car.addYawKick(0.2);
    run(1 / 60, {});
    expect(Math.abs(car.body.angvel().y)).toBeGreaterThan(0.05);
    run(3, {});
    const settled = Math.abs(car.body.angvel().y);
    expect(settled).toBeLessThan(0.05); // damped away, not re-applied
  });
});
