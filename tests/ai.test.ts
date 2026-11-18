import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { AIDriver } from '../src/ai/AIDriver';
import { AI, decideFire, newGunnerState, type GunnerState } from '../src/ai/AIGunner';
import { RacingLine, type PathSampler } from '../src/ai/RacingLine';
import { HANDLING, CAT_LAI, RACE, getCarDef } from '../src/core/Data';
import { gridPose } from '../src/race/Respawn';
import { CarPhysics } from '../src/vehicle/CarPhysics';
import { TrackPath } from '../src/world/TrackPath';

/** Circle of radius R in the XZ plane, driven counter-clockwise from +X. */
function circle(R: number): PathSampler {
  const L = 2 * Math.PI * R;
  return {
    lengthM: L,
    pointAt: (t) => ({ x: R * Math.cos(2 * Math.PI * t), y: 0, z: R * Math.sin(2 * Math.PI * t) }),
    tangentAt: (t) => ({ x: -Math.sin(2 * Math.PI * t), y: 0, z: Math.cos(2 * Math.PI * t) }),
    project: () => 0,
  };
}

describe('RacingLine', () => {
  const R = 100;
  const line = new RacingLine(circle(R), 2);
  it('measures curvature 1/R on a circle', () => {
    expect(line.curvatureAt(0.3)).toBeCloseTo(1 / R, 3);
  });
  it('limits corner speed to sqrt(a·R)', () => {
    expect(line.maxCornerSpeed(0, 50, 16)).toBeCloseTo(Math.sqrt(16 * R), 0);
  });
  it('reports a straight as unlimited', () => {
    const straight: PathSampler = {
      lengthM: 1000,
      pointAt: (t) => ({ x: 0, y: 0, z: t * 1000 }),
      tangentAt: () => ({ x: 0, y: 0, z: 1 }),
      project: () => 0,
    };
    expect(new RacingLine(straight, 5).maxCornerSpeed(0.1, 100, 16)).toBe(1000);
  });
  it('shifts the target to the car-left by the lane offset', () => {
    const straight: PathSampler = {
      lengthM: 1000,
      pointAt: (t) => ({ x: 0, y: 0, z: t * 1000 }),
      tangentAt: () => ({ x: 0, y: 0, z: 1 }),
      project: () => 0,
    };
    const p = new RacingLine(straight, 5).targetPoint(0.1, 20, 4);
    expect(p.x).toBeCloseTo(4, 6); // +X is left when facing +Z
    expect(p.z).toBeCloseTo(120, 6);
  });
});

describe('decideFire', () => {
  const cfg = AI.gunner;
  const self = { x: 0, y: 0, z: 0, yaw: 0 }; // facing +Z
  const rnd = (): number => 0.99; // never pauses a burst
  const ahead = (
    z: number,
    x = 0,
    wrecked = false,
  ): { id: string; x: number; y: number; z: number; wrecked: boolean } => ({
    id: 't',
    x,
    y: 0,
    z,
    wrecked,
  });
  const ready = (): GunnerState => ({ ...newGunnerState(cfg), reactionLeft: 0 });

  it('fires at a target inside the cone and range', () => {
    expect(decideFire(self, [ahead(50)], 0, cfg, ready(), 1 / 60, rnd).fire).toBe(true);
  });
  it('holds fire outside the cone, beyond range, or at a wrecked car', () => {
    expect(decideFire(self, [ahead(50, 20)], 0, cfg, ready(), 1 / 60, rnd).fire).toBe(false);
    expect(decideFire(self, [ahead(cfg.rangeM + 10)], 0, cfg, ready(), 1 / 60, rnd).fire).toBe(false);
    expect(decideFire(self, [ahead(50, 0, true)], 5, cfg, ready(), 1 / 60, rnd)).toEqual({
      fire: false,
      fireSecondary: false,
    });
  });
  it('waits out the reaction time on a fresh target', () => {
    const st = newGunnerState(cfg);
    let first = -1;
    for (let i = 0; i < 120 && first < 0; i++)
      if (decideFire(self, [ahead(50)], 0, cfg, st, 1 / 60, rnd).fire) first = i;
    expect(first / 60).toBeGreaterThanOrEqual(cfg.reactionSec - 0.05);
    expect(first / 60).toBeLessThan(cfg.reactionSec + 0.1);
  });
  it('rockets need ammo, range and obey the cooldown', () => {
    const st = ready();
    expect(decideFire(self, [ahead(50)], 0, cfg, st, 1 / 60, rnd).fireSecondary).toBe(false);
    expect(decideFire(self, [ahead(cfg.rocketMinRangeM - 5)], 2, cfg, ready(), 1 / 60, rnd).fireSecondary).toBe(false);
    expect(decideFire(self, [ahead(50)], 2, cfg, st, 1 / 60, rnd).fireSecondary).toBe(true);
    expect(decideFire(self, [ahead(50)], 2, cfg, st, 1 / 60, rnd).fireSecondary).toBe(false);
    // No ammo while waiting, so the loop itself can't fire (and re-arm) the cooldown.
    for (let i = 0; i < cfg.rocketCooldownSec * 60 + 2; i++) decideFire(self, [ahead(50)], 0, cfg, st, 1 / 60, rnd);
    expect(decideFire(self, [ahead(50)], 2, cfg, st, 1 / 60, rnd).fireSecondary).toBe(true);
  });
  it('releases the trigger for a pause sometimes', () => {
    const st = ready();
    expect(decideFire(self, [ahead(50)], 0, cfg, st, 1 / 60, () => 0).fire).toBe(false);
    expect(st.fireCooldown).toBeCloseTo(cfg.pauseSec, 5);
  });
});

describe('AIDriver (headless physics)', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  /** Drives the real spline from the grid until the second start-line crossing; returns the lap time. */
  function lap(carId: string): { lapSec: number; maxOffM: number; simSec: number } {
    const def = getCarDef(carId);
    const path = new TrackPath(CAT_LAI.spline.points, RACE.track.sampleSpacingM, RACE.track.projectWindowSamples);
    const line = new RacingLine(path, RACE.track.sampleSpacingM);
    const world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
    world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setTranslation(0, -0.5, 0));
    const [lat, behind] = CAT_LAI.startLine.grid[0];
    const g = gridPose(path, lat, Math.abs(behind), path.lengthM);
    const car = new CarPhysics(RAPIER, world, def, HANDLING, { x: g.x, y: 0.4, z: g.z, yaw: g.yaw });
    let t = path.project(g.x, g.z);
    const ai = new AIDriver({
      carId,
      line,
      laneOffsetM: 0,
      skill: 0.95,
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
    const crossings: number[] = [];
    let maxOff = 0;
    let step = 0;
    for (; step < 60 * 150 && crossings.length < 2; step++) {
      car.preStep(1 / 60, ai.read());
      world.step();
      car.postStep();
      const prev = t;
      t = path.project(car.curr.p.x, car.curr.p.z, t);
      if (prev > 0.9 && t < 0.1) crossings.push(step / 60);
      const c = path.pointAt(t);
      maxOff = Math.max(maxOff, Math.hypot(car.curr.p.x - c.x, car.curr.p.z - c.z));
    }
    expect(crossings.length, `${carId} finished a lap`).toBe(2);
    return { lapSec: crossings[1] - crossings[0], maxOffM: maxOff, simSec: step / 60 };
  }

  for (const id of ['kestrel_gt', 'rhino_x4', 'wisp_r']) {
    it(`${id} laps the Harbor Loop on the road at a competitive pace`, () => {
      const r = lap(id);
      console.log(`AI lap ${id}: ${r.lapSec.toFixed(1)} s, max offset ${r.maxOffM.toFixed(1)} m`);
      expect(r.simSec).toBeLessThan(150);
      expect(r.maxOffM).toBeLessThan(8.5);
      expect(r.lapSec).toBeGreaterThan(60);
      expect(r.lapSec).toBeLessThan(id === 'kestrel_gt' ? 90 : 110);
      if (id === 'kestrel_gt') expect(r.lapSec).toBeGreaterThan(70);
    });
  }
});
