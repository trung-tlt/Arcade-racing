import { describe, expect, it } from 'vitest';
import { AI, CARS } from '../src/core/Data';
import { rollRoster } from '../src/ai/Roster';

const ids = CARS.map((c) => c.id);
const seeded = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

describe('rival roster', () => {
  it('data lists the ten names', () => {
    expect(AI.rosterNames).toEqual(['Nhi', 'Vy', 'Linh', 'Ngọc', 'Hân', 'Huy', 'Khang', 'Bảo', 'Minh', 'Phúc']);
  });
  it('gives five distinct names from the list and five distinct cars that are not the player', () => {
    for (let s = 1; s <= 40; s++) {
      const r = rollRoster(AI.rivals, AI.rosterNames, ids, 'kestrel_gt', seeded(s));
      expect(r).toHaveLength(AI.rivals.length);
      expect(new Set(r.map((x) => x.name)).size).toBe(r.length);
      expect(new Set(r.map((x) => x.car)).size).toBe(r.length);
      const allowed = AI.rosterNames.map((n) => n.toLocaleUpperCase('vi'));
      for (const x of r) {
        expect(allowed).toContain(x.name);
        expect(ids).toContain(x.car);
        expect(x.car).not.toBe('kestrel_gt');
      }
    }
  });
  it('keeps each slot’s driving traits and varies between rolls', () => {
    const a = rollRoster(AI.rivals, AI.rosterNames, ids, 'wisp_r', seeded(1));
    const b = rollRoster(AI.rivals, AI.rosterNames, ids, 'wisp_r', seeded(2));
    a.forEach((x, i) =>
      expect([x.id, x.laneOffsetM, x.skill]).toEqual([AI.rivals[i].id, AI.rivals[i].laneOffsetM, AI.rivals[i].skill]),
    );
    expect(a.map((x) => x.name + x.car)).not.toEqual(b.map((x) => x.name + x.car));
  });
  it('still works with a tiny garage or name list', () => {
    const r = rollRoster(AI.rivals, ['Vy'], ['wisp_r'], 'wisp_r', seeded(3));
    expect(r.every((x) => x.name === 'VY' && x.car === 'wisp_r')).toBe(true);
  });
});
