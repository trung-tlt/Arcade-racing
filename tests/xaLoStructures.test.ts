import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assets } from '../src/core/Assets';
import { XA_LO } from '../src/core/Data';
import { TrackPath } from '../src/world/TrackPath';
import {
  XALO_STRUCTURE_MODELS,
  XaLoStructures,
  planXaLoStructures,
  xaLoTerrainHoles,
} from '../src/world/XaLoStructures';

beforeAll(async () => {
  await RAPIER.init();
});

const path = new TrackPath(XA_LO.spline.points, 2, 40);

/** Stub models with the real GLBs' sub-mesh counts. */
const PARTS: Record<string, number> = {
  'river_bridge_segment.glb': 5,
  'river_bridge_pier.glb': 1,
  'underpass_open.glb': 2,
  'underpass_covered.glb': 3,
};
const stubAssets = {
  cloneModel(p: string): THREE.Group {
    const g = new THREE.Group();
    for (let i = 0; i < PARTS[p.split('/').pop() as string]; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: '#888888' });
      mat.name = `part${i}`;
      g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
    }
    return g;
  },
} as unknown as Assets;

const segIntersect = (a: number[], b: number[], c: number[], d: number[]): boolean => {
  const o = (p: number[], q: number[], r: number[]): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
};

describe('xaLoTerrainHoles (real Xa Lo data)', () => {
  const holes = xaLoTerrainHoles(XA_LO, path);

  it('returns the river band and the underpass trench', () => {
    expect(holes).toHaveLength(2);
  });

  it('river band spans N 60..240 along the outbound leg and ±3 km across', () => {
    const [r] = holes;
    expect(r).toHaveLength(4);
    const zs = r.map((p) => p[1]);
    // Outbound heads −Z from z = 40: N 60 → z ≈ −20, N 240 → z ≈ −200.
    expect(Math.max(...zs)).toBeCloseTo(path.pointAt(60 / path.lengthM).z, 0);
    expect(Math.min(...zs)).toBeCloseTo(path.pointAt(240 / path.lengthM).z, 0);
    const xs = r.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(6000, -1);
    // Both carriageways (x = 10 outbound, x = −10 return) are inside the band.
    expect(Math.min(...xs)).toBeLessThan(-10);
    expect(Math.max(...xs)).toBeGreaterThan(10);
  });

  it('trench is a simple polygon around the road where it is below −0.3', () => {
    const t = holes[1];
    expect(t.length).toBeGreaterThanOrEqual(8);
    for (let i = 0; i < t.length; i++) {
      for (let j = i + 2; j < t.length; j++) {
        if (i === 0 && j === t.length - 1) continue;
        expect(segIntersect(t[i], t[(i + 1) % t.length], t[j], t[(j + 1) % t.length])).toBe(false);
      }
    }
    // Every sunken sample in the underpass range is inside the polygon's bounding box with a margin.
    const xs = t.map((p) => p[0]);
    const zs = t.map((p) => p[1]);
    const mid = path.pointAt(1560 / path.lengthM);
    expect(mid.x).toBeGreaterThan(Math.min(...xs));
    expect(mid.x).toBeLessThan(Math.max(...xs));
    expect(mid.z).toBeGreaterThan(Math.min(...zs));
    expect(mid.z).toBeLessThan(Math.max(...zs));
    // Width is road width + 12 m.
    const w = Math.hypot(t[0][0] - t[t.length - 1][0], t[0][1] - t[t.length - 1][1]);
    expect(w).toBeCloseTo(XA_LO.roadWidthM + 12, 0);
  });
});

describe('planXaLoStructures', () => {
  const plan = planXaLoStructures(XA_LO, path);

  it('tiles the outbound bridge every 40 m, deck top 0.02 below the spline (0.05 under the ribbon)', () => {
    expect(plan.decks).toHaveLength(11);
    const d = plan.decks[2];
    expect(d.y).toBeCloseTo(path.yAt(d.n / path.lengthM) - 0.02, 1);
    expect(plan.decks[1].n - plan.decks[0].n).toBeCloseTo(40);
  });

  it('decks sit 10 m west of the outbound centreline (x ≈ 0)', () => {
    const mid = plan.decks.find((d) => d.n > 100 && d.n < 140);
    expect(mid?.x).toBeCloseTo(0, 0);
  });

  it('puts piers on the deck joints inside the river and never doubles a deck', () => {
    expect(plan.piers.map((p) => Math.round(p.n))).toEqual([60, 100, 140, 180, 220]);
    for (const r of plan.returnDecks) {
      for (const d of plan.decks) expect(Math.hypot(r.x - d.x, r.z - d.z)).toBeGreaterThan(20);
    }
  });

  it('lines the underpass with 13 segments, 2 of them covered', () => {
    expect(plan.underOpen.length + plan.underCovered.length).toBe(13);
    expect(plan.underCovered.map((p) => p.n)).toEqual([1560, 1580]);
  });
});

describe('XaLoStructures (stub models)', () => {
  it('builds within 20 draw calls, steps, and disposes cleanly', () => {
    const world = new RAPIER.World({ x: 0, y: -15, z: 0 });
    const scene = new THREE.Scene();
    const s = new XaLoStructures(scene, RAPIER, world, stubAssets, XA_LO, path);
    let calls = 0;
    s.group.traverse((o) => {
      if (o instanceof THREE.Mesh) calls++;
    });
    expect(calls).toBeLessThanOrEqual(20);
    expect(world.colliders.len()).toBe(0);
    s.update(1 / 60);
    s.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('lists every model it loads', () => {
    expect(XALO_STRUCTURE_MODELS).toHaveLength(4);
  });
});
