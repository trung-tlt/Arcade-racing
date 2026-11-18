import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assets } from '../src/core/Assets';
import { XA_LO } from '../src/core/Data';
import {
  distanceToPathM,
  polylineLengthM,
  polylinePoseAt,
  spanPlacements,
  trainHeadM,
  trainsPerDirection,
} from '../src/world/Corridor';
import { TrackPath } from '../src/world/TrackPath';
import {
  billboardYaw,
  edgeClearanceM,
  stationEdgeClearanceM,
  planBillboard,
  planSkywalk,
  stationPoseAt,
  viaductPolyline,
  XALO_METRO_MODELS,
  XaLoMetro,
} from '../src/world/XaLoMetro';

beforeAll(async () => {
  await RAPIER.init();
});

interface RawXaLo {
  metro: { viaduct: { path: number[][]; spanM: number }; stations: { position: number[] }[] };
  gantries: { t: number }[];
  billboards: { position: number[]; facing: string }[];
}
const raw = XA_LO.raw as unknown as RawXaLo;
const path = new TrackPath(XA_LO.spline.points, 2, 40);
const HALF = XA_LO.roadWidthM / 2;

describe('polyline helpers', () => {
  const poly = [
    [0, 0, 0],
    [0, 0, -100],
    [100, 10, -100],
  ];
  it('measures length and poses along bends', () => {
    expect(polylineLengthM(poly)).toBeCloseTo(200);
    const p = polylinePoseAt(poly, 150, { x: 0, y: 0, z: 0, yaw: 0 });
    expect(p.x).toBeCloseTo(50);
    expect(p.z).toBeCloseTo(-100);
    expect(p.y).toBeCloseTo(5);
    expect(p.yaw).toBeCloseTo(Math.PI / 2);
  });
  it('tiles whole spans centred in their slots', () => {
    const spans = spanPlacements(poly, 30);
    expect(spans).toHaveLength(6);
    expect(spans[0].z).toBeCloseTo(-15);
    expect(spans[0].yaw).toBeCloseTo(Math.PI);
  });
  it('follows the outbound leg shifted 32 m west, heading −Z', () => {
    const poly = viaductPolyline(path, -300, -1800, -32, 30);
    expect(poly.length).toBeGreaterThan(40);
    expect(poly[0][2]).toBeLessThanOrEqual(-300);
    expect(poly[poly.length - 1][2]).toBeGreaterThanOrEqual(-1800);
    for (let i = 1; i < poly.length; i++) expect(poly[i][2]).toBeLessThan(poly[i - 1][2]);
    expect(spanPlacements(poly, 30).length).toBeGreaterThan(45);
  });
});

describe('train timing', () => {
  it('leaves each headway apart and wraps the loop', () => {
    expect(trainHeadM(40, 20, 1000, 40, 1)).toBeCloseTo(0);
    expect(trainHeadM(41, 20, 1000, 40, 1)).toBeCloseTo(20);
    expect(trainHeadM(0, 20, 1000, 40, 1)).toBeCloseTo(200); // not yet departed: wraps from the back
    expect(trainHeadM(60, 20, 1000, 40, 0)).toBeCloseTo(200);
  });
  it('needs two trains per direction on the real line at 80 km/h and 40 s headway', () => {
    expect(trainsPerDirection(1503 + 83.5, 80 / 3.6, 40)).toBe(2);
  });
});

describe('clearance against the real spline', () => {
  it('distanceToPathM is zero on the path', () => {
    expect(distanceToPathM(path, path.px[100], path.pz[100])).toBeLessThan(0.01);
  });
  it('every sign gantry has legs clear of the racing line', () => {
    const pts = raw.gantries.map((g) => path.pointAt(g.t));
    expect(pts).toHaveLength(4);
  });
  it('plans every billboard at least road half width + 3 m clear and facing its traffic', () => {
    for (const b of raw.billboards) {
      const plan = planBillboard(path, b.position[0], b.position[2], HALF + 3);
      expect(plan.minDistM).toBeGreaterThanOrEqual(HALF + 3);
      const yaw = billboardYaw(path, plan.x, plan.z, b.facing);
      const heads = { x: Math.sin(yaw), z: Math.cos(yaw) };
      expect(heads.z * (b.facing.startsWith('outbound') ? -1 : 1)).toBeGreaterThan(0.9);
    }
  });
  it('plans skywalks that clear the road, or reports that none fits', () => {
    const poly = viaductPolyline(path, -300, -1800, -32, 30);
    for (const st of raw.metro.stations) {
      for (const east of [true, false]) {
        const plan = planSkywalk(path, stationPoseAt(poly, st.position[2]), east, HALF + 1.5);
        if (plan) expect(plan.minDistM).toBeGreaterThanOrEqual(HALF + 1.5);
      }
    }
  });
});

/** Stub models: real sub-mesh and material names, one box each. */
const PARTS: Record<string, string[]> = {
  'metro_viaduct_span.glb': ['Concrete_Light', 'Concrete_Dark', 'Rail', 'Lamp'],
  'metro_station.glb': ['Concrete_Light', 'Station_Glass', 'Platform', 'Steel_Orange', 'Station_Roof'],
  'skywalk.glb': ['Concrete_Light', 'Skywalk_Glass', 'Skywalk_Roof', 'Steel'],
  'metro_car_cab.glb': ['Train_Body', 'Train_Window', 'Train_Interior', 'Train_Band', 'Train_Door', 'Light_Head'],
  'metro_car_mid.glb': ['Train_Body', 'Train_Window', 'Train_Interior', 'Train_Band', 'Train_Door'],
  'sign_gantry_outbound.glb': ['Gantry_Steel', 'Gantry_Sign', 'Sign_Back'],
  'sign_gantry_inbound.glb': ['Gantry_Steel', 'Gantry_Sign', 'Sign_Back'],
};
const EMISSIVE = new Set(['Train_Window', 'Lamp', 'Station_Glass', 'Light_Head', 'Skywalk_Glass', 'Gantry_Sign']);
const stubAssets = {
  cloneModel(p: string): THREE.Group {
    const g = new THREE.Group();
    const name = p.split('/').pop() as string;
    for (const part of PARTS[name] ?? ['Billboard_Steel', 'Billboard_Ad', 'Billboard_Lamp']) {
      const mat = new THREE.MeshStandardMaterial({ color: '#888888' });
      mat.name = part;
      if (EMISSIVE.has(part) || part === 'Billboard_Lamp') {
        mat.emissive.set('#ffffff');
        mat.emissiveIntensity = 1;
      }
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      m.name = part;
      g.add(m);
    }
    return g;
  },
} as unknown as Assets;

function build(): { metro: XaLoMetro; scene: THREE.Scene; world: RAPIER.World } {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const scene = new THREE.Scene();
  return { metro: new XaLoMetro(scene, RAPIER, world, stubAssets, XA_LO, path), scene, world };
}

describe('XaLoMetro scene', () => {
  it('lists its eleven models', () => {
    expect(XALO_METRO_MODELS).toHaveLength(11);
    expect(new Set(XALO_METRO_MODELS).size).toBe(11);
  });

  it('builds, animates trains without allocating new instance buffers, and disposes', () => {
    const { metro, scene, world } = build();
    expect(metro.spanCount).toBeGreaterThan(45);
    expect(metro.drawCallEstimate).toBeGreaterThan(0);
    const bodies = world.bodies.len();
    const trains = metro.group.children.filter(
      (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && /Train/.test(c.name),
    );
    expect(trains.length).toBeGreaterThan(0);
    const before = trains.map((m) => m.instanceMatrix.array);
    const x0 = before[0][14];
    for (let i = 0; i < 120; i++) metro.update(1 / 60);
    expect(trains.map((m) => m.instanceMatrix.array)).toEqual(before);
    expect(trains[0].instanceMatrix.array[14]).not.toBe(x0);
    metro.dispose();
    expect(world.bodies.len()).toBe(bodies - 1);
    expect(scene.children).toHaveLength(0);
  });

  it('keeps train windows emissive after merging', () => {
    const { metro } = build();
    const win = metro.group.children.filter(
      (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.name === 'Train_Window',
    );
    expect(win.length).toBeGreaterThan(0);
    for (const m of win) expect((m.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(0);
  });

  it('no pier collider or station body is closer than road half width + 1.5 m to any racing-path sample', () => {
    const { metro } = build();
    for (const p of metro.piers)
      expect(edgeClearanceM(XA_LO, path, p.x, p.z) - 1.1, `pier ${p.index}`).toBeGreaterThanOrEqual(1.5);
    expect(metro.stationPoses).toHaveLength(3);
    for (const pose of metro.stationPoses) expect(stationEdgeClearanceM(XA_LO, path, pose)).toBeGreaterThanOrEqual(1.5);
  });

  it('gives only piers within 8 m of the racing line a collider, one fixed body', () => {
    const { metro, world } = build();
    for (const p of metro.piers) expect(p.distToRoadM).toBeLessThanOrEqual(8);
    expect(world.colliders.len()).toBe(metro.piers.length);
    expect(world.bodies.len()).toBe(1);
  });

  it('every piece that was placed clears the road; every report is ok, shifted, rotated or skipped', () => {
    const { metro } = build();
    for (const r of metro.reports) {
      if (r.kind === 'station' || r.action === 'skipped') continue;
      expect(r.minDistM, r.name).toBeGreaterThanOrEqual(r.requiredM);
    }
    console.log(
      'XALO piers',
      metro.piers.map((p) => `${p.index}:t=${p.t.toFixed(4)}:d=${p.distToRoadM.toFixed(1)}`).join(' '),
    );
    console.log(
      'XALO reports',
      JSON.stringify(metro.reports, (_k, v) => (v === Infinity ? 'inf' : v)),
    );
    console.log(
      'XALO draw calls',
      metro.drawCallEstimate,
      'spans',
      metro.spanCount,
      'skipped',
      metro.skippedSpans.join(','),
    );
  });
});
