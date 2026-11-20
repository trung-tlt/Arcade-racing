import { describe, expect, it } from 'vitest';
import { CARS, type CarDef } from '../src/core/Data';

// No ultra car: speed, armour, firepower and handling are traded against each other.
const MAX_SPEED = Math.max(...CARS.map((c) => c.topSpeedKmh));
const MAX_HP = Math.max(...CARS.map((c) => c.hp));
const FP = (c: CarDef): number => c.gunDamageMul / c.gunHeatMul;
const MAX_FP = Math.max(...CARS.map(FP));
const budget = (c: CarDef): number =>
  c.topSpeedKmh / MAX_SPEED + c.hp / MAX_HP + FP(c) / MAX_FP + 0.5 * ((c.handling + c.accel) / 20);

describe('vehicle balance', () => {
  const total = CARS.map(budget);
  const mean = total.reduce((a, b) => a + b, 0) / total.length;

  it('no vehicle is better at everything: every total stays near the garage average', () => {
    for (const c of CARS) {
      expect(budget(c) / mean, c.id).toBeGreaterThan(0.7);
      expect(budget(c) / mean, c.id).toBeLessThan(1.15);
    }
  });

  it('the fastest vehicles have the weakest armour and the weakest guns', () => {
    const byspeed = [...CARS].sort((a, b) => b.topSpeedKmh - a.topSpeedKmh);
    const fast = byspeed.slice(0, 3);
    const slow = byspeed.slice(-3);
    const avg = (l: CarDef[], f: (c: CarDef) => number): number => l.reduce((a, c) => a + f(c), 0) / l.length;
    expect(avg(fast, (c) => c.hp)).toBeLessThan(avg(slow, (c) => c.hp));
    expect(avg(fast, FP)).toBeLessThan(avg(slow, FP));
  });

  it('the single fastest vehicle is the most fragile racer with a weaker gun than the average', () => {
    const fastest = [...CARS].sort((a, b) => b.topSpeedKmh - a.topSpeedKmh)[0];
    expect(fastest.hp).toBe(Math.min(...CARS.map((c) => c.hp)));
    expect(FP(fastest)).toBeLessThan(1);
  });
});
