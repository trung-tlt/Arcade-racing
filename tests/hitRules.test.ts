import { describe, expect, it } from 'vitest';
import { contactDamage, isSideHit, wallHit } from '../src/combat/Contact';
import { COMBAT, CARS, HANDLING, getTrack } from '../src/core/Data';
import { noFireZoneAt } from '../src/race/NoFire';
import { downforceN, openWheelGripMul } from '../src/vehicle/OpenWheel';

const W = COMBAT.wall;
const C = COMBAT.contact;
const fulmine = CARS.find((c) => c.id === 'fulmine_fx')!;
const kestrel = CARS.find((c) => c.id === 'kestrel_gt')!;

describe('wall hits (Armco)', () => {
  it('data: −8 hull and ×0.6 speed head-on, −2 for a scrape under 15°', () => {
    expect([W.hullDamage, W.speedMul, W.glancingHullDamage, W.glancingMaxDeg]).toEqual([8, 0.6, 2, 15]);
  });
  it('a head-on hit costs 8 hull and 40% of the speed', () => {
    expect(wallHit({ x: 0, z: 40 }, { x: 0, z: 5 }, W)).toEqual({ hull: 8, speedMul: 0.6, glancing: false });
    expect(wallHit({ x: 0, z: 40 }, { x: 0, z: 0 }, W)?.glancing).toBe(false); // stopped dead
  });
  it('a steep angle hit deflects the velocity and counts as a full hit', () => {
    const a = (30 * Math.PI) / 180;
    expect(wallHit({ x: 0, z: 40 }, { x: Math.sin(a) * 25, z: Math.cos(a) * 25 }, W)?.hull).toBe(8);
  });
  it('a scrape that barely changes direction costs 2 hull and keeps the speed', () => {
    const a = (12 * Math.PI) / 180; // slides along the wall at 12°: keeps cos(12°) of its speed and turns 12°
    const keep = 60 * Math.cos(a);
    expect(wallHit({ x: 0, z: 60 }, { x: Math.sin(a) * keep, z: Math.cos(a) * keep }, W)).toEqual({
      hull: 2,
      speedMul: 1,
      glancing: true,
    });
  });
  it('ignores speed loss under the thresholds', () => {
    expect(wallHit({ x: 0, z: 20 }, { x: 0, z: 19.5 }, W)).toBeNull(); // under minGlancingImpactMps
    expect(wallHit({ x: 0, z: 20 }, { x: 0, z: 17.5 }, W)).toBeNull(); // steep but under minImpactMps
  });
});

describe('contact damage and side hits', () => {
  it('open-wheel cars take 1.5× contact damage and nothing under the threshold', () => {
    expect(contactDamage(3, true, C)).toBe(0);
    const base = contactDamage(10, false, C);
    expect(contactDamage(10, true, C)).toBeCloseTo(base * 1.5, 1);
    expect(contactDamage(14, true, C)).toBeGreaterThan(contactDamage(8, true, C));
  });
  it('a side hit is beside the car, not ahead or behind', () => {
    expect(isSideHit(0, 1.8, 0.2, C)).toBe(true); // victim facing +Z, other to its left
    expect(isSideHit(0, -1.8, 0.2, C)).toBe(true);
    expect(isSideHit(0, 0.2, 3, C)).toBe(false);
    expect(isSideHit(Math.PI / 2, 0.2, -3, C)).toBe(true); // victim turned left: its left axis now points to -Z
  });
});

describe('open-wheel downforce and grip', () => {
  it('Fulmine FX: downforce ∝ v², zero for other cars, capped by weight', () => {
    const g = Math.abs(HANDLING.world.gravity);
    const a = downforceN(fulmine, 40, HANDLING, g);
    expect(a).toBeCloseTo(fulmine.downforce! * HANDLING.openWheel.downforceCoef * 1600, 6);
    expect(downforceN(fulmine, 80, HANDLING, g)).toBeCloseTo(a * 4, 6);
    expect(downforceN(kestrel, 80, HANDLING, g)).toBe(0);
    expect(downforceN(fulmine, 1000, HANDLING, g)).toBe(HANDLING.openWheel.maxDownforceWeightMul * fulmine.massKg * g);
  });
  it('grip ×1.25 above 150 km/h, eased in, never for other cars', () => {
    expect(openWheelGripMul(fulmine, 100 / 3.6, HANDLING)).toBe(1);
    expect(openWheelGripMul(fulmine, 150 / 3.6, HANDLING)).toBe(1);
    expect(openWheelGripMul(fulmine, 160 / 3.6, HANDLING)).toBeGreaterThan(1);
    expect(openWheelGripMul(fulmine, 200 / 3.6, HANDLING)).toBeCloseTo(1.25, 6);
    expect(openWheelGripMul(kestrel, 300 / 3.6, HANDLING)).toBe(1);
  });
});

describe('no-fire zones', () => {
  const zones = getTrack('monte_carlo').noFireZones;
  it('Monaco has the tunnel and the Nouvelle Chicane; other maps none', () => {
    expect(zones.map((z) => z.name)).toEqual(['Tunnel', 'Nouvelle Chicane']);
    expect(getTrack('cong_hoa').noFireZones).toEqual([]);
  });
  it('finds the zone covering t, wrapping the lap', () => {
    expect(noFireZoneAt(zones, 0.5)?.name).toBe('Tunnel');
    expect(noFireZoneAt(zones, 1.5)?.name).toBe('Tunnel');
    expect(noFireZoneAt(zones, 0.64)?.name).toBe('Nouvelle Chicane');
    expect(noFireZoneAt(zones, 0.3)).toBeNull();
    expect(noFireZoneAt(zones, 0.578)).toBeNull(); // the tunnel ends at toT
    expect(noFireZoneAt([], 0.5)).toBeNull();
  });
});
