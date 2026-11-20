import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { wallHit } from '../src/combat/Contact';
import { CARS, COMBAT, HANDLING } from '../src/core/Data';
import { CarPhysics, IDLE_CONTROLS } from '../src/vehicle/CarPhysics';

beforeAll(async () => {
  await RAPIER.init();
});

/** A Fulmine FX driven into a static wall on a flat plane: the real physics feeds the hit rules. */
function drive(wallAngleDeg: number): { hits: ReturnType<typeof wallHit>[]; impact: number } {
  const def = CARS.find((c) => c.id === 'fulmine_fx')!;
  const world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
  world.timestep = 1 / 60;
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0)).setFriction(1);
  const a = (wallAngleDeg * Math.PI) / 180;
  // The wall's face is at z = 120 (head-on), or tilted by `a` about Y.
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(0, 1.5, 120)
      .setRotation({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1.5, 0.5).setFriction(0.3), body);
  const car = new CarPhysics(RAPIER, world, def, HANDLING, { x: 0, y: 0.5, z: 0, yaw: 0 });
  const hits: ReturnType<typeof wallHit>[] = [];
  let impact = 0;
  for (let i = 0; i < 60 * 14; i++) {
    car.preStep(1 / 60, { ...IDLE_CONTROLS, throttle: 1 });
    world.step();
    car.postStep();
    impact = Math.max(impact, car.impactStrength);
    const h = wallHit(car.velBefore, car.velAfter, COMBAT.wall);
    if (h) hits.push(h);
  }
  return { hits, impact };
}

describe('wall rules against the real physics', () => {
  it('a head-on hit at speed registers a full hit (−8, ×0.6)', () => {
    const r = drive(0);
    expect(r.impact).toBeGreaterThan(COMBAT.wall.minImpactMps);
    const full = r.hits.find((h) => h && !h.glancing);
    expect(full).toEqual({ hull: 8, speedMul: 0.6, glancing: false });
  });
  it('an angled wall registers a hit and never costs more than a full hit', () => {
    const r = drive(60); // the car meets the wall at about 30°
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect(h && h.hull).toBeLessThanOrEqual(8);
  });
});
