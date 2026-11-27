import { describe, expect, it } from 'vitest';
import { DeepWatch } from '../src/sim/Recovery';

describe('DeepWatch', () => {
  it('fires once after the hold, and again only after the car came back up', () => {
    const w = new DeepWatch();
    const fired: boolean[] = [];
    for (let i = 0; i < 12; i++) fired.push(w.update(0.1, 1.6, 0.5));
    expect(fired.filter(Boolean)).toHaveLength(1);
    expect(fired.indexOf(true)).toBe(4);
    expect(w.update(0.1, 0.1, 0.5)).toBe(false);
    for (let i = 0; i < 4; i++) expect(w.update(0.1, 1.6, 0.5)).toBe(false);
    expect(w.update(0.1, 1.6, 0.5)).toBe(true);
  });

  it('a short dip or a missing surface never fires', () => {
    const w = new DeepWatch();
    for (let i = 0; i < 3; i++) expect(w.update(0.1, 1.6, 0.5)).toBe(false);
    expect(w.update(0.1, 0.1, 0.5)).toBe(false);
    for (let i = 0; i < 3; i++) expect(w.update(0.1, null, 0.5)).toBe(false);
  });
});
