import { describe, expect, it } from 'vitest';
import { RollingWindow } from '../src/net/RollingWindow';

describe('RollingWindow', () => {
  it('reads mean, percentile and max over the last samples only', () => {
    const w = new RollingWindow(4);
    expect([w.count, w.mean(), w.max(), w.percentile(0.95)]).toEqual([0, 0, 0, 0]);
    for (const v of [1, 2, 3, 4, 100]) w.push(v); // 1 falls out
    expect(w.count).toBe(4);
    expect(w.max()).toBe(100);
    expect(w.mean()).toBeCloseTo(27.25);
    expect(w.percentile(0.5)).toBe(4);
    expect(w.percentile(0.99)).toBe(100);
  });
});
