import { beforeAll, describe, expect, it } from 'vitest';
import congHoa from '../data/tracks/cong_hoa.json';
import {
  type DressingPlan,
  type DressingSpec,
  KERB_M,
  MAX_PARKED_SCOOTERS,
  boulevardRuns,
  interpolateCentre,
  minDistToPath,
  planCongHoa,
  rectPoints,
  rotateLocal,
  seededRng,
  sidewalkSites,
  specFromTrack,
} from '../src/world/CongHoaDressing';
import { corridorCentreline, findOpposites } from '../src/world/Corridor';
import { TrackPath } from '../src/world/TrackPath';

const path = new TrackPath(congHoa.spline.points, 2, 40);
const spec: DressingSpec = specFromTrack(congHoa as unknown as Record<string, unknown>);
const WIDTHS = [6, 4, 5, 5];
const half = spec.carriagewayWidthM / 2;
const roadEdge = half + KERB_M; // carriageway + kerb stone
const bandOuter = roadEdge + spec.sidewalkWidthM; // + sidewalk

let plan: DressingPlan;
beforeAll(() => {
  plan = planCongHoa(path, spec, WIDTHS);
});

describe('layout helpers', () => {
  it('seededRng is deterministic and in [0,1)', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    for (let i = 0; i < 20; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('rotateLocal follows three.js rotation.y', () => {
    const o = rotateLocal(0, 1, Math.PI / 2); // local +Z turned by +90° about Y points at +X
    expect(o.x).toBeCloseTo(1, 6);
    expect(o.z).toBeCloseTo(0, 6);
  });
  it('rectPoints covers the rectangle', () => {
    const pts = rectPoints(10, 20, 3, 7, 0);
    expect(pts).toHaveLength(25);
    expect(Math.max(...pts.map((p) => p.x))).toBeCloseTo(13, 6);
    expect(Math.min(...pts.map((p) => p.z))).toBeCloseTo(13, 6);
  });
  it('interpolateCentre is linear and clamped', () => {
    const pts = [
      { x: 0, z: 0, tx: 0, tz: 1, n: 0 },
      { x: 0, z: 10, tx: 0, tz: 1, n: 10 },
    ];
    expect(interpolateCentre(pts, 5).z).toBeCloseTo(5, 6);
    expect(interpolateCentre(pts, -3).z).toBe(0);
    expect(interpolateCentre(pts, 99).z).toBe(10);
  });
  it('sidewalkSites steps along a run on the right-hand side', () => {
    const opp = findOpposites(path);
    const runs = boulevardRuns(path, opp);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    const sites = sidewalkSites(path, runs, 35, 0, 8);
    expect(sites.length).toBeGreaterThan(60);
    for (const s of sites) expect(minDistToPath(path, s.x, s.z)).toBeGreaterThan(7.5);
  });
});

describe('Cong Hoa Boulevard dressing plan', () => {
  it('is deterministic', () => {
    const again = planCongHoa(path, spec, WIDTHS);
    expect(again.houses.length).toBe(plan.houses.length);
    expect(again.scooters.length).toBe(plan.scooters.length);
    expect(again.houses[10]).toEqual(plan.houses[10]);
  });

  it('packs shophouse rows close to the spec counts on both sides', () => {
    const west = plan.houses.filter((h) => h.side === 1);
    const east = plan.houses.filter((h) => h.side === -1);
    console.log(
      `PLAN houses W=${west.length} E=${east.length} fence=${plan.fence.length} towers=${plan.towers.length} median=${plan.median.length} medianTrees=${plan.medianTrees.length} poles=${plan.poles.length} spans=${plan.spans.length} trees=${plan.trees.length} bus=${plan.busStops.length} scooters=${plan.scooters.length}`,
    );
    expect(west.length).toBeGreaterThan(80);
    expect(east.length).toBeGreaterThan(110);
    expect(west.length).toBeLessThanOrEqual(spec.rowsWest);
    expect(east.length).toBeLessThanOrEqual(spec.rowsEast);
  });

  it('honours the skip ranges: no west houses over the fence, no east houses at the towers', () => {
    for (const h of plan.houses) {
      if (h.side === 1) expect(h.n < spec.fence.fromN || h.n > spec.fence.toN).toBe(true);
      else expect(h.n < spec.towers.fromN || h.n > spec.towers.toN).toBe(true);
    }
    expect(plan.houses.some((h) => h.side === 1 && h.n > 700)).toBe(true);
    expect(plan.houses.some((h) => h.side === -1 && h.n > 950 && h.n < 1250)).toBe(false);
  });

  it('puts the fence on the west side over n 100–700 and exactly 3 towers on the east', () => {
    const centre = corridorCentreline(path, findOpposites(path), 2);
    const nOf = (x: number, z: number): number => {
      let best = centre[0];
      let bd = Infinity;
      for (const c of centre) {
        const d = Math.hypot(c.x - x, c.z - z);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      return best.n;
    };
    expect(plan.fence.length).toBeGreaterThan(50);
    expect(plan.fence.length).toBeLessThanOrEqual(62);
    for (const f of plan.fence) {
      const n = nOf(f.x, f.z);
      expect(n).toBeGreaterThan(spec.fence.fromN - 12);
      expect(n).toBeLessThan(spec.fence.toN + 12);
      // On the left of the outbound travel direction (west), 26 m from the median centre line = ~17 m from the road.
      const d = minDistToPath(path, f.x, f.z);
      expect(d).toBeGreaterThan(14);
      expect(d).toBeLessThan(20);
    }
    expect(plan.towers).toHaveLength(spec.towers.count);
    for (const t of plan.towers) expect(nOf(t.x, t.z)).toBeGreaterThan(spec.towers.fromN - 10);
  });

  it('keeps houses, towers and the fence clear of every road, kerb and sidewalk (dense grid)', () => {
    // House footprint: width w, 14 m behind the facade, origin on the facade centre.
    const sides: { x: number; z: number }[] = [];
    for (const h of plan.houses) {
      for (const fx of [-1, 0, 1]) {
        for (let d = 0; d <= 14; d += 1.75) {
          const o = rotateLocal(fx * (h.width / 2), -d, h.yaw);
          sides.push({ x: h.x + o.x, z: h.z + o.z });
        }
      }
    }
    for (const t of plan.towers) for (const p of rectPoints(t.x, t.z, 15, 13, t.yaw)) sides.push(p);
    for (const f of plan.fence) sides.push({ x: f.x, z: f.z });
    let worst = Infinity;
    for (const p of sides) worst = Math.min(worst, minDistToPath(path, p.x, p.z));
    console.log(
      `PLAN closest house/tower/fence point to any road centre line: ${worst.toFixed(1)} m (band edge ${bandOuter.toFixed(2)})`,
    );
    expect(worst).toBeGreaterThan(bandOuter);
  });

  it('keeps the median between the carriageways and off the road', () => {
    expect(plan.median.length).toBeGreaterThan(100);
    for (const m of plan.median) expect(minDistToPath(path, m.x, m.z)).toBeGreaterThanOrEqual(roadEdge + 1.5);
    for (const t of plan.medianTrees) expect(minDistToPath(path, t.x, t.z)).toBeGreaterThanOrEqual(roadEdge + 1.5);
    expect(plan.medianTrees.length).toBeGreaterThan(40);
  });

  it('puts sidewalk items on the sidewalk: off the road, inside the sidewalk band', () => {
    const items = [...plan.poles, ...plan.trees, ...plan.busStops, ...plan.scooters];
    expect(items.length).toBeGreaterThan(300);
    for (const it of items) {
      const d = minDistToPath(path, it.x, it.z);
      expect(d).toBeGreaterThanOrEqual(roadEdge + 0.35);
      expect(d).toBeLessThanOrEqual(bandOuter);
    }
  });

  it('spaces poles about every 35 m and links consecutive ones with cable spans', () => {
    expect(plan.poles.length).toBeGreaterThan(60);
    expect(plan.spans.length).toBeGreaterThan(plan.poles.length * 0.8);
    for (const s of plan.spans) {
      const a = plan.poles[s.a];
      const b = plan.poles[s.b];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      expect(d).toBeGreaterThan(25);
      expect(d).toBeLessThan(37); // arc spacing is 35 m; the chord is a little longer on a curve
    }
  });

  it('places bus stops about every 400 m and caps parked scooters', () => {
    expect(plan.busStops.length).toBeGreaterThanOrEqual(3);
    expect(plan.busStops.length).toBeLessThanOrEqual(10);
    expect(plan.scooters.length).toBeGreaterThan(100);
    expect(plan.scooters.length).toBeLessThanOrEqual(MAX_PARKED_SCOOTERS);
  });
});
