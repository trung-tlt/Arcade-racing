import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { CARS, HANDLING, type CarDef } from '../src/core/Data';
import { CarPhysics, IDLE_CONTROLS, buildWheelLayout, type CarControls } from '../src/vehicle/CarPhysics';

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
  const upY = (): number => {
    const q = car.body.rotation();
    return 1 - 2 * (q.x * q.x + q.z * q.z);
  };
  return { car, run, upY };
}

describe.each(CARS.map((c) => [c.id, c] as const))('%s', (_id, def) => {
  const topMps = def.topSpeedKmh / 3.6;

  it('has a wheel layout that matches its type', () => {
    const l = buildWheelLayout(def, HANDLING);
    const want = { car: 4, apc8x8: 8, bike: 4 }[def.vehicleType];
    expect(l).toHaveLength(want);
    expect(new Set(l.map((w) => w.name)).size).toBe(l.length);
    for (const w of l) expect(def.wheels.map((d) => d.name)).toContain(w.visual);
  });

  it('settles on its suspension without bouncing away', () => {
    const { car, run, upY } = makeSim(def);
    run(2.5, {});
    expect(car.curr.p.y).toBeGreaterThan(-0.3);
    expect(car.curr.p.y).toBeLessThan(0.5);
    expect(car.airborne).toBe(false);
    expect(upY()).toBeGreaterThan(0.95);
  });

  it('accelerates straight to ≥80% of top speed within 60 s without exceeding it', () => {
    const { car, run } = makeSim(def);
    run(1, {});
    const res: { t100: number | null } = { t100: null };
    let t = 0;
    let top = 0;
    run(60, { throttle: 1 }, () => {
      t += 1 / 60;
      top = Math.max(top, car.forwardSpeed);
      if (res.t100 === null && car.forwardSpeed >= 100 / 3.6) res.t100 = t;
    });
    console.log(
      `ACCEL ${def.id}: top ${(top * 3.6).toFixed(0)} km/h of ${def.topSpeedKmh} | 0-100 km/h ${res.t100 === null ? 'n/a' : res.t100.toFixed(1) + ' s'}`,
    );
    expect(car.curr.p.z).toBeGreaterThan(50);
    expect(Math.abs(car.curr.p.x)).toBeLessThan(15);
    expect(top).toBeGreaterThan(topMps * 0.8);
    expect(top).toBeLessThan(topMps * 1.05);
  });

  it('steering right turns toward -X, and a steady full-lock turn is stable', () => {
    const { car, run, upY } = makeSim(def);
    run(1, {});
    run(5, { throttle: 1 });
    run(2, { throttle: 1, steer: 1 });
    expect(car.curr.p.x).toBeLessThan(-0.5);
    // Steady turn at 40% throttle, full lock: radius = speed / yaw rate.
    const s2 = makeSim(def);
    s2.run(1, {});
    s2.run(4, { throttle: 1 });
    let radius = 0;
    s2.run(6, { throttle: 0.4, steer: 1 }, () => {
      const w = Math.abs(s2.car.body.angvel().y);
      radius = w > 0.01 ? Math.hypot(s2.car.body.linvel().x, s2.car.body.linvel().z) / w : Infinity;
    });
    console.log(`TURN ${def.id}: steady radius ≈ ${radius.toFixed(0)} m at full lock, 40% throttle`);
    expect(upY()).toBeGreaterThan(0.7);
    expect(s2.upY()).toBeGreaterThan(0.7);
    expect(radius).toBeGreaterThan(3);
  });

  it('brakes and reverses', () => {
    const { car, run } = makeSim(def);
    run(1, {});
    run(4, { throttle: 1 });
    run(8, { brake: 1 });
    expect(car.forwardSpeed).toBeLessThan(0);
  });

  it('never flips during a hard-steer + drift run', () => {
    const { run, upY } = makeSim(def);
    run(1, {});
    run(4, { throttle: 1 });
    let minUp = 1;
    for (const steer of [1, -1, 1, -1]) {
      run(1.2, { throttle: 1, steer, drift: true }, () => (minUp = Math.min(minUp, upY())));
    }
    console.log(`FLIP ${def.id}: min up-vector y = ${minUp.toFixed(2)}`);
    expect(minUp).toBeGreaterThan(0.7);
  });
});

describe('apc8x8', () => {
  const def = CARS.find((c) => c.vehicleType === 'apc8x8') as CarDef;
  it('has 8 wheels with the specified steer scales', () => {
    const l = buildWheelLayout(def, HANDLING);
    expect(l).toHaveLength(8);
    const by = (n: string): number => l.find((w) => w.name === n)?.steerScale ?? -1;
    expect(by('wheel_1L')).toBe(1);
    expect(by('wheel_1R')).toBe(1);
    expect(by('wheel_2L')).toBe(HANDLING.apc8x8.axle2SteerScale);
    expect(by('wheel_2R')).toBe(HANDLING.apc8x8.axle2SteerScale);
    for (const n of ['wheel_3L', 'wheel_3R', 'wheel_4L', 'wheel_4R']) expect(by(n)).toBe(0);
    expect(l.filter((w) => w.rear)).toHaveLength(4);
    expect(l.every((w) => !w.virtual)).toBe(true);
  });
  it('runs a physics vehicle with 8 wheels', () => {
    const { car, run } = makeSim(def);
    run(2, {});
    expect(car.wheelCount).toBe(8);
    expect(car.wheels).toHaveLength(8);
    expect(car.wheels.every((w) => w.inContact)).toBe(true);
  });
});

describe('mantis_650r (bike)', () => {
  const def = CARS.find((c) => c.vehicleType === 'bike') as CarDef;
  const max = ((def.maxLeanDeg ?? 0) * Math.PI) / 180;
  it('builds 4 virtual wheels: front pair steers, rear pair is fixed', () => {
    const l = buildWheelLayout(def, HANDLING);
    expect(l.every((w) => w.virtual)).toBe(true);
    expect(l.filter((w) => w.visual === 'wheel_F').map((w) => w.steerScale)).toEqual([1, 1]);
    expect(l.filter((w) => w.visual === 'wheel_R').map((w) => w.steerScale)).toEqual([0, 0]);
    expect(Math.abs(l[0].x)).toBe(HANDLING.bike.wheelHalfSpacingM);
    expect(l[0].x).toBe(-l[1].x);
  });
  it('leans toward the steer side, within maxLeanDeg, and is ~0 when straight or slow', () => {
    const { car, run } = makeSim(def);
    run(1, {});
    expect(car.leanRad).toBe(0);
    run(0.5, { throttle: 1, steer: 1 }); // slow: speed factor small
    expect(Math.abs(car.leanRad)).toBeLessThan(max * 0.3);
    run(5, { throttle: 1 });
    run(1.5, { throttle: 1 });
    expect(Math.abs(car.leanRad)).toBeLessThan(0.02);
    let peak = 0;
    run(2, { throttle: 1, steer: 1 }, () => (peak = Math.max(peak, car.leanRad)));
    expect(peak).toBeGreaterThan(max * 0.3);
    expect(peak).toBeLessThanOrEqual(max + 1e-6);
    expect(car.leanFraction).toBeGreaterThan(0);
    run(3, { throttle: 1, steer: -1 });
    expect(car.leanRad).toBeLessThan(0);
    expect(car.leanFraction).toBeGreaterThanOrEqual(-1);
  });
  it('non-bikes never lean', () => {
    const { car, run } = makeSim(CARS[0]);
    run(3, { throttle: 1, steer: 1 });
    expect(car.leanRad).toBe(0);
    expect(car.leanFraction).toBe(0);
  });
});
