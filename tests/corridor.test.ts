import { describe, expect, it } from 'vitest';
import { corridorCentreline, findOpposites, medianSites, type CorridorPath } from '../src/world/Corridor';
import congHoa from '../data/tracks/cong_hoa.json';
import { TrackPath } from '../src/world/TrackPath';

/** A straight out-and-back: east carriageway heading +Z, west carriageway heading -Z, 18 m apart. */
function outAndBack(lengthM: number, stepM: number): CorridorPath {
  const half = Math.round(lengthM / stepM);
  const n = half * 2;
  const px = new Float32Array(n);
  const pz = new Float32Array(n);
  const tx = new Float32Array(n);
  const tz = new Float32Array(n);
  for (let i = 0; i < half; i++) {
    px[i] = 9;
    pz[i] = i * stepM;
    tz[i] = 1;
    px[half + i] = -9;
    pz[half + i] = lengthM - i * stepM;
    tz[half + i] = -1;
  }
  return { count: n, spacingM: stepM, lengthM: n * stepM, px, pz, tx, tz };
}

describe('corridor geometry', () => {
  it('pairs the two carriageways of an out-and-back road', () => {
    const p = outAndBack(1000, 2);
    const opp = findOpposites(p, { minArcM: 150, maxDistM: 24 });
    const mid = 100; // first leg
    expect(opp[mid]).toBeGreaterThan(p.count / 2);
    expect(Math.abs(p.pz[opp[mid]] - p.pz[mid])).toBeLessThan(2.1);
    expect(p.px[opp[mid]]).toBe(-9);
  });
  it('places median tiles midway between the carriageways, every tileM', () => {
    const p = outAndBack(1000, 2);
    const opp = findOpposites(p);
    const sites = medianSites(p, opp, 10);
    expect(sites.length).toBeGreaterThan(80);
    expect(sites.length).toBeLessThan(110);
    for (const s of sites) {
      expect(s.x).toBeCloseTo(0, 5);
      expect(s.gapM).toBeGreaterThanOrEqual(17.99);
      expect(s.gapM).toBeLessThan(24);
    }
  });
  it('builds a centre line with n increasing along the road', () => {
    const p = outAndBack(1000, 2);
    const c = corridorCentreline(p, findOpposites(p), 5);
    expect(c[0].n).toBe(0);
    expect(c[c.length - 1].n).toBeGreaterThan(800);
    for (let i = 1; i < c.length; i++) expect(c[i].n).toBeGreaterThan(c[i - 1].n);
  });
});

describe('Cong Hoa Boulevard corridor', () => {
  const path = new TrackPath(congHoa.spline.points, 2, 40);
  const opp = findOpposites(path);
  it('has a long paired stretch for median, overpasses and building rows', () => {
    const paired = Array.from(opp).filter((j) => j >= 0).length;
    expect(paired * path.spacingM).toBeGreaterThan(1800);
  });
  it('does not pair the roundabout with itself', () => {
    const roundaboutStart = Math.floor(0.9 * path.count);
    const withOpp = Array.from(opp.slice(roundaboutStart)).filter((j) => j >= 0).length;
    expect(withOpp).toBeLessThan((path.count - roundaboutStart) * 0.8);
  });
  it('yields median sites about every 10 m with a sane gap', () => {
    const sites = medianSites(path, opp, 10);
    expect(sites.length).toBeGreaterThan(100);
    const gaps = sites.map((s) => s.gapM).sort((a, b) => a - b);
    console.log(
      `CORRIDOR sites=${sites.length} gap min=${gaps[0].toFixed(1)} med=${gaps[gaps.length >> 1].toFixed(1)} max=${gaps[gaps.length - 1].toFixed(1)}`,
    );
    expect(gaps[gaps.length >> 1]).toBeGreaterThan(14);
    expect(gaps[gaps.length >> 1]).toBeLessThan(24);
  });
});
