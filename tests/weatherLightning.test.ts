import { describe, expect, it } from 'vitest';
import { PHAM_VAN_DONG, type WeatherDef } from '../src/core/Data';
import { flashLevel, LightningScheduler } from '../src/weather/lightning';

const W = PHAM_VAN_DONG.weather as WeatherDef;
const L = W.lightning;

/** Small seeded generator (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('lightning scheduler', () => {
  it('strikes every 18-40 s, with thunder 0.8-3 s later', () => {
    const s = new LightningScheduler(L, 55, seeded(7));
    const times: number[] = [];
    let now = 0;
    for (let i = 0; i < 60 * 600; i++) {
      now += 1 / 60;
      const k = s.update(1 / 60);
      if (k) {
        times.push(now);
        expect(k.thunderDelaySec).toBeGreaterThanOrEqual(0.8);
        expect(k.thunderDelaySec).toBeLessThanOrEqual(3);
        expect(Math.abs(k.azimuthDeg)).toBeLessThanOrEqual(55);
        expect(k.distanceK).toBeGreaterThanOrEqual(0);
        expect(k.distanceK).toBeLessThanOrEqual(1);
      }
    }
    expect(times.length).toBeGreaterThan(10);
    expect(times[0]).toBeGreaterThanOrEqual(18 - 0.05);
    expect(times[0]).toBeLessThanOrEqual(40 + 0.05);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(18 - 0.05);
      expect(times[i] - times[i - 1]).toBeLessThanOrEqual(40 + 0.05);
    }
  });
  it('is deterministic for a seed', () => {
    const run = (seed: number) => {
      const s = new LightningScheduler(L, 55, seeded(seed));
      return Array.from({ length: 3 }, () => {
        let k = null;
        while (!k) k = s.update(0.5);
        return k.thunderDelaySec;
      });
    };
    expect(run(3)).toEqual(run(3));
    expect(run(3)).not.toEqual(run(4));
  });
});

describe('flash envelope', () => {
  const pat = [1, 0.25, 1];
  it('is a double flash lasting 0.18 s', () => {
    expect(L.flash.double).toBe(true);
    expect(flashLevel(-0.01, L.flash, pat)).toBe(0);
    expect(flashLevel(0.01, L.flash, pat)).toBeGreaterThan(0.8); // first flash
    expect(flashLevel(0.09, L.flash, pat)).toBeLessThan(0.4); // the dip between
    expect(flashLevel(0.15, L.flash, pat)).toBeGreaterThan(0.5); // second flash
    expect(flashLevel(L.flash.durationSec, L.flash, pat)).toBe(0);
  });
  it('a single flash simply fades out', () => {
    const single = { ...L.flash, double: false };
    expect(flashLevel(0, single, pat)).toBe(1);
    expect(flashLevel(single.durationSec / 2, single, pat)).toBeCloseTo(0.5, 5);
  });
});
