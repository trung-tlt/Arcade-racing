import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assets } from '../src/core/Assets';
import { PHAM_VAN_DONG, RACE, roadWidthAt } from '../src/core/Data';
import { TrackPath } from '../src/world/TrackPath';
import { relaxTightBends } from '../src/world/relaxBends';
import {
  PVD_STRUCTURE_MODELS,
  PvdStructures,
  planPvdStructures,
  pvdTerrainHoles,
  pvdTrench,
  outboundNAtZ,
  returnNAtZ,
} from '../src/world/PvdStructures';

beforeAll(async () => {
  await RAPIER.init();
});

const path = new TrackPath(PHAM_VAN_DONG.spline.points, 2, 40);
/** The game builds its path from the relaxed spline; the plan must hold for that one too. */
const relaxed = new TrackPath(relaxTightBends(PHAM_VAN_DONG.spline.points, RACE.track.minTurnRadiusM), 2, 40);

/** Stub models with the real GLBs' sub-mesh material names (plain ones merge, the *_LED / lamp ones glow and stay). */
const PARTS: Record<string, string[]> = {
  'bridge_branch_segment.glb': ['Concrete', 'Bridge_Girder', 'Parapet_Stripe', 'Bridge_Rail', 'Pole', 'Lamp_LED'],
  'bridge_branch_pier.glb': ['Concrete'],
  'arch_rail_bridge.glb': ['Concrete', 'Arch_Steel', 'Rail', 'Arch_Hanger'],
  'ramp_span.glb': ['Concrete', 'Parapet_Stripe', 'Parapet_LED'],
  'cross_overpass.glb': ['Concrete', 'Parapet_Stripe', 'Parapet_LED', 'Underside_Lamp'],
  'flyover_pier.glb': ['Concrete_Pier'],
};
const GLOWING = /LED|Lamp/;
const stubAssets = {
  cloneModel(p: string): THREE.Group {
    const root = new THREE.Group();
    const node = new THREE.Group(); // the GLB's one node holding a mesh per material
    for (const name of PARTS[p.split('/').pop() as string]) {
      const mat = new THREE.MeshStandardMaterial({ color: '#888888', metalness: 0.1 });
      mat.name = name;
      if (GLOWING.test(name)) {
        mat.emissive.set('#ffffff');
        mat.emissiveIntensity = 2;
      }
      node.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
    }
    root.add(node);
    return root;
  },
} as unknown as Assets;

const segIntersect = (a: number[], b: number[], c: number[], d: number[]): boolean => {
  const o = (p: number[], q: number[], r: number[]): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
};

const inside = (poly: number[][], x: number, z: number): boolean => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

describe('pvdTerrainHoles (real Map 4 data)', () => {
  const holes = pvdTerrainHoles(PHAM_VAN_DONG, path);

  it('returns the river band, the creek band and the flooded-dip trench', () => {
    expect(holes).toHaveLength(3);
  });

  it('river band spans N 720..880 across the land and stays inside the 6 km plane', () => {
    const [r] = holes;
    expect(r).toHaveLength(4);
    const zs = r.map((p) => p[1]);
    // N is metres north: z = -N.
    expect(Math.max(...zs)).toBeCloseTo(-720, 0);
    expect(Math.min(...zs)).toBeCloseTo(-880, 0);
    for (const [x, z] of r) {
      expect(Math.abs(x)).toBeLessThanOrEqual(3000);
      expect(Math.abs(z)).toBeLessThanOrEqual(3000);
    }
    const xs = r.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(5900);
    // Both Binh Loi branches (x ≈ 64 outbound, 36 inbound) are inside the band.
    expect(inside(r, 64, -800)).toBe(true);
    expect(inside(r, 36, -800)).toBe(true);
  });

  it('creek band is the middle third of the Go Dua crossing (N 1540..1580)', () => {
    const [, c] = holes;
    const zs = c.map((p) => p[1]);
    expect(Math.max(...zs)).toBeCloseTo(-1540, 0);
    expect(Math.min(...zs)).toBeCloseTo(-1580, 0);
  });

  it('trench is a simple polygon covering every sample of the dip below -0.3 m plus a pad', () => {
    const t = holes[2];
    expect(t.length).toBeGreaterThanOrEqual(8);
    for (let i = 0; i < t.length; i++) {
      for (let j = i + 2; j < t.length; j++) {
        if (i === 0 && j === t.length - 1) continue;
        expect(segIntersect(t[i], t[(i + 1) % t.length], t[j], t[(j + 1) % t.length])).toBe(false);
      }
    }
    // Every sample of the data's flood zone where the road is below -0.3 m is inside the cut: no ledge anywhere.
    const flood = PHAM_VAN_DONG.weather!.flood;
    let sunk = 0;
    for (let i = Math.floor((flood.fromT - 0.03) * path.count); i <= Math.ceil((flood.toT + 0.03) * path.count); i++) {
      if (path.py[i] >= -0.3) continue;
      sunk++;
      expect(inside(t, path.px[i], path.pz[i]), `sample ${i}`).toBe(true);
    }
    expect(sunk).toBeGreaterThan(30);
    // It is wider than the 7 m motorbike lanes by the margin on each side.
    const tr = pvdTrench(PHAM_VAN_DONG, path)!;
    const mid = tr.idx.indexOf(Math.round(0.552 * path.count));
    expect(tr.half[mid]).toBeCloseTo(roadWidthAt(PHAM_VAN_DONG, 0.552) / 2 + 3, 1);
  });

  it('the dip is the only trench: the outbound lanes beside it stay on solid land', () => {
    const t = holes[2];
    // Outbound carriageway at the same z (x ≈ 99.5) is 30 m east of the dip (x ≈ 70).
    expect(inside(t, 99.5, -1925)).toBe(false);
  });
});

describe('returnNAtZ', () => {
  it('finds the return leg where the racing line passes a z', () => {
    for (const z of [-1080, -520, -1600]) {
      const n = returnNAtZ(path, z);
      expect(n).toBeGreaterThan(path.lengthM / 2);
      expect(path.pointAt(n / path.lengthM).z).toBeCloseTo(z, 0);
    }
  });
  it('finds the outbound leg too (data N is metres north, z = -N)', () => {
    for (const z of [-520, -1080, -1560]) {
      const n = outboundNAtZ(path, z);
      expect(n).toBeLessThan(path.lengthM / 2);
      expect(path.pointAt(n / path.lengthM).z).toBeCloseTo(z, 0);
    }
  });
});

describe.each([
  ['raw spline', path],
  ['relaxed spline', relaxed],
])('planPvdStructures (%s)', (_name, p) => {
  const plan = planPvdStructures(PHAM_VAN_DONG, p);
  const roadY = RACE.track.roadY;

  it('tiles Binh Loi as 14 outbound + 14 inbound decks, 40 m apart', () => {
    expect(plan.binhLoi.decks).toHaveLength(28);
    expect(plan.binhLoi.decks[1].n - plan.binhLoi.decks[0].n).toBeCloseTo(40, 0);
    expect(plan.binhLoi.decks[15].n - plan.binhLoi.decks[14].n).toBeGreaterThan(38);
    expect(plan.binhLoi.decks[15].n - plan.binhLoi.decks[14].n).toBeLessThan(42);
  });

  it('puts the two branches centred 14 m either side of the axis and never overlapping', () => {
    const out = plan.binhLoi.decks.find((d) => d.n > 700 && d.n < 900 && d.x > 50)!;
    expect(out.x).toBeCloseTo(64, 0); // racing line 59.5 + 4.5 to the right
    const inn = plan.binhLoi.decks.slice(14).find((d) => d.n > 3700 && d.n < 3800)!;
    expect(inn.x).toBeCloseTo(36, 0); // axis 50 - 14
    expect(out.x - inn.x).toBeGreaterThan(24.1); // two 24 m decks: no overlap
  });

  it('keeps every deck top below the road ribbon so it can never poke through', () => {
    for (const d of [...plan.binhLoi.decks, ...plan.goDua.decks, ...plan.ramps]) {
      const road = p.yAt((((d.n / p.lengthM) % 1) + 1) % 1) + roadY;
      // 0.25 m under the curve; the ribbon follows 2 m linear samples, which cut a sharp crest by a few cm.
      expect(d.y).toBeLessThan(road - 0.15);
    }
  });

  it('puts piers only where the deck is high enough to show one, on the segment joints', () => {
    expect(plan.binhLoi.piers.length).toBeGreaterThanOrEqual(16);
    for (const pier of plan.binhLoi.piers) expect(pier.y).toBeGreaterThan(2.5);
  });

  it('Go Dua: 3 segments per side, the inbound one centred 6 m east of the inbound racing line', () => {
    expect(plan.goDua.decks).toHaveLength(6);
    const inn = plan.goDua.decks.slice(3)[1];
    expect(inn.x).toBeCloseTo(76, 0);
  });

  it('lays the U-turn flyover as stretched spans that tile its t range, with columns under the joints', () => {
    const fly = PHAM_VAN_DONG.raw.uTurnFlyover as { fromT: number; toT: number; spanM: number };
    const lenM = (fly.toT - fly.fromT) * p.lengthM;
    expect(plan.ramps).toHaveLength(2 * Math.ceil(lenM / 2 / 3)); // 2 structural spans, each laid as pieces <= 3 m
    const total = plan.ramps.reduce((a, r) => a + (r.sz ?? 1) * fly.spanM, 0);
    expect(total).toBeCloseTo(lenM, 1);
    for (const r of plan.ramps) expect(r.sz).toBeLessThan(0.12); // short pieces of the 30 m model
    for (const col of plan.flyoverPiers) {
      expect(col.y).toBe(0);
      expect(col.sy).toBeGreaterThan(0.5 / 7.8);
    }
    // The tall middle joint gets a column.
    expect(plan.flyoverPiers.length).toBeGreaterThanOrEqual(1);
  });

  it('places the overpass and the arch bridge from the data', () => {
    expect([plan.overpass.x, plan.overpass.y, plan.overpass.z]).toEqual([90, 0, -1925]);
    expect([plan.railArch.x, plan.railArch.y, plan.railArch.z]).toEqual([-10, 3, -800]);
    expect(plan.railArch.fz).toBeCloseTo(1);
  });

  it('the overpass spans both carriageways it crosses', () => {
    // 64 m across X centred on the boulevard: outbound lanes (x 94..105) and the inbound moto lanes (x 66..73).
    expect(plan.overpass.x - 32).toBeLessThan(66);
    expect(plan.overpass.x + 32).toBeGreaterThan(105);
  });
});

describe('PvdStructures (stub models)', () => {
  it('builds within 25 draw calls, adds no colliders, steps, and disposes cleanly', () => {
    const world = new RAPIER.World({ x: 0, y: -15, z: 0 });
    const scene = new THREE.Scene();
    const s = new PvdStructures(scene, RAPIER, world, stubAssets, PHAM_VAN_DONG, relaxed);
    let calls = 0;
    s.group.traverse((o) => {
      if (o instanceof THREE.Mesh) calls++;
    });
    expect(calls).toBeGreaterThan(8);
    expect(calls).toBeLessThanOrEqual(25);
    expect(world.colliders.len()).toBe(0);
    s.update(1 / 60);
    s.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('lists every model it loads', () => {
    expect(PVD_STRUCTURE_MODELS).toHaveLength(6);
    expect(new Set(PVD_STRUCTURE_MODELS).size).toBe(6);
  });
});
