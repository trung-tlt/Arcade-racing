import { describe, expect, it } from 'vitest';
import { quadFor } from '../src/fx/Skidmarks';
import { streakParams } from '../src/fx/SpeedLines';

describe('quadFor', () => {
  it('heading +Z puts the left corners on +X', () => {
    const q = quadFor({ x: 0, z: 0 }, { x: 0, z: 2 }, 0.14);
    expect(q.prevL.x).toBeCloseTo(0.14);
    expect(q.prevR.x).toBeCloseTo(-0.14);
    expect(q.currL).toEqual({ x: expect.closeTo(0.14, 5), z: expect.closeTo(2, 5) });
    expect(q.currR.z).toBeCloseTo(2);
  });
  it('heading +X puts the left corners on -Z', () => {
    const q = quadFor({ x: 1, z: 1 }, { x: 4, z: 1 }, 0.2);
    expect(q.prevL.z).toBeCloseTo(0.8);
    expect(q.prevR.z).toBeCloseTo(1.2);
    expect(q.currL.x).toBeCloseTo(4);
  });
  it('ribbon width is twice the half width and a zero-length step does not produce NaN', () => {
    const q = quadFor({ x: 3, z: 4 }, { x: 5, z: 7 }, 0.3);
    expect(Math.hypot(q.prevL.x - q.prevR.x, q.prevL.z - q.prevR.z)).toBeCloseTo(0.6);
    const z = quadFor({ x: 1, z: 1 }, { x: 1, z: 1 }, 0.1);
    expect(Number.isNaN(z.currL.x)).toBe(false);
  });
  it('reuses an output object when given one', () => {
    const out = quadFor({ x: 0, z: 0 }, { x: 0, z: 1 }, 1);
    expect(quadFor({ x: 0, z: 0 }, { x: 1, z: 0 }, 1, out)).toBe(out);
  });
});

describe('streakParams', () => {
  it('grows with intensity and is empty at zero', () => {
    const lo = streakParams(0, false);
    const mid = streakParams(0.5, false);
    const hi = streakParams(1, false);
    expect(lo.count).toBe(0);
    expect(mid.count).toBeGreaterThan(lo.count);
    expect(hi.count).toBeGreaterThan(mid.count);
    expect(hi.length).toBeGreaterThan(mid.length);
    expect(hi.alpha).toBeGreaterThan(mid.alpha);
  });
  it('clamps out-of-range intensity and halves for reduced motion', () => {
    expect(streakParams(5, false)).toEqual(streakParams(1, false));
    const full = streakParams(1, false);
    const calm = streakParams(1, true);
    expect(calm.count).toBe(Math.round(full.count / 2));
    expect(calm.length).toBeCloseTo(full.length / 2);
  });
});
