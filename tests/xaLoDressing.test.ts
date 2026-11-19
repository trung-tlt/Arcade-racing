import { beforeAll, describe, expect, it } from 'vitest';
import xaLo from '../data/tracks/xa_lo_ha_noi.json';
import { distToPolyline, leftOf, rightOf } from '../src/world/Corridor';
import { minDistToPath } from '../src/world/CongHoaDressing';
import { TrackPath } from '../src/world/TrackPath';
import {
  BARRIER_TILE_M,
  CHUNK_M,
  FACTORY_HALF,
  TOWER_HALF,
  XALO_DRESSING_MODELS,
  type XaLoPlan,
  type XaLoSpec,
  chunkKey,
  groupByChunk,
  legSamples,
  planXaLo,
  sampleAtN,
  sampleWithin,
  specFromTrack,
} from '../src/world/XaLoDressing';

const path = new TrackPath(xaLo.spline.points, 2, 40);
const spec: XaLoSpec = specFromTrack(xaLo as unknown as Record<string, unknown>);
let plan: XaLoPlan;
beforeAll(() => {
  plan = planXaLo(path, spec);
});

describe('xa lo spec + models', () => {
  it('reads the dressing numbers from the map json', () => {
    expect(spec.apartments).toMatchObject({ fromN: 380, toN: 900, spacingM: 60, setbackM: 45 });
    expect(spec.factories).toMatchObject({ fromN: 1050, toN: 1900, spacingM: 80, setbackM: 70 });
    expect(spec.shophouses.frontageOffsetM).toBe(10);
    expect(spec.lampEveryM).toBe(40);
    expect(spec.viaduct).toHaveLength(2);
    expect(spec.landmarks).toHaveLength(12); // 3 stations + 9 billboards
  });

  it('lists every model once, all under the assets tree', () => {
    expect(new Set(XALO_DRESSING_MODELS).size).toBe(XALO_DRESSING_MODELS.length);
    expect(XALO_DRESSING_MODELS).toContain('models/props_xalo/highway_lamp.glb');
    expect(XALO_DRESSING_MODELS).toContain('models/props/barrier_jersey.glb');
  });
});

describe('legs', () => {
  it('outbound runs north with rising northing, frontage ordered the same way', () => {
    const out = legSamples(path, 0, spec.frontageFromT);
    const fr = legSamples(path, spec.frontageFromT, spec.frontageToT);
    for (const leg of [out, fr])
      for (let k = 1; k < leg.length; k++) expect(leg[k].n).toBeGreaterThanOrEqual(leg[k - 1].n);
    expect(out[out.length - 1].n).toBeGreaterThan(1850);
    expect(fr[0].n).toBeLessThan(450);
    expect(fr[fr.length - 1].n).toBeGreaterThan(1850);
  });

  it('sampleAtN snaps to the nearest sample and sampleWithin rejects points off the ends', () => {
    const out = legSamples(path, 0, spec.frontageFromT);
    expect(Math.abs(sampleAtN(out, 700).n - 700)).toBeLessThan(2);
    expect(sampleWithin(out, 5000)).toBeNull();
    expect(sampleWithin(out, -500)).toBeNull();
  });

  it('left/right are opposites', () => {
    const l = leftOf(0, -1);
    const r = rightOf(0, -1);
    expect(l.x + r.x).toBeCloseTo(0);
    expect(l.z + r.z).toBeCloseTo(0);
    expect(r.x).toBeGreaterThan(0.9); // right of a northbound car is east
  });

  it('distToPolyline measures to segments, not just vertices', () => {
    expect(
      distToPolyline(
        [
          [0, 0],
          [10, 0],
        ],
        5,
        3,
      ),
    ).toBeCloseTo(3);
    expect(
      distToPolyline(
        [
          [0, 0],
          [10, 0],
        ],
        14,
        0,
      ),
    ).toBeCloseTo(4);
  });
});

describe('plan', () => {
  it('is deterministic', () => {
    const again = planXaLo(path, spec);
    expect(again).toEqual(plan);
  });

  it('places apartments east of the outbound road with their fronts toward it, all within the N range', () => {
    expect(plan.apartments.length).toBeGreaterThanOrEqual(8);
    expect(plan.apartments.length).toBeLessThanOrEqual(10);
    for (const t of plan.apartments) {
      expect(-t.z).toBeGreaterThan(spec.apartments.fromN - 10);
      expect(-t.z).toBeLessThan(spec.apartments.toN + 10);
      expect(t.x).toBeGreaterThan(path.px[0] + 40);
      // Front (local +Z) points west, at the road.
      expect(Math.sin(t.yaw)).toBeLessThan(-0.7);
      expect(minDistToPath(path, t.x, t.z)).toBeGreaterThan(TOWER_HALF.d + 40);
      expect(distToPolyline(spec.viaduct, t.x, t.z)).toBeGreaterThan(20);
    }
    expect(new Set(plan.apartments.map((t) => t.kind)).size).toBe(2);
  });

  it('places factories east, 80 m apart, away from every road', () => {
    expect(plan.factories.length).toBeGreaterThanOrEqual(9);
    for (const f of plan.factories) {
      expect(-f.z).toBeGreaterThan(spec.factories.fromN - 60);
      expect(-f.z).toBeLessThan(spec.factories.toN + 60);
      expect(minDistToPath(path, f.x, f.z)).toBeGreaterThan(FACTORY_HALF.d + 60);
    }
  });

  it('packs shophouses along the frontage road on its west side, facing it, clear of the road', () => {
    expect(plan.houses.length).toBeGreaterThan(150);
    for (const h of plan.houses) {
      expect(h.n).toBeGreaterThan(spec.shophouses.fromN);
      expect(h.n).toBeLessThan(spec.shophouses.toN + 6);
      // The facade is 10 m beyond the frontage road's kerb: at least that far from every racing line sample.
      expect(minDistToPath(path, h.x, h.z)).toBeGreaterThan(spec.frontageWidthM / 2 + 9);
      // Faces east (towards the frontage road that runs on its east side).
      expect(Math.sin(h.yaw)).toBeGreaterThan(0.5);
      // Body must not touch the main road or the bridge returns.
      const back = { x: h.x - Math.sin(h.yaw) * 10, z: h.z - Math.cos(h.yaw) * 10 };
      expect(minDistToPath(path, back.x, back.z)).toBeGreaterThan(7);
      expect(distToPolyline(spec.viaduct, h.x, h.z)).toBeGreaterThan(8.9);
    }
    // Both ends of the stretch have houses.
    const ns = plan.houses.map((h) => h.n);
    expect(Math.min(...ns)).toBeLessThan(600);
    expect(Math.max(...ns)).toBeGreaterThan(1800);
  });

  it('keeps houses off stations and billboards', () => {
    for (const h of plan.houses)
      for (const [lx, lz] of spec.landmarks) expect(Math.hypot(h.x - lx, h.z - lz)).toBeGreaterThan(11);
  });

  it('puts barriers every 3 m on both sides of the viaduct strip, never on the bridge or underpass', () => {
    expect(plan.barriers.length).toBeGreaterThan(500);
    for (const b of plan.barriers) {
      const n = -b.z;
      expect(n).toBeGreaterThan(spec.bridge.toN);
      expect(n < spec.underpass.fromN - 10 || n > spec.underpass.toN + 10).toBe(true);
      expect(b.y).toBeCloseTo(0, 0);
      // On a road edge: just outside a kerb, not on the carriageway.
      expect(minDistToPath(path, b.x, b.z)).toBeGreaterThan(Math.min(spec.mainWidthM, spec.frontageWidthM) / 2);
    }
    const first = plan.barriers[0];
    const second = plan.barriers[1];
    expect(Math.hypot(first.x - second.x, first.z - second.z)).toBeCloseTo(BARRIER_TILE_M, 0);
  });

  it('puts lamps every 40 m at road height, skipping the underpass', () => {
    expect(plan.lamps.length).toBeGreaterThan(40);
    for (const l of plan.lamps) {
      const n = -l.z;
      expect(n < spec.underpass.fromN || n > spec.underpass.toN).toBe(true);
      // y follows the road (bridge crest is ~11 m).
      expect(l.y).toBeGreaterThan(-1);
    }
    expect(Math.max(...plan.lamps.map((l) => l.y))).toBeGreaterThan(8);
    // Spacing along the outbound leg is 40 m (consecutive northings).
    const ns = plan.lamps.map((l) => -l.z).sort((a, b) => a - b);
    const near = ns.filter((n, i) => i > 0 && Math.abs(n - ns[i - 1] - 40) < 8);
    expect(near.length).toBeGreaterThan(ns.length * 0.5);
  });

  it('plants trees clear of the roads and off the trench', () => {
    expect(plan.trees.length).toBeGreaterThan(60);
    for (const t of plan.trees) {
      expect(t.y).toBe(0);
      expect(minDistToPath(path, t.x, t.z)).toBeGreaterThan(3);
      expect([0, 1]).toContain(t.kind);
    }
  });
});

describe('chunking', () => {
  it('keys by 150 m cells and groups every item exactly once', () => {
    expect(chunkKey(0, 0)).toBe(chunkKey(CHUNK_M - 1, CHUNK_M - 1));
    expect(chunkKey(0, 0)).not.toBe(chunkKey(CHUNK_M, 0));
    const groups = groupByChunk(plan.barriers);
    let total = 0;
    for (const [k, list] of groups) {
      total += list.length;
      for (const b of list) expect(chunkKey(b.x, b.z)).toBe(k);
    }
    expect(total).toBe(plan.barriers.length);
    expect(groups.size).toBeGreaterThan(5);
  });
});
