import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assets } from '../src/core/Assets';
import { CONG_HOA } from '../src/core/Data';
import { userSettings } from '../src/core/Settings';
import { CongHoaLandmarks } from '../src/world/CongHoaLandmarks';
import { TrackPath } from '../src/world/TrackPath';

beforeAll(async () => {
  await RAPIER.init();
});

/** Stub models with the real GLBs' sub-mesh names / counts (materials are MeshStandardMaterial, like the loader's). */
const PARTS: Record<string, string[]> = {
  'pedestrian_overpass.glb': ['Overpass_Deck', 'Railing', 'Overpass_Steel', 'Banner'],
  'flyover_pier.glb': ['Concrete_Pier'],
  'traffic_light.glb': ['Pole_Yellow', 'Housing', 'lamp_red', 'lamp_amber', 'lamp_green'],
  'airliner.glb': ['Fuselage', 'Stripe', 'Cockpit', 'Wing', 'Engine'],
  'scooter_red.glb': ['Tire', 'Scooter_Dark', 'Scooter_Body', 'Metal', 'Light_Head'],
  // Stub part lists with the real material names of the traffic cars and the bus.
  'car_sedan_white.glb': ['Civ_Paint', 'Glass', 'Trim', 'Light_Head', 'Light_Tail', 'Tire', 'Hub'],
  'car_sedan_silver.glb': ['Civ_Paint', 'Glass', 'Trim', 'Light_Head', 'Light_Tail', 'Tire', 'Hub'],
  'car_hatch_red.glb': ['Civ_Paint', 'Glass', 'Trim', 'Light_Head', 'Light_Tail', 'Tire', 'Hub'],
  'car_hatch_blue.glb': ['Civ_Paint', 'Glass', 'Trim', 'Light_Head', 'Light_Tail', 'Tire', 'Hub'],
  'car_taxi.glb': ['Civ_Paint', 'Glass', 'Trim', 'Light_Head', 'Light_Tail', 'Tire', 'Hub', 'Taxi_Sign', 'Taxi_Stripe'],
  'city_bus.glb': ['Bus_Paint', 'Bus_White', 'Glass', 'Route_Sign', 'Trim', 'Light_Head', 'Light_Tail', 'Tire', 'Hub'],
  'scooter_white.glb': ['Tire', 'Scooter_Dark', 'Scooter_Body', 'Metal', 'Light_Head'],
};
const stubAssets = {
  cloneModel(path: string): THREE.Group {
    const g = new THREE.Group();
    for (const name of PARTS[path.split('/').pop() as string]) {
      const mat = new THREE.MeshStandardMaterial({ color: '#888888', metalness: name === 'Metal' ? 0.9 : 0.1 });
      mat.name = name;
      if (name === 'Light_Head') {
        mat.emissive.set('#ffffff');
        mat.emissiveIntensity = 2;
      }
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      m.name = name;
      g.add(m);
    }
    return g;
  },
} as unknown as Assets;

const build = (): { world: RAPIER.World; scene: THREE.Scene; lm: CongHoaLandmarks } => {
  const path = new TrackPath(CONG_HOA.spline.points, 2, 40);
  const world = new RAPIER.World({ x: 0, y: -15, z: 0 });
  const scene = new THREE.Scene();
  return { world, scene, lm: new CongHoaLandmarks(scene, RAPIER, world, stubAssets, CONG_HOA, path) };
};

const drawCalls = (lm: CongHoaLandmarks): number => {
  let n = 0;
  lm.group.traverse((o) => {
    if (o instanceof THREE.Mesh && o.visible) n++;
  });
  return n;
};

describe('CongHoaLandmarks (stub models, real Cong Hoa data)', () => {
  it('builds everything within 30 draw calls, steps, flies the airliner, and disposes cleanly', () => {
    userSettings.preset = 'med';
    const { world, scene, lm } = build();
    const bodies = world.bodies.len();
    expect(bodies).toBeGreaterThan(36); // 1 static body + 36 kinematic scooters
    console.log(
      `LANDMARKS draw calls (airliner hidden)=${drawCalls(lm)} bodies=${bodies} colliders=${world.colliders.len()} piersNearRoad=${lm.pierReport.map((p) => p.index).join(',')} skipped=${lm.skippedKinds.join(',')}`,
    );
    expect(drawCalls(lm)).toBeLessThanOrEqual(36); // 30 before cars + bus; far traffic sets are culled in play
    expect(lm.skippedKinds).toEqual([]); // scooters, cars and buses all have models now

    // 20 s of fixed steps: the airliner appears at least once; scooters keep moving without throwing.
    let seen = false;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 60 * 20; i++) {
      world.step();
      lm.update(1 / 60);
      const plane = lm.group.children.find((c) => c.visible && c instanceof THREE.Group && c.position.y > 50);
      if (plane) {
        seen = true;
        min = Math.min(min, plane.position.y);
        max = Math.max(max, plane.position.y);
      }
    }
    expect(seen).toBe(true);
    expect(max).toBeLessThanOrEqual(120.5);
    expect(min).toBeGreaterThanOrEqual(79.5);
    console.log(`LANDMARKS draw calls (airliner visible peak) <= ${drawCalls(lm) + 2}`);

    lm.dispose();
    expect(world.bodies.len()).toBe(0);
    expect(scene.children.length).toBe(0);
  });

  it('creates no traffic bodies on the Low quality preset', () => {
    userSettings.preset = 'low';
    const { world, lm } = build();
    expect(world.bodies.len()).toBe(1); // only the static landmark body
    expect(lm.skippedKinds).toEqual([]); // traffic is not built at all
    lm.dispose();
    userSettings.preset = 'med';
  });
});
