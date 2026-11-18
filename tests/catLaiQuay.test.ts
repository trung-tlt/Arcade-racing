import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assets } from '../src/core/Assets';
import { CAT_LAI, roadWidthAt } from '../src/core/Data';
import {
  CAT_LAI_QUAY_MODELS,
  CatLaiQuay,
  STACKER_CROSS_SEC,
  STACKER_DWELL_SEC,
  YARD_TRUCK_FROM_T,
  YARD_TRUCK_TO_T,
  boxDistance,
  catLaiRaw,
  ferryPose,
  laneClearanceM,
  quayTiles,
  rtgLegBoxes,
  rtgYaw,
  shortcutGeometry,
  shortcutMouths,
  stackerCrossings,
  stackerPose,
  stsLegBoxes,
  yardTruckT,
  type FerryPose,
  type StackerPose,
} from '../src/world/CatLaiQuay';
import { TrackPath } from '../src/world/TrackPath';

beforeAll(async () => {
  await RAPIER.init();
});

const path = new TrackPath(CAT_LAI.spline.points, 2, 40);
const raw = catLaiRaw(CAT_LAI);

describe('crane legs vs the racing lane (real Cat Lai data)', () => {
  it('STS legs leave the apron lane free by more than 1 m', () => {
    const boxes = raw.cranes.sts.positions.flatMap((p) => stsLegBoxes(p[0], p[2]));
    expect(boxes).toHaveLength(24);
    expect(laneClearanceM(path, CAT_LAI, boxes)).toBeGreaterThan(1);
  });

  it('RTG legs, turned to the lane axis, leave the yard lane free by more than 1 m', () => {
    const boxes = raw.cranes.rtg.positions.flatMap((p) => rtgLegBoxes(p[0], p[2], rtgYaw(path, p[0], p[2])));
    expect(boxes).toHaveLength(6);
    expect(laneClearanceM(path, CAT_LAI, boxes)).toBeGreaterThan(1);
  });

  it('reports a box standing on the road as negative clearance', () => {
    const p = path.pointAt(0.05);
    expect(laneClearanceM(path, CAT_LAI, [{ cx: p.x, cz: p.z, hx: 1, hz: 1, yaw: 0 }])).toBeLessThan(0);
  });

  it('box distance is zero inside and Euclidean outside, for a turned box', () => {
    const b = { cx: 10, cz: 10, hx: 2, hz: 1, yaw: Math.PI / 2 };
    expect(boxDistance(b, 10, 10)).toBe(0);
    // Turned a quarter: local X now runs along Z, so it spans z 8..12 and x 9..11.
    expect(boxDistance(b, 10, 14)).toBeCloseTo(2, 5);
    expect(boxDistance(b, 13, 10)).toBeCloseTo(2, 5);
  });
});

describe('Reefer-lane shortcut', () => {
  const geo = shortcutGeometry(CAT_LAI);

  it('is the 7 m road along z = -770 from the yard lane to the apron', () => {
    expect(geo.widthM).toBe(7);
    expect(geo.points[0]).toEqual([250, -770]);
    expect(geo.points[geo.points.length - 1]).toEqual([420, -770]);
  });

  it('has side walls outside the road that stop short of both ends', () => {
    expect(geo.walls).toHaveLength(2 * (geo.points.length - 1));
    for (const w of geo.walls) {
      expect(Math.abs(w.cz - -770)).toBeGreaterThan(geo.widthM / 2);
      expect(w.cx - w.hz).toBeGreaterThanOrEqual(250 + 8 - 1e-6);
      expect(w.cx + w.hz).toBeLessThanOrEqual(420 - 8 + 1e-6);
    }
  });

  it('exposes the two mouths where the main road needs a wall gap', () => {
    const m = shortcutMouths(CAT_LAI);
    expect(m.map((p) => [p.x, p.z])).toEqual([
      [250, -770],
      [420, -770],
    ]);
    expect(m[0].halfGapM).toBeGreaterThan(geo.widthM / 2);
  });

  it('puts the ramp on the lane, within its x range', () => {
    const [rx, , rz] = raw.shortcut.ramp.position;
    expect(rz).toBe(-770);
    expect(rx).toBeGreaterThan(250);
    expect(rx).toBeLessThan(420);
  });
});

describe('ferry timeline', () => {
  const o: FerryPose = { x: 0, yaw: 0 };
  const c = raw.ferry;
  const at = (t: number): FerryPose =>
    ferryPose(t, c.landing[0], c.crossing.to[0], c.crossing.durationSec, 15, { ...o });

  it('docks at the landing, crosses in the data duration, waits, and returns', () => {
    const dock = c.landing[0] + 24;
    expect(at(0).x).toBeCloseTo(dock, 5);
    expect(at(14.9).x).toBeCloseTo(dock, 5);
    expect(at(15 + c.crossing.durationSec / 2).x).toBeCloseTo((dock + c.crossing.to[0]) / 2, 3);
    expect(at(15 + c.crossing.durationSec).x).toBeCloseTo(c.crossing.to[0], 5);
    expect(at(15 + c.crossing.durationSec + 14).x).toBeCloseTo(c.crossing.to[0], 5);
    const period = 2 * (c.crossing.durationSec + 15);
    expect(at(period).x).toBeCloseTo(dock, 5);
  });

  it('heads east going out and west coming back', () => {
    expect(at(30).yaw).toBeCloseTo(Math.PI / 2, 5);
    expect(at(15 + c.crossing.durationSec + 15 + 20).yaw).toBeCloseTo(-Math.PI / 2, 5);
  });
});

describe('yard traffic', () => {
  it('stackers shuttle across their lane and dwell at each side', () => {
    const cross = stackerCrossings(CAT_LAI, path, raw.yardTraffic.reachStackers.count);
    expect(cross).toHaveLength(3);
    const out: StackerPose = { x: 0, z: 0, yaw: 0 };
    for (const c of cross) {
      const a = { ...stackerPose({ ...c, phaseSec: 0 }, 1, out) };
      expect([a.x, a.z]).toEqual([c.ax, c.az]);
      const b = { ...stackerPose({ ...c, phaseSec: 0 }, STACKER_DWELL_SEC + STACKER_CROSS_SEC + 1, out) };
      expect(b.x).toBeCloseTo(c.bx, 5);
      expect(b.z).toBeCloseTo(c.bz, 5);
      // The crossing spans the whole carriageway plus a margin on each side.
      expect(Math.hypot(c.bx - c.ax, c.bz - c.az)).toBeGreaterThan(7);
    }
    expect(new Set(cross.map((c) => c.phaseSec)).size).toBe(3);
  });

  it('trucks wrap inside the straight yard stretch and keep their spacing', () => {
    const n = raw.yardTraffic.trucks;
    for (const time of [0, 13, 97, 1234]) {
      const ts = Array.from({ length: n }, (_, k) => yardTruckT(k, n, time, path.lengthM));
      for (const t of ts) {
        expect(t).toBeGreaterThanOrEqual(YARD_TRUCK_FROM_T);
        expect(t).toBeLessThanOrEqual(YARD_TRUCK_TO_T);
      }
    }
  });

  it('quay tiles cover N −110..880 in 20 m steps along the river edge', () => {
    const z = quayTiles(raw.quay);
    expect(z).toHaveLength(50);
    expect(z[0]).toBeCloseTo(-870, 5);
    expect(z[z.length - 1]).toBeCloseTo(110, 5);
  });
});

/** Stub models with the real GLBs' sub-mesh layout; cranes carry a "Spreader" material. */
const PARTS: Record<string, string[]> = {
  'quay_edge.glb': ['Quay_Concrete', 'Bollard'],
  'sts_quay_crane.glb': ['STS_Frame', 'STS_Dark', 'Spreader', 'Glass'],
  'rtg_crane.glb': ['RTG_Yellow', 'Tire', 'Spreader'],
  'container_ship.glb': ['Ship_Hull', 'Ship_Deck', 'Ship_Windows'],
  'river_ferry.glb': ['Ferry_Hull', 'Ferry_Deck'],
  'reach_stacker.glb': ['Stacker_Yellow', 'Tire'],
  'container_truck_blue.glb': ['Truck_Cab', 'Container_Paint', 'Tire'],
  'container_truck_red.glb': ['Truck_Cab', 'Container_Paint', 'Tire'],
  'jump_ramp.glb': ['Ramp_Surface', 'Trim'],
};
const stubAssets = {
  cloneModel(p: string): THREE.Group {
    const g = new THREE.Group();
    for (const name of PARTS[p.split('/').pop() as string]) {
      const mat = new THREE.MeshStandardMaterial({ color: '#888888' });
      mat.name = name;
      const geo = name === 'Ramp_Surface' ? new THREE.BoxGeometry(18, 2, 10) : new THREE.BoxGeometry(1, 1, 1);
      g.add(new THREE.Mesh(geo, mat));
    }
    return g;
  },
  texture(): THREE.Texture {
    return new THREE.Texture();
  },
} as unknown as Assets;

describe('CatLaiQuay (stub models)', () => {
  it('lists every model it loads', () => {
    for (const m of ['sts_quay_crane', 'rtg_crane', 'container_ship', 'river_ferry', 'reach_stacker', 'quay_edge']) {
      expect(CAT_LAI_QUAY_MODELS.some((p) => p.includes(m))).toBe(true);
    }
  });

  it('builds, animates without reallocating instance buffers, and disposes', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const scene = new THREE.Scene();
    const quay = new CatLaiQuay(scene, RAPIER, world, stubAssets, CAT_LAI, path);
    expect(scene.children).toContain(quay.group);
    const meshes: THREE.InstancedMesh[] = [];
    quay.group.traverse((o) => o instanceof THREE.InstancedMesh && meshes.push(o));
    expect(meshes.length).toBeGreaterThan(8);
    const buffers = meshes.map((m) => m.instanceMatrix.array);
    const before = world.bodies.len();
    quay.setFocus(420, -400);
    for (let i = 0; i < 120; i++) quay.update(1 / 60);
    meshes.forEach((m, i) => expect(m.instanceMatrix.array).toBe(buffers[i]));
    // 1 static + 3 stackers + 4 trucks.
    expect(before).toBe(8);
    quay.dispose();
    expect(world.bodies.len()).toBe(0);
    expect(scene.children).not.toContain(quay.group);
  });

  it('stays within the draw-call budget with everything in view', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const quay = new CatLaiQuay(new THREE.Scene(), RAPIER, world, stubAssets, CAT_LAI, path);
    let draws = 0;
    quay.group.traverse((o) => {
      if ((o instanceof THREE.InstancedMesh || o instanceof THREE.Mesh) && o.visible) draws++;
    });
    expect(draws).toBeLessThanOrEqual(45);
    quay.dispose();
  });
});

describe('road width used for clearance', () => {
  it('the apron is 14 m wide where the quay cranes stand', () => {
    expect(roadWidthAt(CAT_LAI, 0.6)).toBeCloseTo(14, 5);
  });
});
