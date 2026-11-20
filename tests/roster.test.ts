import { describe, expect, it } from 'vitest';
import { AI, CARS } from '../src/core/Data';
import { applyTrackRoster, rollRoster } from '../src/ai/Roster';

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

describe('track rosters (Map 5 open-wheel grid)', () => {
  const rosters = AI.trackRosters as Record<string, import('../src/ai/Roster').TrackRoster>;
  it('data: monte_carlo fields fulmine_fx with at least as many liveries as rivals', () => {
    expect(rosters.monte_carlo.car).toBe('fulmine_fx');
    expect(rosters.monte_carlo.liveries.length).toBeGreaterThanOrEqual(AI.rivals.length);
    for (const l of rosters.monte_carlo.liveries) {
      for (const c of [l.paint, l.accent, l.glow]) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
  it('gives every rival the car in a different livery, keeping names and driving traits', () => {
    const base = rollRoster(AI.rivals, AI.rosterNames, ids, 'kestrel_gt', seeded(7));
    const r = applyTrackRoster(base, 'monte_carlo', rosters, seeded(9));
    expect(r.every((x) => x.car === 'fulmine_fx')).toBe(true);
    expect(new Set(r.map((x) => x.livery?.paint)).size).toBe(r.length);
    r.forEach((x, i) => expect([x.id, x.name, x.skill]).toEqual([base[i].id, base[i].name, base[i].skill]));
  });
  it('leaves other maps alone', () => {
    const base = rollRoster(AI.rivals, AI.rosterNames, ids, 'kestrel_gt', seeded(7));
    expect(applyTrackRoster(base, 'cat_lai', rosters)).toEqual(base);
  });
});
