import { beforeAll, describe, expect, it } from 'vitest';
import { COMBAT } from '../src/core/Data';
import { PoseHistory, rayVsObb } from '../src/sim/lagcomp';
import { RaceSim, initSim } from '../src/sim/RaceSim';

beforeAll(async () => {
  await initSim();
});

describe('ray vs oriented box', () => {
  const q0 = { x: 0, y: 0, z: 0, w: 1 };
  it('hits a box straight ahead at the near face', () => {
    const t = rayVsObb({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 10 }, q0, [1, 1, 2], 100);
    expect(t).toBeCloseTo(8, 6);
  });
  it('misses a box beside the ray, and respects the maximum distance', () => {
    expect(rayVsObb({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 3, y: 0, z: 10 }, q0, [1, 1, 2], 100)).toBeNull();
    expect(rayVsObb({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 10 }, q0, [1, 1, 2], 5)).toBeNull();
  });
  it('uses the box rotation: a box turned 90 degrees about Y is wide along z instead of x', () => {
    const a = Math.PI / 4;
    const q = { x: 0, y: Math.sin(a), z: 0, w: Math.cos(a) };
    // half extents (0.5, 1, 4): after a quarter turn the long side points along x, so a ray 3 m off to the side still hits.
    expect(
      rayVsObb({ x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 10 }, q, [0.5, 1, 4], 100),
    ).not.toBeNull();
    expect(
      rayVsObb({ x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 10 }, q0, [0.5, 1, 4], 100),
    ).toBeNull();
  });
});

describe('pose history', () => {
  it('remembers recent ticks and forgets overwritten ones', () => {
    const h = new PoseHistory(4);
    for (let k = 1; k <= 6; k++) h.record(k, { x: k, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    const p = { x: 0, y: 0, z: 0 };
    const q = { x: 0, y: 0, z: 0, w: 1 };
    expect(h.read(6, p, q)).toBe(true);
    expect(p.x).toBe(6);
    expect(h.read(3, p, q)).toBe(true);
    expect(h.read(2, p, q)).toBe(false); // overwritten
    expect(h.read(9, p, q)).toBe(false); // not yet recorded
  });
});

/**
 * A shooter sits still; a target is teleported 0.5 m sideways every tick across the shooter's line of fire (auto-aim
 * off, so shots go straight along the nose). The shooter's client draws the target `lagTicks` in the past, so it
 * pulls the trigger when the target *appears* to cross its sights: that is `lagTicks` after the target really did.
 */
function crossingHits(lagTicks: number | undefined): number[] {
  const sim = new RaceSim({
    trackId: 'cat_lai',
    laps: 1,
    slots: [
      { id: 'a', carId: 'kestrel_gt', kind: 'human', gridSlot: 0 },
      { id: 'b', carId: 'kestrel_gt', kind: 'human', gridSlot: 1 },
    ],
    traffic: false,
    scenery: false,
  });
  const a = sim.entry('a') as NonNullable<ReturnType<typeof sim.entry>>;
  const b = sim.entry('b') as NonNullable<ReturnType<typeof sim.entry>>;
  const hits: number[] = [];
  sim.events.on('carHit', (e) => {
    if (e.carId === 'b' && e.attackerId === 'a') hits.push(sim.tick - crossStart);
  });
  // Far from the road, on the flat ground; the shooter faces +Z.
  const X0 = 900;
  const Z0 = 900;
  const place = (k: number): void => {
    b.car.physics.reset(X0 - 10 + 0.5 * k, Z0 + 40, Math.PI / 2, 0);
  };
  // Wait out the countdown (controls are locked until the green) with both cars parked out of the way.
  let crossStart = Number.POSITIVE_INFINITY;
  a.car.physics.reset(X0, Z0, 0, 0); // placed once: a reset drops the car, and the gun is off while airborne
  for (let i = 0; i < 60 * 6; i++) {
    b.car.physics.reset(X0 - 100, Z0 + 40, Math.PI / 2, 0);
    sim.step();
  }
  expect(a.race.controlsLocked).toBe(false);
  crossStart = sim.tick;
  const fire = { throttle: 0, brake: 0, steer: 0, drift: false, nitro: false, fire: true, fireSecondary: false };
  for (let k = 0; k < 60; k++) {
    place(k);
    sim.setInput('a', fire);
    // The target crosses the sights (x = X0) at k = 20; what the shooter saw at tick `now` is the target at `now - lag`.
    sim.setViewTick('a', lagTicks === undefined ? undefined : sim.tick + 1 - lagTicks);
    sim.step();
  }
  sim.dispose();
  return hits;
}

describe('lag compensation', () => {
  it('without it a shooter who aims at what they see misses a moving target; with it the shot lands where it was seen', () => {
    const lag = 8;
    const plain = crossingHits(undefined);
    const comp = crossingHits(lag);
    console.log(
      'LAGCOMP hits at ticks after start (no comp)',
      JSON.stringify(plain),
      ' (comp, lag 8)',
      JSON.stringify(comp),
    );
    expect(COMBAT.lagComp.maxRewindMs).toBeGreaterThanOrEqual((lag * 1000) / 60);
    // Shots land while the target is in the sights; the gun fires every 6 ticks, so compare the first landed shot.
    expect(plain.length).toBeGreaterThan(0);
    expect(comp.length).toBeGreaterThan(0);
    // Compensated, the same crossing is seen `lag` ticks later: the first landed shot moves by about `lag`
    // (give or take the gun's 6-tick cadence), and no compensated shot lands earlier than the real crossing allows.
    expect(comp[0] - plain[0]).toBeGreaterThanOrEqual(lag - 3);
    expect(comp[0] - plain[0]).toBeLessThanOrEqual(lag + 6);
    for (const t of comp) expect(t).toBeGreaterThanOrEqual(plain[0] + lag - 3);
  });

  it('never rewinds further than the cap: a client claiming a huge view lag gets no extra reach', () => {
    const cap = Math.ceil((COMBAT.lagComp.maxRewindMs * 60) / 1000);
    const claimed = cap + 30;
    const plain = crossingHits(undefined);
    const comp = crossingHits(claimed);
    expect(comp.length).toBeGreaterThan(0);
    // With the claimed lag honoured the first landed shot would be `claimed` ticks late; with the cap it is `cap` ticks late.
    expect(comp[0] - plain[0]).toBeLessThanOrEqual(cap + 6);
    expect(comp[0] - plain[0]).toBeLessThan(claimed - 6);
  });
});
