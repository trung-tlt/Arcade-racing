import { describe, expect, it } from 'vitest';
import { NitroTank, slipAngleDeg } from '../src/vehicle/Nitro';

describe('NitroTank', () => {
  it('caps at max bars and reports bars crossed', () => {
    const t = new NitroTank(3, 0.05);
    expect(t.add(0.6)).toBe(0);
    expect(t.add(0.6)).toBe(1);
    t.add(10);
    expect(t.bars).toBe(3);
  });
  it('burns one bar per barSec and stops at empty', () => {
    const t = new NitroTank(3, 0.05);
    t.add(1);
    for (let i = 0; i < 60 * 2; i++) t.update(true, 1 / 60, 2.5);
    expect(t.bars).toBeCloseTo(1 - 2 / 2.5, 2);
    for (let i = 0; i < 60 * 3; i++) t.update(true, 1 / 60, 2.5);
    expect(t.bars).toBe(0);
    expect(t.active).toBe(false);
  });
  it('needs a minimum charge to start', () => {
    const t = new NitroTank(3, 0.05);
    t.add(0.01);
    expect(t.update(true, 1 / 60, 2.5)).toBe(false);
  });
});

describe('slipAngleDeg', () => {
  it('is zero when going straight and 45 when sliding equally', () => {
    expect(slipAngleDeg(20, 0)).toBe(0);
    expect(slipAngleDeg(20, 20)).toBeCloseTo(45, 5);
    expect(slipAngleDeg(-20, -20)).toBeCloseTo(45, 5);
  });
});
