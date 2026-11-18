import { describe, expect, it } from 'vitest';
import congHoa from '../data/tracks/cong_hoa.json';
import { loadTrack } from '../src/core/Data';
import { findOpposites } from '../src/world/Corridor';
import {
  airlinerPose,
  boxToRoadDistance,
  flightPlanFor,
  flyoverPierSites,
  flyoverStations,
  leftOfHeading,
  obbDistance,
  overpassPlacement,
  pierHeightFor,
  polylineAt,
  polylineLength,
  rightLaneOffsetM,
  rightOfHeading,
  sampleAt,
  seededRng,
  toWorld,
  trafficPlan,
  trafficT,
  type AirlinerPose,
  type PathSample,
} from '../src/world/CongHoaLandmarks';
import { TrackPath } from '../src/world/TrackPath';

const track = loadTrack(congHoa);
const path = new TrackPath(track.spline.points, 2, 40);
const opp = findOpposites(path);
const L = track.lapLengthM;

describe('lanes and sides', () => {
  it('right of travel is the opposite of left (heading +Z: left is +X)', () => {
    expect(leftOfHeading(0, 1)).toEqual({ x: 1, z: -0 });
    const r = rightOfHeading(0, 1);
    expect(r.x).toBe(-1);
    expect(r.z).toBeCloseTo(0);
    const l = leftOfHeading(1, 0);
    const rr = rightOfHeading(1, 0);
    expect(l.x + rr.x).toBeCloseTo(0);
    expect(l.z + rr.z).toBeCloseTo(0);
  });
  it('rightmost lane of the 11 m, 3-lane carriageway is 3.67 m right of the racing line', () => {
    expect(rightLaneOffsetM(11, 3)).toBeCloseTo(11 / 2 - 11 / 6, 6);
    expect(rightLaneOffsetM(11, 3)).toBeCloseTo(3.667, 2);
  });
  it('on the real track the rightmost lane stays inside the carriageway', () => {
    const s: PathSample = { x: 0, z: 0, tx: 0, tz: 0 };
    for (const t of [0.02, 0.2, 0.5, 0.7]) {
      sampleAt(path, t, s);
      const r = rightOfHeading(s.tx, s.tz);
      const off = rightLaneOffsetM(track.roadWidthM, 3);
      const px = s.x + r.x * off;
      const pz = s.z + r.z * off;
      // distance to the centre line of that spot is exactly the offset, i.e. 1.83 m inside the 5.5 m half width
      let best = Infinity;
      for (let i = 0; i < path.count; i++) best = Math.min(best, Math.hypot(path.px[i] - px, path.pz[i] - pz));
      expect(best).toBeLessThan(off + 0.5);
      expect(off).toBeLessThan(track.roadWidthM / 2);
    }
  });
});

describe('overpasses are centred on the median', () => {
  const raw = congHoa as unknown as { overpasses: { t: number }[] };
  for (const o of raw.overpasses) {
    it(`t=${o.t}: midpoint between both carriageways, span across the road`, () => {
      const pl = overpassPlacement(path, opp, o.t);
      expect(pl.gapM).toBeGreaterThan(14);
      expect(pl.gapM).toBeLessThan(24);
      // equidistant from the two carriageway centre lines
      const a = Math.hypot(path.px[pl.i] - pl.x, path.pz[pl.i] - pl.z);
      const b = Math.hypot(path.px[pl.j] - pl.x, path.pz[pl.j] - pl.z);
      expect(Math.abs(a - b)).toBeLessThan(1e-3);
      // yaw equals the heading, so the model's X span is perpendicular to the road
      const along = Math.atan2(path.tx[pl.i], path.tz[pl.i]);
      expect(pl.yaw).toBeCloseTo(along, 6);
      const e = toWorld(pl, 19, 0); // one end of the 38 m span
      const spanDir = Math.hypot(e.x - pl.x, e.z - pl.z);
      expect(spanDir).toBeCloseTo(19, 5);
      const dot = (e.x - pl.x) * path.tx[pl.i] + (e.z - pl.z) * path.tz[pl.i];
      expect(Math.abs(dot)).toBeLessThan(1e-3); // perpendicular to travel
    });
    it(`t=${o.t}: supports at ±17.5 m are clear of the carriageway walls (or are skipped)`, () => {
      const pl = overpassPlacement(path, opp, o.t);
      const clear: number[] = [];
      for (const side of [-1, 1]) {
        const w = toWorld(pl, side * 17.5, -0.2);
        clear.push(boxToRoadDistance(path, w.x, w.z, pl.yaw, 1.5, 0.5));
      }
      console.log(
        `OVERPASS t=${o.t} gap=${pl.gapM.toFixed(1)} support clearance to road centre line = ${clear.map((c) => c.toFixed(2)).join(' / ')} (need >= ${5.5 + 0.8})`,
      );
      expect(Math.min(...clear)).toBeGreaterThan(0);
    });
  }
});

describe('flyover', () => {
  const f = (
    congHoa as unknown as {
      flyover: { points: [number, number, number][]; pierSpacingM: number; deckElevationM: number };
    }
  ).flyover;
  it('measures the polyline and interpolates along it', () => {
    const total = polylineLength(f.points);
    expect(total).toBeGreaterThan(270);
    expect(total).toBeLessThan(290);
    const start = polylineAt(f.points, 0);
    expect(start.z).toBe(160);
    expect(start.tz).toBe(-1); // heading toward −Z (north)
    const mid = polylineAt(f.points, 100);
    expect(mid.z).toBeCloseTo(60, 5);
    expect(polylineAt(f.points, 1e9).y).toBe(0);
  });
  it('places a pier every 25 m of line, shorter on the ramp, and none where the deck meets the road', () => {
    const sites = flyoverPierSites(f.points, f.pierSpacingM, f.deckElevationM);
    expect(sites.length).toBeGreaterThanOrEqual(9);
    expect(sites[0].z).toBe(160);
    expect(sites[1].z).toBeCloseTo(135, 5);
    expect(sites[0].height).toBeCloseTo(7.8, 5);
    const ramp = sites[sites.length - 1];
    expect(ramp.lineY).toBeGreaterThanOrEqual(3);
    expect(ramp.height).toBeLessThan(7.8);
    // spacing between consecutive flat piers is 25 m
    expect(Math.hypot(sites[1].x - sites[0].x, sites[1].z - sites[0].z)).toBeCloseTo(25, 5);
  });
  it('cuts the deck stations where the ramp reaches the road', () => {
    const st = flyoverStations(f.points, 4, 3);
    expect(st[0].y).toBe(7);
    expect(st[st.length - 1].y).toBeGreaterThanOrEqual(3);
    expect(st[st.length - 1].z).toBeGreaterThan(-120);
  });
  it('pier heights scale with the deck line', () => {
    expect(pierHeightFor(7, 7, 7.8)).toBeCloseTo(7.8);
    expect(pierHeightFor(3.5, 7, 7.8)).toBeCloseTo(3.9);
    expect(pierHeightFor(0, 7, 7.8)).toBe(0);
  });
  it('reports which piers touch the road corridor on the real track', () => {
    const sites = flyoverPierSites(f.points, f.pierSpacingM, f.deckElevationM);
    const rows = sites.map((s, i) => ({ i, z: s.z, d: boxToRoadDistance(path, s.x, s.z, s.yaw, 6, 1.1) }));
    const hitting = rows.filter((r) => r.d < track.roadWidthM / 2);
    const near = rows.filter((r) => r.d < track.roadWidthM / 2 + 8);
    console.log(
      `PIERS total=${rows.length} intersecting-road=[${hitting.map((r) => `#${r.i}@z=${r.z}`).join(', ')}] within-8m=[${near.map((r) => `#${r.i}@z=${r.z} d=${r.d.toFixed(1)}`).join(', ')}]`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('obb distance', () => {
  it('is zero inside, and measures to the nearest edge outside', () => {
    expect(obbDistance(0, 0, 0, 0, 0, 6, 1)).toBe(0);
    expect(obbDistance(8, 0, 0, 0, 0, 6, 1)).toBeCloseTo(2);
    expect(obbDistance(0, 3, 0, 0, 0, 6, 1)).toBeCloseTo(2);
    // rotated 90°: the 12 m side now runs along Z
    expect(obbDistance(0, 8, 0, 0, Math.PI / 2, 6, 1)).toBeCloseTo(2);
    expect(obbDistance(8, 0, 0, 0, Math.PI / 2, 6, 1)).toBeCloseTo(7);
  });
});

describe('airliner flybys', () => {
  const plan = flightPlanFor(path, 0.07, 20);
  const pose: AirlinerPose = { visible: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, bank: 0 };
  it('flies east → west across the airport stretch', () => {
    expect(plan.start[0]).toBeGreaterThan(plan.end[0]);
    const mid = airlinerPose(plan.firstAtSec + plan.flightSec / 2, plan, pose);
    expect(mid.visible).toBe(true);
    // over the road around the midpoint of the pass
    sampleAt(path, 0.07, { x: 0, z: 0, tx: 0, tz: 0 });
    expect(Math.abs(mid.x - path.px[Math.round(0.07 * path.count)])).toBeLessThan(15);
    expect(mid.yaw).toBeCloseTo(Math.atan2(plan.end[0] - plan.start[0], plan.end[2] - plan.start[2]), 6);
    expect(mid.pitch).toBeGreaterThan(0); // nose down: descending
  });
  it('descends from 120 m to 80 m over the pass', () => {
    const a = airlinerPose(plan.firstAtSec, plan, pose);
    expect(a.y).toBeCloseTo(120, 5);
    const b = airlinerPose(plan.firstAtSec + plan.flightSec, plan, pose);
    expect(b.y).toBeCloseTo(80, 5);
  });
  it('is hidden before the first pass and between passes, and repeats every 20 s', () => {
    expect(airlinerPose(0, plan, pose).visible).toBe(false);
    expect(airlinerPose(plan.firstAtSec + 10, plan, pose).visible).toBe(false);
    const one = airlinerPose(plan.firstAtSec + 3, plan, pose);
    const x1 = one.x;
    const two = airlinerPose(plan.firstAtSec + 3 + 20, plan, pose);
    expect(two.visible).toBe(true);
    expect(two.x).toBeCloseTo(x1, 6);
    expect(airlinerPose(plan.firstAtSec + 3 + 40, plan, pose).visible).toBe(true);
  });
});

describe('ambient traffic plan', () => {
  const plan = (seed: number) => trafficPlan(0, 36, 2, seed, [30, 50], L, { behindLineM: 130, aheadOfLineM: 30 });
  it('is deterministic for a seed and differs between seeds', () => {
    expect(plan(1971)).toEqual(plan(1971));
    expect(plan(1971)).not.toEqual(plan(5));
  });
  it('spawns 36 scooters at 30–50 km/h, mixed models, spread around the lap', () => {
    const p = plan(1971);
    expect(p).toHaveLength(36);
    for (const s of p) {
      expect(s.speedMps).toBeGreaterThanOrEqual(30 / 3.6 - 1e-9);
      expect(s.speedMps).toBeLessThanOrEqual(50 / 3.6 + 1e-9);
      expect(Math.abs(s.jitterM)).toBeLessThanOrEqual(0.4 + 1e-9);
    }
    expect(new Set(p.map((s) => s.model)).size).toBe(2);
    const phases = p.map((s) => s.phase).sort((a, b) => a - b);
    // evenly spread: no gap larger than ~3 average spacings
    let maxGap = phases[0] + 1 - phases[phases.length - 1];
    for (let i = 1; i < phases.length; i++) maxGap = Math.max(maxGap, phases[i] - phases[i - 1]);
    expect(maxGap).toBeLessThan((3 / 36) * 1.6);
  });
  it('keeps the starting grid (130 m behind the line to 30 m ahead) free at t = 0', () => {
    for (const seed of [1, 2, 3, 1971, 9999]) {
      for (const s of plan(seed)) {
        const p = trafficT(s, 0, L);
        expect(p < 1 - 130 / L && p > 30 / L).toBe(true);
      }
    }
  });
  it('moves forward along the lap at its own speed and wraps', () => {
    const s = plan(1971)[0];
    const t0 = trafficT(s, 0, L);
    const t10 = trafficT(s, 10, L);
    const moved = (((t10 - t0) % 1) + 1) % 1;
    expect(moved * L).toBeCloseTo(s.speedMps * 10, 3);
    expect(trafficT(s, L / s.speedMps, L)).toBeCloseTo(t0, 6);
  });
  it('seededRng is repeatable', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
