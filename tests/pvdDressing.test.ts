import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assets } from '../src/core/Assets';
import { PHAM_VAN_DONG, RACE } from '../src/core/Data';
import { minDistToPath } from '../src/world/CongHoaDressing';
import {
  BLINK_HZ,
  HOUSE_CLEARANCE_M,
  HOUSE_DEPTH_M,
  OVERPASS_SCALE_X,
  PVD_DRESSING_MODELS,
  PvdDressing,
  TILE_CLEARANCE_M,
  exclusionRanges,
  faceRoadYaw,
  headingYaw,
  makeBoulevard,
  planPvd,
  rectsOverlap,
  shelterYaw,
  sideOf,
  specFromTrack,
  touchesRange,
} from '../src/world/PvdDressing';
import { relaxTightBends } from '../src/world/relaxBends';
import { TrackPath } from '../src/world/TrackPath';

beforeAll(async () => {
  await RAPIER.init();
});

const path = new TrackPath(
  relaxTightBends(PHAM_VAN_DONG.spline.points, RACE.track.minTurnRadiusM),
  RACE.track.sampleSpacingM,
  RACE.track.projectWindowSamples,
);
const spec = specFromTrack(PHAM_VAN_DONG.raw);
const plan = planPvd(path, spec);
const ex = exclusionRanges(path, spec);
const northing = (z: number): number => -z;

describe('PvdSpec (read from pham_van_dong.json)', () => {
  it('derives the cross-section offsets from the road layout', () => {
    expect(spec.medianHalfM).toBe(4);
    expect(spec.outboundU).toBeCloseTo(9.5, 5); // the east car lanes' centre: the racing line
    expect(spec.inboundU).toBeCloseTo(-20.1, 5); // the west motorbike lanes' centre
    expect(spec.sidewalkU).toBeCloseTo(26.1, 5);
    expect(spec.halfM).toBeCloseTo(28.6, 5);
    expect(spec.frontageM).toBe(29);
    expect(spec.separatorU).toEqual([15.8, -15.8]);
    expect(spec.bridges).toEqual([
      [520, 1080],
      [1500, 1620],
    ]);
    expect(spec.overpassN).toBe(1925);
  });

  it('lists the authored one-offs', () => {
    expect(spec.shelters).toHaveLength(6);
    expect(spec.floodSigns).toHaveLength(2);
    expect(spec.overpasses).toHaveLength(2);
    expect(spec.gantries.map((g) => g.side)).toEqual(['start', 'outbound', 'inbound']);
  });

  it('keeps the north end and the flooded dip out of the dressing', () => {
    expect(ex.northN).toBeLessThan(-path.pointAt(spec.flyoverFromT).z);
    const [a, b] = ex.westOnly[0];
    expect(a).toBeLessThan(-path.pointAt(spec.flood.fromT).z);
    expect(b).toBeGreaterThan(-path.pointAt(spec.flood.toT).z);
  });
});

describe('geometry helpers', () => {
  it('touchesRange', () => {
    expect(touchesRange(100, 10, [[105, 200]])).toBe(true);
    expect(touchesRange(100, 4, [[105, 200]])).toBe(false);
    expect(touchesRange(210, 4, [[105, 200]])).toBe(false);
  });

  it('rectsOverlap handles rotation and margin', () => {
    const a = { x: 0, z: 0, hw: 2, hd: 5, yaw: 0 };
    expect(rectsOverlap(a, { x: 3, z: 0, hw: 2, hd: 2, yaw: 0 })).toBe(true);
    expect(rectsOverlap(a, { x: 5, z: 0, hw: 2, hd: 2, yaw: 0 })).toBe(false);
    expect(rectsOverlap(a, { x: 5, z: 0, hw: 2, hd: 2, yaw: 0 }, 1.5)).toBe(true); // margin closes the gap
    // turned 90 degrees the long side reaches farther along x
    expect(rectsOverlap({ ...a, yaw: Math.PI / 2 }, { x: 5, z: 0, hw: 1, hd: 1, yaw: 0 })).toBe(true);
  });

  it('faces houses toward the road and aligns models with the heading', () => {
    const north = { tx: 0, tz: -1 };
    expect(headingYaw(north)).toBeCloseTo(Math.PI, 5);
    // a facade on the east side must look west: local +Z -> world -X
    const east = faceRoadYaw(north, 1);
    expect(Math.sin(east)).toBeCloseTo(-1, 5);
    const west = faceRoadYaw(north, -1);
    expect(Math.sin(west)).toBeCloseTo(1, 5);
    // shelters run along the road, whichever side they stand on
    for (const u of [1, -1]) {
      const y = shelterYaw(north, u);
      expect(Math.abs(Math.sin(y))).toBeLessThan(1e-9);
    }
  });

  it('puts the boulevard centre 9.5 m west of the outbound line and extends straight south and north', () => {
    const b = makeBoulevard(path, spec);
    const c0 = b.centreAtN(0);
    expect(c0.x).toBeCloseTo(0, 3);
    const s = b.centreAtN(-40);
    expect(s.x).toBeCloseTo(c0.x, 3);
    expect(s.z).toBeCloseTo(40, 3);
    const mid = b.centreAtN(1200);
    const east = sideOf(mid, spec.outboundU);
    // the east car-lane centre is the racing line: it lies on the path
    expect(minDistToPath(path, east.x, east.z)).toBeLessThan(0.6);
    const far = b.centreAtN(b.endN + 30);
    expect(far.z).toBeCloseTo(b.centreAtN(b.endN).z + far.tz * 30, 3);
  });
});

describe('planPvd (real Map 4 path)', () => {
  it('lays a median and two separator rows', () => {
    expect(plan.median.length).toBeGreaterThan(60);
    expect(plan.separators.length).toBeGreaterThan(100);
  });

  it('keeps median and separators off the bridges, the overpass and the racing line', () => {
    for (const s of [...plan.median, ...plan.separators]) {
      expect(touchesRange(northing(s.z), 0, ex.both)).toBe(false);
      expect(minDistToPath(path, s.x, s.z)).toBeGreaterThan(TILE_CLEARANCE_M);
    }
  });

  it('leaves the lane-swap gaps open in the separators', () => {
    for (const g of spec.separatorGapsN) {
      const inGap = plan.separators.filter((s) => Math.abs(northing(s.z) - g) < 8);
      expect(inGap).toHaveLength(0);
    }
  });

  it('keeps the west side clear around the flooded dip', () => {
    const [a, b] = ex.westOnly[0];
    const west = [...plan.separators, ...plan.houses, ...plan.trees].filter((s) => {
      const c = makeBoulevard(path, spec).centreAtN(northing(s.z));
      const u = (s.x - c.x) * -c.tz + (s.z - c.z) * c.tx;
      return u < -10;
    });
    for (const s of west) expect(northing(s.z) < a || northing(s.z) > b).toBe(true);
  });

  it('places shophouses on both frontages, facing the road, clear of the lanes and the structures', () => {
    expect(plan.houses.length).toBeGreaterThan(150);
    for (const h of plan.houses) {
      expect(touchesRange(h.n, 0, ex.both)).toBe(false);
      expect(h.n).toBeLessThan(ex.northN);
      // facade 29 m from the centre line is 5.4 m beyond the road edge on the near lane
      const o = { x: h.x - Math.sin(h.yaw) * (HOUSE_DEPTH_M / 2), z: h.z - Math.cos(h.yaw) * (HOUSE_DEPTH_M / 2) };
      expect(minDistToPath(path, o.x, o.z)).toBeGreaterThan(HOUSE_CLEARANCE_M);
    }
    const sides = new Set(plan.houses.map((h) => Math.sign(Math.sin(h.yaw))));
    expect(sides.has(1) && sides.has(-1)).toBe(true);
  });

  it('puts apartment towers on the east side only, 60 m back', () => {
    expect(plan.apartments.length).toBeGreaterThanOrEqual(3);
    const b = makeBoulevard(path, spec);
    for (const t of plan.apartments) {
      const c = b.centreAtN(northing(t.z));
      const u = (t.x - c.x) * -c.tz + (t.z - c.z) * c.tx;
      expect(u).toBeGreaterThan(spec.halfM + 60);
    }
  });

  it('spreads street trees on both sidewalks, clear of the lanes', () => {
    expect(plan.trees.length).toBeGreaterThan(80);
    for (const t of plan.trees) expect(minDistToPath(path, t.x, t.z)).toBeGreaterThan(2.5);
  });

  it('places the authored one-offs where the JSON says, scaled and oriented', () => {
    expect(plan.shelters).toHaveLength(6);
    expect(plan.floodSigns).toHaveLength(2);
    expect(plan.floodSigns.map((s) => [s.x, s.z])).toEqual(spec.floodSigns.map((p) => [p[0], p[2]]));
    // flood signs look along the boulevard's heading, to be read by southbound traffic: -Z face -> south
    for (const s of plan.floodSigns) expect(Math.cos(s.yaw)).toBeGreaterThan(0.9);
    expect(plan.overpasses).toHaveLength(2);
    for (const o of plan.overpasses) expect(o.scaleX).toBe(OVERPASS_SCALE_X);
    expect(plan.gantries.map((g) => g.model.split('/').pop())).toEqual([
      'sign_gantry_outbound.glb',
      'sign_gantry_outbound.glb',
      'sign_gantry_inbound.glb',
    ]);
  });

  it('is deterministic', () => {
    const again = planPvd(path, spec);
    expect(again.houses.length).toBe(plan.houses.length);
    expect(again.trees[5]).toEqual(plan.trees[5]);
  });

  it('keep-outs remove what they cover', () => {
    const h = plan.houses.find((x) => x.n > 300) ?? plan.houses[10];
    const withKeepout = planPvd(path, spec, undefined, [{ x: h.x, z: h.z, hw: 30, hd: 30, yaw: 0 }]);
    expect(withKeepout.houses.length).toBeLessThan(plan.houses.length);
    expect(withKeepout.trees.length).toBeLessThan(plan.trees.length);
  });
});

// ---- scene (stub models with the real GLBs' node / material names) -------------------------------

/** Real material names per model; textured ones get a texture, emissive ones an emissive colour. */
const PARTS: Record<string, string[]> = {
  'boulevard_median.glb': [
    'Curb_Dark',
    'Curb_Stripe',
    'Median_Grass',
    'Tree_Bark',
    'Tree_Leaf',
    'Tree_Leaf_Dark',
    'Pole',
    'Lamp_LED',
  ],
  'lane_separator.glb': ['Curb_Stripe', 'Soil', 'Shrub', 'Rail_Post', 'Rail_Yellow'],
  'rain_shelter.glb': ['Shelter_Steel', 'Shelter_Roof', 'Shelter_Glass', 'Bench'],
  'flood_sign.glb': ['Sign_Post', 'Flood_Sign', 'Sign_Blink'],
  'sign_gantry_outbound.glb': ['Gantry_Steel', 'Gantry_Sign', 'Sign_Back'],
  'sign_gantry_inbound.glb': ['Gantry_Steel', 'Gantry_Sign', 'Sign_Back'],
  'shophouse_a.glb': ['Facade_3', 'Window', 'Shop_Sign', 'Awning', 'Trim_Light', 'Railing', 'Plant', 'Water_Tank'],
  'shophouse_b.glb': ['Facade_8', 'Window', 'Shop_Sign', 'Awning', 'Trim_Light', 'Railing', 'Water_Tank'],
  'shophouse_c.glb': ['Facade_13', 'Shutter', 'Shop_Sign', 'Awning', 'Window', 'Trim_Light', 'Railing', 'Plant'],
  'shophouse_d.glb': ['Facade_21', 'Shutter', 'Shop_Sign', 'Awning', 'Window', 'Trim_Light', 'Railing', 'Plant'],
  'apartment_tower_a.glb': ['Apartment_Facade', 'Apartment_Trim', 'Crown_Light'],
  'apartment_tower_b.glb': ['Apartment_Facade', 'Apartment_Trim', 'Crown_Light'],
  'pedestrian_overpass.glb': ['Overpass_Deck', 'Railing', 'Overpass_Steel', 'Banner'],
  'street_tree_a.glb': ['Bark', 'Curb', 'Leaves'],
  'street_tree_b.glb': ['Bark', 'Curb', 'Leaves'],
};
const TEXTURED = new Set(['Shop_Sign', 'Flood_Sign', 'Gantry_Sign', 'Apartment_Facade']);
const EMISSIVE = new Set(['Lamp_LED', 'Sign_Blink', 'Crown_Light', 'Apartment_Facade']);
const sizes: Record<string, [number, number, number]> = {
  'boulevard_median.glb': [8, 12, 20],
  'lane_separator.glb': [1.6, 1.2, 20],
  'shophouse_a.glb': [6, 11, 15],
  'shophouse_b.glb': [4, 18, 15],
  'shophouse_c.glb': [5, 15, 15],
  'shophouse_d.glb': [5, 15, 15],
};

const stubAssets = {
  cloneModel(modelPath: string): THREE.Group {
    const file = modelPath.split('/').pop() as string;
    const g = new THREE.Group();
    const [sx, sy, sz] = sizes[file] ?? [2, 2, 2];
    for (const name of PARTS[file] ?? ['Plain']) {
      const mat = new THREE.MeshStandardMaterial({ color: '#888888', metalness: name === 'Pole' ? 0.7 : 0.1 });
      mat.name = name;
      if (TEXTURED.has(name)) {
        const tex = new THREE.Texture({ width: 64, height: 64 } as unknown as HTMLImageElement);
        tex.name = `${name}_atlas`;
        mat.map = tex;
      }
      if (EMISSIVE.has(name)) {
        mat.emissive.set('#ffeeaa');
        mat.emissiveIntensity = 4;
      }
      const geo = new THREE.BoxGeometry(sx, sy, sz).translate(0, sy / 2, file.startsWith('shophouse') ? -sz / 2 : 0);
      g.add(new THREE.Mesh(geo, mat));
    }
    return g;
  },
} as unknown as Assets;

const meshes = (d: PvdDressing): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  d.group.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
};

describe('PvdDressing (stub models, real Map 4 data)', () => {
  it('lists every GLB it loads, once', () => {
    expect(new Set(PVD_DRESSING_MODELS).size).toBe(PVD_DRESSING_MODELS.length);
    expect(PVD_DRESSING_MODELS).toContain('models/props_pvd/boulevard_median.glb');
    expect(PVD_DRESSING_MODELS).toContain('models/props_conghoa/shophouse_a.glb');
  });

  it('bakes everything into a handful of meshes per chunk, adds no physics, and disposes cleanly', () => {
    const world = new RAPIER.World({ x: 0, y: -15, z: 0 });
    const scene = new THREE.Scene();
    const d = new PvdDressing(scene, RAPIER, world, stubAssets, PHAM_VAN_DONG, path);
    expect(world.bodies.len()).toBe(0); // Track's walls already keep cars off the median and sidewalks
    expect(world.colliders.len()).toBe(0);
    const all = meshes(d);
    expect(all.length).toBeGreaterThan(0);
    // per distance-cull chunk: the two shared vertex-colour materials plus textured / glowing ones
    const perChunk = new Map<THREE.Object3D, number>();
    for (const m of all) perChunk.set(m.parent as THREE.Object3D, (perChunk.get(m.parent as THREE.Object3D) ?? 0) + 1);
    for (const n of perChunk.values()) expect(n).toBeLessThanOrEqual(9);
    // the shared vertex-colour materials really are shared across chunks
    const names = new Set(all.map((m) => (m.material as THREE.Material).name));
    expect(names.has('Merged_matte') || names.has('Merged_metal')).toBe(true);
    d.dispose();
    expect(scene.children.length).toBe(0);
  });

  it('pulses the flood-sign blinkers and survives a long run', () => {
    const world = new RAPIER.World({ x: 0, y: -15, z: 0 });
    const scene = new THREE.Scene();
    const d = new PvdDressing(scene, RAPIER, world, stubAssets, PHAM_VAN_DONG, path);
    const blink = meshes(d).find((m) => (m.material as THREE.Material).name === 'Sign_Blink')
      ?.material as THREE.MeshStandardMaterial;
    expect(blink).toBeDefined();
    const seen = new Set<number>();
    for (let i = 0; i < Math.round(60 / BLINK_HZ); i++) {
      d.update(1 / 60);
      seen.add(Math.round(blink.emissiveIntensity * 100));
    }
    expect(seen.size).toBeGreaterThanOrEqual(2); // it goes bright and dim
    d.dispose();
  });
});
