import { describe, expect, it } from 'vitest';
import { bestLapText, loadBestLap, saveBestLap } from '../src/core/Records';

const fake = (): {
  d: Record<string, string>;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
} => {
  const d: Record<string, string> = {};
  return { d, getItem: (k) => d[k] ?? null, setItem: (k, v) => void (d[k] = v) };
};

describe('best lap record', () => {
  it('stores the first lap and only improvements', () => {
    const s = fake();
    expect(loadBestLap('cat_lai', s)).toBeNull();
    expect(saveBestLap('cat_lai', 70.5, 'Kestrel GT', s)).toBe(true);
    expect(saveBestLap('cat_lai', 72, 'Kestrel GT', s)).toBe(false);
    expect(saveBestLap('cat_lai', 64.912, 'Wisp R', s)).toBe(true);
    expect(loadBestLap('cat_lai', s)).toEqual({ ms: 64912, car: 'Wisp R' });
  });
  it('survives corrupt storage and missing storage', () => {
    const s = fake();
    s.setItem('voltline.bestLap', '{nope');
    expect(loadBestLap('cat_lai', s)).toBeNull();
    expect(saveBestLap('cat_lai', 60, 'x', null)).toBe(false);
  });
  it('formats text', () => {
    expect(bestLapText({ ms: 64912, car: 'Kestrel GT' })).toBe('1:04.912 · Kestrel GT');
    expect(bestLapText(null)).toBe('No lap yet');
  });
});

describe('per-map records', () => {
  it('keeps maps separate', () => {
    const s = fake();
    expect(saveBestLap('cat_lai', 70, 'Kestrel GT', s)).toBe(true);
    expect(loadBestLap('cong_hoa', s)).toBeNull();
    expect(saveBestLap('cong_hoa', 90, 'Wisp R', s)).toBe(true);
    expect(loadBestLap('cat_lai', s)).toEqual({ ms: 70000, car: 'Kestrel GT' });
    expect(loadBestLap('cong_hoa', s)).toEqual({ ms: 90000, car: 'Wisp R' });
  });
  it('ignores the old pre-maps key (Harbor Loop is gone)', () => {
    const s = fake();
    s.setItem('voltline.bestLap', JSON.stringify({ ms: 64912, car: 'Kestrel GT' }));
    expect(loadBestLap('cat_lai', s)).toBeNull();
  });
});
