import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assets } from '../src/core/Assets';
import { CAT_LAI, RACE, roadWidthAt } from '../src/core/Data';
import {
  BLOCK_LANE_M,
  CAT_LAI_YARD_MODELS,
  CatLaiYard,
  GATE_MODEL,
  SIZES,
  type Rect,
  chunkKey,
  clearanceM,
  distToRect,
  groupByChunk,
  halfWidthAt,
  lineDistanceM,
  packAxis,
  packColumns,
  rotateLocal,
  planYard,
  rectsOverlap,
  specFromTrack,
  subtractBands,
} from '../src/world/CatLaiYard';
import { DistanceCull } from '../src/world/Windowed';
import { TrackPath } from '../src/world/TrackPath';

beforeAll(async () => {
  await RAPIER.init();
});

const path = new TrackPath(CAT_LAI.spline.points, RACE.track.sampleSpacingM, RACE.track.projectWindowSamples);
const spec = specFromTrack(CAT_LAI.raw);
const halfAt = halfWidthAt(CAT_LAI, path.count);
const plan = planYard(path, CAT_LAI, spec);
const blockRect = (b: { x: number; z: number; yaw: number }): Rect => ({
  cx: b.x,
  cz: b.z,
  hw: SIZES.block.hw,
  hd: SIZES.block.hd,
  yaw: b.yaw,
});

describe('spec + models', () => {
  it('reads the yard numbers from the map json', () => {
    expect(spec.areas).toHaveLength(4);
    expect(spec.blockSizeM).toEqual([15, 13, 62.5]);
    expect(spec.queue).toEqual({ fromN: 80, toN: 560, spacingM: 19 });
    expect(spec.warehouseSpacingM).toBe(70);
    expect(spec.lampEveryM).toBe(40);
    expect(spec.mastSpacingM).toBe(60);
    expect(spec.stsZ).toEqual([-780, -640, -500, -360, -220, -80]);
    expect(spec.truckRoad.fromT).toBe(0);
  });

  it('lists every model once, under the assets tree', () => {
    expect(new Set(CAT_LAI_YARD_MODELS).size).toBe(CAT_LAI_YARD_MODELS.length);
    for (const m of CAT_LAI_YARD_MODELS) expect(m).toMatch(/^models\/.+\.glb$/);
  });
});

describe('geometry helpers', () => {
  it('distToRect is 0 inside and Euclidean outside, for a rotated rectangle', () => {
    const r: Rect = { cx: 10, cz: 20, hw: 2, hd: 5, yaw: Math.PI / 2 }; // turned: 5 across x, 2 along z
    expect(distToRect(r, 10, 20)).toBe(0);
    expect(distToRect(r, 14.5, 20)).toBe(0);
    expect(distToRect(r, 16, 20)).toBeCloseTo(1, 6);
    expect(distToRect(r, 10, 24)).toBeCloseTo(2, 6);
  });

  it('rectsOverlap sees real overlaps only', () => {
    const a: Rect = { cx: 0, cz: 0, hw: 5, hd: 5, yaw: 0 };
    expect(rectsOverlap(a, { cx: 9, cz: 0, hw: 5, hd: 5, yaw: 0 })).toBe(true);
    expect(rectsOverlap(a, { cx: 10, cz: 0, hw: 5, hd: 5, yaw: 0 })).toBe(false);
    expect(rectsOverlap(a, { cx: 7, cz: 7, hw: 5, hd: 5, yaw: Math.PI / 4 })).toBe(true);
  });

  it('packAxis / packColumns fit blocks with the lane between them', () => {
    expect(packAxis(0, 62.5, 62.5, 10)).toEqual([31.25]);
    expect(packAxis(0, 60, 62.5, 10)).toEqual([]);
    const c = packAxis(0, 200, 62.5, 10);
    expect(c).toHaveLength(2);
    expect(c[1] - c[0]).toBeCloseTo(72.5, 6);
    expect(packColumns(270, 400, 15, 10)).toEqual([277.5, 302.5, 327.5, 352.5, 377.5]);
    expect(packColumns(260, 320, 15, 10)).toEqual([267.5, 292.5]);
  });

  it('subtractBands cuts spans', () => {
    expect(subtractBands(-880, -680, [[-776.5, -763.5]])).toEqual([
      [-880, -776.5],
      [-763.5, -680],
    ]);
    expect(subtractBands(0, 10, [[20, 30]])).toEqual([[0, 10]]);
  });

  it('clearanceM is negative on the road and grows away from it', () => {
    const p = { x: path.px[10], z: path.pz[10] };
    const on: Rect = { cx: p.x, cz: p.z, hw: 1, hd: 1, yaw: 0 };
    expect(clearanceM(path, halfAt, on)).toBeLessThan(0);
    expect(lineDistanceM(path, on)).toBeLessThan(1);
    const off: Rect = { cx: p.x + 40, cz: p.z, hw: 1, hd: 1, yaw: 0 };
    expect(clearanceM(path, halfAt, off)).toBeGreaterThan(20);
  });

  it('chunks every item exactly once', () => {
    const items = [
      { x: 10, z: 10 },
      { x: 160, z: 10 },
      { x: 20, z: 12 },
    ];
    const g = groupByChunk(items);
    expect([...g.values()].flat()).toHaveLength(3);
    expect(chunkKey(10, 10)).toBe(chunkKey(20, 12));
    expect(chunkKey(160, 10)).not.toBe(chunkKey(10, 10));
  });
});

describe('plan', () => {
  it('is deterministic and drops nothing but a mast with the shipped data', () => {
    expect(planYard(path, CAT_LAI, spec)).toEqual(plan);
    // Only flood masts may be dropped (one stands in the apron bend); never blocks, trucks or warehouses.
    expect(plan.dropped.filter((d) => !d.startsWith('mast@'))).toEqual([]);
  });

  it('packs the four areas with 10 m lanes between blocks, inside the areas, off the shortcut', () => {
    expect(plan.blocks.length).toBeGreaterThan(40);
    for (const b of plan.blocks) {
      const inside = spec.areas.some(
        (a) =>
          b.x - SIZES.block.hw >= a.x[0] - 1e-6 &&
          b.x + SIZES.block.hw <= a.x[1] + 1e-6 &&
          b.z - SIZES.block.hd >= -a.n[1] - 1e-6 &&
          b.z + SIZES.block.hd <= -a.n[0] + 1e-6,
      );
      expect(inside).toBe(true);
      // Never inside the 7 m Reefer lane ± 3 m (z -770 for x 250…420).
      expect(Math.abs(b.z - spec.shortcut.points[0][1]) - SIZES.block.hd).toBeGreaterThanOrEqual(6.5 - 1e-6);
    }
    for (let i = 0; i < plan.blocks.length; i++) {
      for (let j = i + 1; j < plan.blocks.length; j++) {
        const a = blockRect(plan.blocks[i]);
        const b = blockRect({ ...plan.blocks[j] });
        // Neighbours (same column or row) keep a lane: footprint gap ≥ 10 m on the axis that separates them.
        const gx = Math.abs(a.cx - b.cx) - 2 * SIZES.block.hw;
        const gz = Math.abs(a.cz - b.cz) - 2 * SIZES.block.hd;
        expect(gx >= BLOCK_LANE_M - 1e-6 || gz >= BLOCK_LANE_M - 1e-6).toBe(true);
      }
    }
  });

  it('keeps every block off the road (≥ 0.5 m beyond the carriageway edge)', () => {
    for (const b of plan.blocks) expect(clearanceM(path, halfAt, blockRect(b))).toBeGreaterThanOrEqual(0.5);
  });

  it('queues 25 trucks bumper to bumper in the rightmost lane of the truck road, N 80–560', () => {
    expect(plan.trucks).toHaveLength(Math.floor((560 - 80) / 19));
    const half = roadWidthAt(CAT_LAI, 0.05) / 2;
    plan.trucks.forEach((t, k) => {
      // Heading −Z, so the right-hand lane is east: x ≈ half − lane/2.
      expect(t.x).toBeGreaterThan(half - 2.2);
      expect(t.x).toBeLessThan(half - 1.2);
      expect(-t.z).toBeGreaterThanOrEqual(80);
      expect(-t.z).toBeLessThanOrEqual(560);
      expect(Math.abs(Math.abs(t.yaw) - Math.PI)).toBeLessThan(0.15);
      if (k > 0) expect(Math.abs(t.z - plan.trucks[k - 1].z)).toBeCloseTo(19, 0);
      expect(t.kind).toBe(k % 2);
    });
    // The three other lanes (10.5 m) stay free: the truck's footprint starts 4 m east of the racing line (x = 0).
    for (const t of plan.trucks) {
      const r: Rect = { cx: t.x, cz: t.z, hw: SIZES.truck.hw, hd: SIZES.truck.hd, yaw: t.yaw };
      expect(lineDistanceM(path, r)).toBeGreaterThan(3.5);
    }
  });

  it('places warehouses on both sides of the truck road, 70 m apart, ≥ 10 m from any road edge', () => {
    const east = plan.warehouses.filter((w) => w.x > 0);
    const west = plan.warehouses.filter((w) => w.x < 0);
    expect(east.length).toBeGreaterThanOrEqual(7);
    expect(west.length).toBe(east.length);
    const zs = east.map((w) => w.z).sort((a, b) => b - a);
    for (let k = 1; k < zs.length; k++) expect(Math.abs(zs[k] - zs[k - 1])).toBeCloseTo(70, 0);
    for (const w of plan.warehouses) {
      const r: Rect = { cx: w.x, cz: w.z, hw: SIZES.factory.hw, hd: SIZES.factory.hd, yaw: w.yaw };
      expect(clearanceM(path, halfAt, r)).toBeGreaterThanOrEqual(10);
    }
    // The door face (local +Z) looks at the road: east sheds look west, west sheds look east.
    for (const w of east) expect(Math.sin(w.yaw)).toBeLessThan(-0.99);
    for (const w of west) expect(Math.sin(w.yaw)).toBeGreaterThan(0.99);
  });

  it('puts a lamp every 40 m along the left edge of the truck road', () => {
    expect(plan.lamps.length).toBeGreaterThanOrEqual(14);
    for (const l of plan.lamps) {
      expect(l.x).toBeLessThan(-7);
      expect(l.x).toBeGreaterThan(-12);
      expect(-l.z).toBeLessThan(640);
    }
    const zs = plan.lamps.map((l) => -l.z);
    for (let k = 1; k < zs.length; k++) expect(zs[k] - zs[k - 1]).toBeGreaterThan(35);
  });

  it('keeps flood masts off roads, cranes, blocks and the shortcut', () => {
    expect(plan.masts.length).toBeGreaterThan(8);
    for (const m of plan.masts) {
      const r: Rect = { cx: m.x, cz: m.z, hw: SIZES.mast.hw, hd: SIZES.mast.hw, yaw: 0 };
      expect(clearanceM(path, halfAt, r)).toBeGreaterThanOrEqual(1.5);
      for (const cz of spec.stsZ) {
        expect(m.x > 390 && Math.abs(m.z - cz) < SIZES.sts.hd + SIZES.mast.hw).toBe(false);
      }
      for (const b of plan.blocks) expect(rectsOverlap(r, blockRect(b))).toBe(false);
      expect(Math.abs(m.z - spec.shortcut.points[0][1]) > 6.5 + SIZES.mast.hw || m.x < 245).toBe(true);
    }
    expect(plan.masts.some((m) => m.x > 420)).toBe(true);
  });

  it('puts the skyline bridge at the data position, turned 35°', () => {
    expect(plan.skyline).toEqual({ x: -500, z: 700, yaw: (35 * Math.PI) / 180 });
  });
});

describe('gate', () => {
  const g = plan.gate;

  it('is square to the eastbound road, sign (local −z) facing the arriving traffic', () => {
    expect(g.yaw).toBeCloseTo(Math.PI / 2, 6); // local +z → world +x
  });

  it('is slid so a lane centre (not a divider) sits on the racing line', () => {
    // As shipped (160, -660) the racing line crosses at local x ≈ 5.9: right on the divider at x = 6.
    expect(g.lineLocalX).toBeGreaterThan(5);
    expect(g.lineLocalX).toBeLessThan(7);
    expect(g.lane).toBe(3); // centre x = +3
    expect(Math.abs(g.shiftM)).toBeLessThan(3.1);
    expect(g.x).toBeCloseTo(160, 6);
    expect(g.z).toBeCloseTo(-660 - g.shiftM, 6);
  });

  it('leaves the opening free: every booth/island stays ≥ 2 m from the racing line (a 3.5 m APC fits)', () => {
    expect(g.boxes).toHaveLength(GATE_MODEL.dividers.length * 2);
    let nearest = Infinity;
    for (const b of g.boxes) nearest = Math.min(nearest, lineDistanceM(path, b));
    expect(nearest).toBeGreaterThanOrEqual(2);
    // …and it really is the nearest thing, i.e. the line threads the gate rather than missing it.
    expect(nearest).toBeLessThan(3);
  });

  it('keeps the gate off the walls of the road only where the model says (dividers beyond the road edge are outside)', () => {
    const outside = g.boxes.filter((b) => clearanceM(path, halfAt, b) > 0);
    expect(outside.length).toBeGreaterThan(0);
  });
});

// ---- scene ------------------------------------------------------------------------------------

/** Stub models with the real GLBs' sub-mesh (material) names; glowing parts are emissive, the sign is textured. */
const PARTS: Record<string, string[]> = {
  'container_block_a.glb': ['Box_0', 'Box_1', 'Box_2', 'Box_3', 'Box_4', 'Box_5', 'Box_6', 'Box_7', 'Box_8', 'Box_Rib'],
  'container_block_b.glb': ['Box_0', 'Box_1', 'Box_2', 'Box_3', 'Box_4', 'Box_5', 'Box_6', 'Box_7', 'Box_8', 'Box_Rib'],
  'container_block_c.glb': ['Box_0', 'Box_1', 'Box_2', 'Box_3', 'Box_4', 'Box_5', 'Box_6', 'Box_7', 'Box_8', 'Box_Rib'],
  'port_gate.glb': [
    'Gate_Steel',
    'Booth',
    'Glass',
    'Gate_Canopy',
    'Barrier_Arm',
    'Lane_Green',
    'LED_Flood',
    'Gate_Sign',
  ],
  'flood_mast.glb': ['Mast', 'LED_Flood', 'Aviation_Red'],
  'cable_stayed_bridge.glb': ['Bridge_Concrete', 'Deck_Lamps', 'Stay_Cable', 'Pylon_Light'],
  'container_truck_blue.glb': [
    'Truck_Cab',
    'Glass',
    'Light_Head',
    'Light_Tail',
    'Trim',
    'Container_Paint',
    'Container_Rib',
    'Tire',
  ],
  'container_truck_red.glb': [
    'Truck_Cab',
    'Glass',
    'Light_Head',
    'Light_Tail',
    'Trim',
    'Container_Paint',
    'Container_Rib',
    'Tire',
  ],
  'factory_shed.glb': ['Factory_Wall', 'Factory_Roof', 'Factory_Glass', 'Factory_Door'],
  'highway_lamp.glb': ['Pole', 'Lamp_Sodium'],
};
const GLOW = new Set([
  'Light_Head',
  'Light_Tail',
  'Lane_Green',
  'LED_Flood',
  'Aviation_Red',
  'Lamp_Sodium',
  'Deck_Lamps',
  'Pylon_Light',
]);

const stubAssets = {
  cloneModel(p: string): THREE.Group {
    const g = new THREE.Group();
    const inner = new THREE.Group();
    g.add(inner);
    for (const name of PARTS[p.split('/').pop() as string]) {
      const mat = new THREE.MeshStandardMaterial({ color: '#888888', metalness: name === 'Mast' ? 0.9 : 0.1 });
      mat.name = name;
      if (GLOW.has(name)) {
        mat.emissive.set('#ffffff');
        mat.emissiveIntensity = 2;
      }
      if (name === 'Gate_Sign') mat.map = new THREE.Texture();
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      m.name = name;
      inner.add(m);
    }
    return g;
  },
} as unknown as Assets;

const build = (): { world: RAPIER.World; scene: THREE.Scene; yard: CatLaiYard } => {
  const world = new RAPIER.World({ x: 0, y: -15, z: 0 });
  const scene = new THREE.Scene();
  return { world, scene, yard: new CatLaiYard(scene, RAPIER, world, stubAssets, CAT_LAI, path) };
};

/** Visible meshes with the cull groups updated for a camera at (x, z); the skyline sits outside the culling. */
function drawCallsAt(yard: CatLaiYard, x: number, z: number): number {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(x, 3, z);
  yard.group.traverse((o) => {
    if (o instanceof DistanceCull) o.update(cam);
  });
  let n = 0;
  yard.group.traverse((o) => {
    if (o instanceof THREE.Mesh && o.visible && o.parent?.visible !== false) n++;
  });
  return n;
}

describe('CatLaiYard scene', () => {
  it('builds colliders for every solid thing and cleans up', () => {
    const { world, scene, yard } = build();
    const p = yard.plan;
    const expected = p.blocks.length + p.trucks.length + p.warehouses.length + p.masts.length + p.gate.boxes.length;
    expect(world.colliders.len()).toBe(expected);
    expect(world.bodies.len()).toBe(1);
    expect(scene.children).toContain(yard.group);
    yard.dispose();
    expect(world.bodies.len()).toBe(0);
    expect(scene.children).not.toContain(yard.group);
  });

  it('puts the colliders where the plan says (a block, a truck, a gate booth)', () => {
    const { world, yard } = build();
    world.step();
    const b = yard.plan.blocks[0];
    const ray = new RAPIER.Ray({ x: b.x, y: 30, z: b.z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 100, true);
    expect(hit).not.toBeNull();
    expect(30 - (hit?.timeOfImpact ?? 0)).toBeCloseTo(SIZES.block.h, 3);
    // The racing line through the gate opening is not blocked: a horizontal ray along the line at 1 m height.
    const g = yard.plan.gate;
    const lane = rotateLocal(GATE_MODEL.laneCentres[g.lane], 0, g.yaw);
    const o = { x: g.x - 12, y: 1.5, z: g.z + lane.z };
    const clear = world.castRay(new RAPIER.Ray(o, { x: 1, y: 0, z: 0 }), 24, true);
    expect(clear).toBeNull();
    yard.dispose();
  });

  it('stays within the draw-call budget (≤ 40 with the skyline) from every point of the lap', () => {
    const { yard } = build();
    let worst = 0;
    let at = 0;
    for (let i = 0; i < path.count; i += 5) {
      const n = drawCallsAt(yard, path.px[i], path.pz[i]);
      if (n > worst) {
        worst = n;
        at = i;
      }
    }
    expect(worst, `worst at sample ${at}`).toBeLessThanOrEqual(40);
    yard.dispose();
  });

  it('draws nothing but the skyline when the camera is far away', () => {
    const { yard } = build();
    expect(drawCallsAt(yard, 5000, 5000)).toBe(4);
    yard.dispose();
  });
});
