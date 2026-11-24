import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import baked from '../data/colliders/cat_lai.json';
import raw from '../data/tracks/cat_lai.json';
import osm from '../data/tracks/cat_lai_osm.json';
import placements from '../data/tracks/cat_lai_placements.json';
import { CAT_LAI, RACE, TRACKS, getTrack, interpolateByT, roadWidthAt, sunDirection } from '../src/core/Data';
import { CAT_LAI_MODELS, CAT_LAI_SHARED_MODELS, CAT_LAI_TEXTURES } from '../src/world/CatLai';
import {
  BAY_GAP_M,
  COLLIDER_REACH_M,
  CRANE_LEG_CLEAR_M,
  GATE_ISLANDS,
  GATE_OPEN_ISLANDS,
  GATE_SHIFT_M,
  GROUND_Y,
  PROP_CLEAR_M,
  ROW_PITCH_M,
  RoadGrid,
  STS_LEGS,
  TIER_M,
  clearBillboardLots,
  containerTint,
  dropOnRoad,
  ferryPose,
  footprintOf,
  inPolygon,
  itemBoxes,
  lapCentres,
  osmRoadStrips,
  osmRoadsNear,
  planBillboards,
  planColliders,
  planFrontage,
  planMappedBuildings,
  planPlacements,
  planTrees,
  planYard,
  portPolygon,
  quayFrame,
  rectPoints,
  roadClearance,
  shiftGate,
  toWorld,
  type CatLaiPlacementData,
  type CatLaiQuay,
  type OsmData,
  type PlacedItem,
  type YardBlock,
} from '../src/world/catLaiLayout';
import { SPONSOR_MODELS } from '../src/world/Sponsors';
import { RoadIndex, frameAt, yawForZ } from '../src/world/monteCarloLayout';
import { relaxTightBends } from '../src/world/relaxBends';
import { TrackPath } from '../src/world/TrackPath';

const data = placements as unknown as CatLaiPlacementData;
const osmData = osm as unknown as OsmData;
const quay = raw.quay as unknown as CatLaiQuay;

/** The path the game drives: the JSON spline through `relaxTightBends`, as Game.ts and RaceSim.ts build it. */
const path = new TrackPath(
  relaxTightBends(CAT_LAI.spline.points, RACE.track.minTurnRadiusM),
  RACE.track.sampleSpacingM,
  RACE.track.projectWindowSamples,
);
const index = new RoadIndex(path, 2);
const clearance = roadClearance(index, CAT_LAI);
const tOf = (x: number, z: number): number => path.project(x, z);
const startZone: [number, number][] = [
  [1 - 50 / path.lengthM, 1],
  [0, 8 / path.lengthM],
];

/** A straight road along +X, 20 m wide: clearance is |z| - 10. */
const straight = (_x: number, z: number): number => Math.abs(z) - 10;
const item = (key: string, x: number, z: number, rotY = 0, group = 'street'): PlacedItem => ({
  group,
  key,
  model: `models/props_catlai2/${key}.glb`,
  x,
  y: GROUND_Y,
  z,
  rotY,
  scale: 1,
});

describe('Cat Lai v2 track data', () => {
  it('is Map 1: a 3-lap, 3.6 km daylight lap with 9 checkpoints, first in the menu', () => {
    expect(CAT_LAI.id).toBe('cat_lai');
    expect(TRACKS[0]).toBe(CAT_LAI);
    expect(getTrack('cat_lai')).toBe(CAT_LAI);
    expect(CAT_LAI.laps).toBe(3);
    expect(CAT_LAI.timeOfDay).toBe('day');
    expect(CAT_LAI.checkpoints).toHaveLength(9);
    expect(path.lengthM).toBeGreaterThan(3500);
    expect(path.lengthM).toBeLessThan(3700);
    expect(Math.abs(CAT_LAI.lapLengthM - path.lengthM)).toBeLessThan(5);
  });

  it('runs counter-clockwise (every turn a left) on flat ground 2 m above the river', () => {
    // Shoelace in (x, north): positive = counter-clockwise seen from above.
    let area = 0;
    const p = CAT_LAI.spline.points;
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      area += a[0] * -b[2] - b[0] * -a[2];
    }
    expect(area).toBeGreaterThan(0);
    expect(new Set(p.map((q) => q[1]))).toEqual(new Set([2]));
    expect(CAT_LAI.hasElevation).toBe(true); // the road ribbon is the driving surface; the ground plane is at 0
    expect(CAT_LAI.groundY).toBe(0);
  });

  it('has no weather, and a daylight block in the shape the lighting expects', () => {
    expect(CAT_LAI.weather).toBeNull();
    const d = CAT_LAI.daylight;
    expect(d).not.toBeNull();
    expect(d?.skyGradient).toEqual({ zenith: '#295CAD', mid: '#6B9ED6', horizon: '#CCDBE0' });
    expect(d?.fog.density).toBeCloseTo(0.00032, 8);
    expect(d?.toneMappingExposure).toBeCloseTo(0.58, 5);
    expect(d?.sun.dir).toEqual(sunDirection(150, 58));
    // The sun is 58 degrees up: the light travels downwards.
    expect(d?.sun.dir[1]).toBeLessThan(-0.8);
    expect(Math.hypot(...(d?.sun.dir ?? [0, 0, 0]))).toBeCloseTo(1, 3);
  });

  it('keeps the road width from roadWidthM.byT: NTD 20, gate 18, quay 22, yard 15, north 16', () => {
    expect(CAT_LAI.roadWidthM).toBe(20);
    expect(CAT_LAI.widthByT).not.toBeNull();
    expect(roadWidthAt(CAT_LAI, 0.05)).toBeCloseTo(20, 5);
    expect(roadWidthAt(CAT_LAI, 0.133)).toBeCloseTo(18, 5);
    expect(roadWidthAt(CAT_LAI, 0.3)).toBeCloseTo(22, 5);
    expect(roadWidthAt(CAT_LAI, 0.55)).toBeCloseTo(15, 5);
    expect(roadWidthAt(CAT_LAI, 0.75)).toBeCloseTo(16, 5);
    // In between it is interpolated, and the lap wraps (the table's last row meets its first).
    expect(roadWidthAt(CAT_LAI, 0.19)).toBeGreaterThan(20);
    expect(roadWidthAt(CAT_LAI, 0.19)).toBeLessThan(22);
    expect(roadWidthAt(CAT_LAI, 0.999)).toBeGreaterThan(19);
    expect(roadWidthAt(CAT_LAI, 1.05)).toBeCloseTo(roadWidthAt(CAT_LAI, 0.05), 5);
  });

  it('draws the port as concrete tiled in world space and only the public road with a sidewalk', () => {
    expect(CAT_LAI.roadTexture).toBe('textures/catlai2_road.png');
    expect(CAT_LAI.roadTextureRepeatM).toBe(32);
    expect(CAT_LAI.widthProfile).toHaveLength(1);
    const port = CAT_LAI.widthProfile[0];
    expect(port.texture).toBe('textures/catlai2_concrete.png');
    expect(port.worldTileM).toBe(32);
    expect(port.fromT).toBeCloseTo(0.1155, 4); // Gate B
    expect(port.toT).toBeCloseTo(0.929, 3); // the end of the north road
    expect(port.widthM).toBe(15);
    expect(CAT_LAI.sidewalkT).toEqual([
      [0, 0.1155],
      [0.929, 1],
    ]);
    expect(TRACKS.filter((t) => t !== CAT_LAI).every((t) => t.sidewalkT === null && t.widthByT === null)).toBe(true);
  });

  it('lines up the 6-car grid and the pickups on the road, with the left pickup lane clear of the truck queue', () => {
    expect(CAT_LAI.startLine.grid).toHaveLength(6);
    expect(CAT_LAI.laneOffsetsM).toEqual([-5, 0, 4]);
    expect(CAT_LAI.blockedLane).toBe('left');
    for (const g of CAT_LAI.startLine.grid) expect(Math.abs(g[0])).toBeLessThan(roadWidthAt(CAT_LAI, 0) / 2);
    expect(CAT_LAI.pickups).toHaveLength(7);
    expect(TRACKS.filter((t) => t.id !== 'cat_lai').map((t) => t.blockedLane)).toContain('right');
  });

  it('is not a night map any more: no shortcut, reefer lane or port gate fields remain', () => {
    const json = JSON.stringify(raw);
    expect(json).not.toMatch(/"shortcut"|"reefer_lane"|"truckQueue"|"portGate"/);
    expect(raw.version).toBe(2);
    expect(raw.placements.items).toBe(954);
  });
});

describe('interpolateByT / sunDirection', () => {
  it('interpolates a wrapping table', () => {
    const t = [
      [0.2, 10],
      [0.6, 20],
    ] as const;
    expect(interpolateByT(t, 0.4)).toBeCloseTo(15, 6);
    expect(interpolateByT(t, 0.2)).toBeCloseTo(10, 6);
    // Past the last row it blends back to the first (0.6 -> 1.2 is 0.6 long).
    expect(interpolateByT(t, 0.9)).toBeCloseTo(15, 6);
    expect(interpolateByT(t, 0.1)).toBeCloseTo(20 - (10 * 0.5) / 0.6, 6);
    expect(interpolateByT(t, 1.4)).toBeCloseTo(15, 6);
  });
  it('turns azimuth / elevation into the direction the light travels', () => {
    const [x, y, z] = sunDirection(150, 58);
    expect(y).toBeCloseTo(-Math.cos(((90 - 58) * Math.PI) / 180), 3);
    expect(x).toBeCloseTo(-Math.sin((32 * Math.PI) / 180) * Math.sin((150 * Math.PI) / 180), 3);
    expect(z).toBeCloseTo(-Math.sin((32 * Math.PI) / 180) * Math.cos((150 * Math.PI) / 180), 3);
    expect(sunDirection(0, 90)[1]).toBeCloseTo(-1, 5);
  });
});

describe('Cat Lai assets', () => {
  it('every model and texture the map loads exists on disk', () => {
    for (const m of [...CAT_LAI_MODELS, ...CAT_LAI_SHARED_MODELS])
      expect(existsSync(`public/assets/${m}`), m).toBe(true);
    for (const t of CAT_LAI_TEXTURES) expect(existsSync(`public/assets/${t}`), t).toBe(true);
    expect(CAT_LAI_MODELS).toContain('models/props_catlai2/container_40ft.glb');
    expect(CAT_LAI_MODELS).toContain('models/props_catlai2/car_ferry.glb');
    expect(new Set(CAT_LAI_MODELS).size).toBe(CAT_LAI_MODELS.length);
    expect(existsSync(`public/assets/${CAT_LAI.roadTexture}`)).toBe(true);
  });

  it('keeps none of the night map: no props_catlai (v1) model is loaded', () => {
    expect([...CAT_LAI_MODELS, ...CAT_LAI_SHARED_MODELS].some((m) => /props_catlai\//.test(m))).toBe(false);
  });
});

describe('placements', () => {
  const all = planPlacements(data);

  it('resolves all 954 designed objects of the 8 groups to a GLB at the land level (ships at the river)', () => {
    expect(all).toHaveLength(954);
    expect(new Set(all.map((i) => i.group))).toEqual(
      new Set(['quay', 'river', 'landing', 'yard', 'buildings', 'street', 'traffic', 'barriers']),
    );
    for (const it of all) {
      expect(it.model).toMatch(/^models\/props_(catlai2|conghoa)\/.+\.glb$/);
      expect(Number.isFinite(it.x + it.z + it.rotY)).toBe(true);
    }
    expect(all.filter((i) => i.group === 'river').every((i) => i.y === 0)).toBe(true);
    expect(all.filter((i) => i.group !== 'river').every((i) => i.y === GROUND_Y)).toBe(true);
    expect(all.filter((i) => /^sts/.test(i.key))).toHaveLength(20);
  });

  it('drops the props that landed on the carriageway: a few cranes, scooters, trucks, a tractor', () => {
    const shifted = shiftGate(all);
    const kept = dropOnRoad(shifted, clearance, { keepClearT: startZone, tOf });
    expect(kept.length).toBeLessThan(all.length);
    expect(all.length - kept.length).toBeLessThan(25);
    const lost = shifted.filter((a) => !kept.includes(a));
    // Everything lost is a crane at a bend of the quay lane, a tractor, or a queue vehicle at the start grid.
    for (const l of lost) expect(/^(sts|tt_|truck_|moto_)/.test(l.key), l.key).toBe(true);
    expect(kept.filter((i) => /^sts/.test(i.key)).length).toBeGreaterThanOrEqual(16);
  });

  it('keeps every kept obstacle off the carriageway, and crane legs no further in than the wall', () => {
    const kept = dropOnRoad(shiftGate(all), clearance, { keepClearT: startZone, tOf });
    for (const it of kept) {
      if (/^(sts)/.test(it.key)) {
        for (const leg of STS_LEGS) {
          for (const [x, z] of rectPoints(it, leg))
            expect(clearance(x, z), `${it.key} leg`).toBeGreaterThanOrEqual(CRANE_LEG_CLEAR_M);
        }
        continue;
      }
      if (['river', 'landing', 'traffic'].includes(it.group) || /^(gate|quay|street|workers)$/.test(it.key)) continue;
      for (const rect of footprintOf(it.key)) {
        for (const [x, z] of rectPoints(it, rect)) {
          expect(
            clearance(x, z),
            `${it.group}:${it.key} at ${it.x.toFixed(0)},${it.z.toFixed(0)}`,
          ).toBeGreaterThanOrEqual(PROP_CLEAR_M - 1e-9);
        }
      }
    }
  });

  it('keeps the parked queue and scooters off the start grid, in the left (oncoming) lane', () => {
    const kept = dropOnRoad(all, clearance, { keepClearT: startZone, tOf });
    for (const it of kept.filter((i) => i.group === 'traffic')) {
      const t = tOf(it.x, it.z);
      expect(t > 1 - 50 / path.lengthM || t < 8 / path.lengthM).toBe(false);
    }
    // The queue trucks stand 5-9 m left of the centre line (a car on the line is not touching them).
    const lats = kept
      .filter((i) => /^truck_/.test(i.key))
      .map((i) => {
        const t = tOf(i.x, i.z);
        const f = frameAt(path, t);
        return (i.x - f.x) * f.lx + (i.z - f.z) * f.lz;
      });
    expect(lats.length).toBeGreaterThan(10);
    for (const l of lats) {
      expect(l).toBeGreaterThan(5);
      expect(l).toBeLessThan(9.5);
    }
  });

  it('is robust to a different carriageway: a synthetic road drops exactly what stands on it', () => {
    const onRoad = [item('house_0', 0, 2), item('pole', 30, 5), item('rtg', 60, 0)];
    const clear = [item('house_0', 0, 20, Math.PI), item('pole', 30, 12), item('truck_0', 90, 0, 0, 'traffic')];
    const kept = dropOnRoad([...onRoad, ...clear], straight);
    expect(kept.map((i) => `${i.key}@${i.x}`)).toEqual(clear.map((i) => `${i.key}@${i.x}`));
    // A 21 m deep house reaches back from its facade: facing away from the road it would stand on it.
    expect(dropOnRoad([item('house_0', 0, 14, 0)], straight)).toHaveLength(0);
    expect(dropOnRoad([item('house_0', 0, 14, Math.PI)], straight)).toHaveLength(1);
    // River items are never filtered; traffic stays unless it is in the keep-clear stretch.
    expect(dropOnRoad([item('ship_a', 0, 0, 0, 'river')], straight)).toHaveLength(1);
    const t = (x: number): number => x / 100;
    expect(
      dropOnRoad([item('truck_0', 20, 0, 0, 'traffic')], straight, { keepClearT: [[0, 0.5]], tOf: (x) => t(x) }),
    ).toHaveLength(0);
  });

  it('shifts Gate B so a lane, not a booth island, is on the centre line', () => {
    const gate = all.find((i) => i.key === 'gate') as PlacedItem;
    const moved = shiftGate(all).find((i) => i.key === 'gate') as PlacedItem;
    expect(Math.hypot(moved.x - gate.x, moved.z - gate.z)).toBeCloseTo(Math.abs(GATE_SHIFT_M), 5);
    const f = frameAt(path, tOf(gate.x, gate.z));
    // The gate's yaw is the road's (to a few hundredths of a radian).
    expect(
      Math.abs(Math.atan2(Math.sin(gate.rotY - yawForZ(f.tx, f.tz)), Math.cos(gate.rotY - yawForZ(f.tx, f.tz)))),
    ).toBeLessThan(0.05);
    // In the gate's frame the centre line is the lane between the islands at x = 1 .. 3.5 (centre 2.25).
    const [x, z] = toWorld(moved.x, moved.z, moved.rotY, 2.25, 0);
    expect(clearance(x, z)).toBeLessThan(-8.5);
    const boxes = itemBoxes(moved);
    expect(boxes).toHaveLength(GATE_ISLANDS.length - GATE_OPEN_ISLANDS.length);
    for (const b of boxes) {
      // No island's solid core reaches within a car's half width (1.1 m) of the centre line.
      const d = Math.hypot(b.x - x, b.z - z);
      expect(d).toBeGreaterThan(b.hx + 1.1);
    }
  });
});

describe('container yard', () => {
  const plan = planYard(data.yardBlocks, clearance);

  it('builds ~35,000 containers in stacks of 1-5 tiers, none on the road', () => {
    expect(data.yardBlocks).toHaveLength(263);
    const declared = data.yardBlocks.reduce((n, b) => n + [...b.h].reduce((m, d) => m + Number(d), 0), 0);
    expect(declared).toBeGreaterThan(34_000);
    expect(plan.kept + plan.dropped).toBe(declared);
    expect(plan.kept).toBeGreaterThan(34_000);
    expect(plan.dropped).toBeLessThan(declared * 0.02);
    for (const s of plan.stacks) {
      expect(s.h).toBeGreaterThanOrEqual(1);
      expect(s.h).toBeLessThanOrEqual(5);
    }
    for (const s of plan.stacks.filter((_, i) => i % 40 === 0))
      expect(clearance(s.x, s.z)).toBeGreaterThan(PROP_CLEAR_M);
  });

  it('lays rows 2.6 m apart and bays at length + 0.4 m, tiers 2.6 m high', () => {
    const block: YardBlock = { x: 100, z: 50, rotY: 0, bays: 2, rows: 3, len: 12.19, h: '123456'.replace('6', '0') };
    const far = planYard([block], () => 1e6);
    // Rows run across (local X), bays along (local Z); the empty slot (digit 0) is skipped.
    expect(far.stacks).toHaveLength(5);
    const xs = [...new Set(far.stacks.map((s) => s.x))].sort((a, b) => a - b);
    expect(xs.map((x) => +(x - 100).toFixed(2))).toEqual([-ROW_PITCH_M, 0, ROW_PITCH_M]);
    const zs = [...new Set(far.stacks.map((s) => s.z))].sort((a, b) => a - b);
    expect(zs[1] - zs[0]).toBeCloseTo(12.19 + BAY_GAP_M, 6);
    expect(TIER_M).toBe(2.6);
    // Rotated by 90 degrees the rows and bays swap axes.
    const turned = planYard([{ ...block, rotY: Math.PI / 2 }], () => 1e6);
    expect(new Set(turned.stacks.map((s) => +s.z.toFixed(2))).size).toBe(3);
    // A stack touching the road is dropped.
    const onRoad = planYard([{ ...block, z: 8 }], straight);
    expect(onRoad.stacks.length).toBeLessThan(5);
    expect(onRoad.dropped).toBeGreaterThan(0);
  });

  it('tints each container from the 18 colours at 0.85-1.1 brightness, deterministically', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const t = containerTint(i, data.containerColours.length);
      expect(t.index).toBeGreaterThanOrEqual(0);
      expect(t.index).toBeLessThan(18);
      expect(t.mul).toBeGreaterThanOrEqual(0.85);
      expect(t.mul).toBeLessThanOrEqual(1.1);
      seen.add(t.index);
    }
    expect(seen.size).toBe(18);
    expect(containerTint(7, 18)).toEqual(containerTint(7, 18));
  });
});

describe('colliders', () => {
  const kept = dropOnRoad(shiftGate(planPlacements(data)), clearance, { keepClearT: startZone, tOf });
  const plan = planYard(data.yardBlocks, clearance);
  const boxes = planColliders(kept, plan.stacks, data.yardBlocks, clearance);

  it('stay a sane few hundred, with one cuboid per container block that comes near the road', () => {
    expect(boxes.length).toBeGreaterThan(150);
    expect(boxes.length).toBeLessThan(700);
    for (const b of boxes) {
      expect(Number.isFinite(b.x + b.y + b.z + b.hx + b.hy + b.hz)).toBe(true);
      expect(b.hx).toBeGreaterThan(0);
      expect(b.hy).toBeGreaterThan(0);
      expect(b.hz).toBeGreaterThan(0);
      expect(clearance(b.x, b.z)).toBeLessThan(COLLIDER_REACH_M + Math.hypot(b.hx, b.hz));
    }
    // Container blocks are merged: ~10,000 stacks never become 10,000 bodies.
    expect(boxes.filter((b) => b.hy > 2.5 && b.hz > 6).length).toBeLessThan(plan.stacks.length / 20);
  });

  it('never put a solid thing on the centre lane of the road', () => {
    let hits = 0;
    for (let i = 0; i < path.count; i += 2) {
      for (const lat of [-1.2, 0, 1.2]) {
        const x = path.px[i] + path.tz[i] * lat;
        const z = path.pz[i] - path.tx[i] * lat;
        for (const b of boxes) {
          const dx = x - b.x;
          const dz = z - b.z;
          const lx = dx * Math.cos(b.rotY) - dz * Math.sin(b.rotY);
          const lz = dx * Math.sin(b.rotY) + dz * Math.cos(b.rotY);
          if (Math.abs(lx) < b.hx && Math.abs(lz) < b.hz) hits++;
        }
      }
    }
    expect(hits).toBe(0);
  });

  it('give cranes legs, not a solid portal, so the car drives between them', () => {
    const crane = item('sts', 0, 0, 0, 'quay');
    const legs = itemBoxes(crane);
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => Math.abs(l.x) > 13.5 && l.hy < 5)).toBe(true);
    expect(itemBoxes(item('house_3', 0, 0))).toHaveLength(1);
    expect(itemBoxes(item('moto_0', 0, 0, 0, 'traffic'))).toHaveLength(0); // scooters are soft ghosts
  });

  it('are baked into data/colliders/cat_lai.json (under 3 MB, cuboids only)', () => {
    expect(statSync('data/colliders/cat_lai.json').size).toBeLessThan(3_000_000);
    const scenery = (baked as { static: { src: string; shape: string }[] }).static.filter((c) => c.src === 'scenery');
    expect(scenery.length).toBeGreaterThan(150);
    expect(scenery.every((c) => c.shape === 'cuboid')).toBe(true);
  });
});

describe('OpenStreetMap surroundings', () => {
  it('carries © OpenStreetMap contributors and only points for buildings', () => {
    expect((osm as { attribution: string }).attribution).toMatch(/OpenStreetMap contributors/);
    expect(osmData.buildings.every((b) => b.p.length === 1)).toBe(true);
  });

  it('flips (x, north) to world (x, z = -north) and keeps the roads near the lap', () => {
    const centres = lapCentres(path, 150);
    expect(centres.length).toBeGreaterThan(20);
    const roads = osmRoadsNear(osmData, centres, 520);
    expect(roads.length).toBeGreaterThan(100);
    expect(roads.length).toBeLessThan(osmData.roads.length);
    const r0 = osmData.roads.find((r) =>
      r.p.some(([x, n]) => Math.hypot(x - 100, -n - 150) < 520),
    ) as OsmData['roads'][0];
    expect(roads.some((r) => r.pts.some(([, z]) => z === -r0.p[0][1]))).toBe(true);
  });

  it('draws asphalt strips only where the lap and the port slab are not', () => {
    const road = {
      pts: [
        [0, 40],
        [60, 40],
        [120, 40],
      ] as [number, number][],
      w: 8,
      type: 'residential',
    };
    const all = osmRoadStrips(
      [road],
      () => 100,
      () => false,
      2.03,
    );
    expect(all.indices.length / 6).toBe(20); // 10 pieces of ~6 m per 60 m segment, two segments
    expect(all.positions.length / 3).toBe(80);
    expect(all.uvs.length / 2).toBe(80);
    const noPort = osmRoadStrips(
      [road],
      () => 100,
      (x) => x < 60,
      2.03,
    );
    expect(noPort.indices.length / 6).toBe(10);
    // A road running along the lap's own carriageway adds nothing (it would z-fight with it).
    const onLap = osmRoadStrips(
      [
        {
          ...road,
          pts: [
            [0, 2],
            [100, 2],
          ],
        },
      ],
      straight,
      () => false,
      2.03,
    );
    expect(onLap.indices.length).toBe(0);
    expect(all.positions.every((v, i) => i % 3 !== 1 || v === 2.03)).toBe(true);
  });

  it('lines residential roads with tube houses facing them, and skips sites that back onto another road', () => {
    const grid = new RoadGrid(25);
    const road = {
      pts: [
        [0, 0],
        [200, 0],
      ] as [number, number][],
      w: 8,
      type: 'residential',
    };
    grid.addPolyline(road.pts, road.w);
    const rules = { inPort: () => false, onLand: () => true, keep: () => true, variants: 8, seed: 1 };
    const rows = planFrontage([road], grid, rules);
    // Both sides, every ~5 m, with ~12 % gaps: about 70 houses.
    expect(rows.length).toBeGreaterThan(55);
    expect(rows.length).toBeLessThan(80);
    for (const h of rows) {
      expect(Math.abs(h.z)).toBeCloseTo(8.5, 5); // half width + 4.5
      // The facade (local +Z) points back at the road.
      const toRoad = Math.sign(-h.z);
      expect(Math.sign(Math.cos(h.rotY))).toBe(toRoad || 1);
      expect(Math.abs(Math.sin(h.rotY))).toBeLessThan(1e-9);
      expect(h.variant).toBeGreaterThanOrEqual(0);
      expect(h.variant).toBeLessThan(8);
    }
    // Another road 14 m behind the north side's houses removes that side's row.
    const back = {
      pts: [
        [0, 16],
        [200, 16],
      ] as [number, number][],
      w: 6,
      type: 'service',
    };
    const g2 = new RoadGrid(25);
    g2.addPolyline(road.pts, road.w);
    g2.addPolyline(back.pts, back.w);
    const ladder = planFrontage([road], g2, rules);
    expect(ladder.length).toBeLessThan(rows.length);
    expect(planFrontage([road], grid, { ...rules, inPort: () => true })).toHaveLength(0);
    expect(planFrontage([{ ...road, type: 'service' }], grid, rules)).toHaveLength(0);
  });

  it('turns the OSM building points into boxes by type, kept off roads', () => {
    const grid = new RoadGrid(25);
    const road = {
      pts: [
        [0, 0],
        [100, 0],
      ] as [number, number][],
      w: 6,
      type: 'residential',
    };
    grid.addPolyline(road.pts, road.w);
    const osmSmall = {
      roads: [],
      buildings: [
        { p: [[50, -40]], h: null, type: 'apartments' },
        { p: [[50, -1]], h: null, type: 'house' }, // (50, +1): on the road
        { p: [[50, -80]], h: 30, type: 'house' },
      ],
    } as unknown as OsmData;
    const out = planMappedBuildings(
      osmSmall,
      grid,
      [road],
      () => false,
      () => true,
      3,
    );
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('apartments');
    expect(out[0].h).toBeGreaterThan(18);
    expect(out[1].h).toBe(30);
    // Turned along the road (x axis): local +Z along world +X -> yaw pi / 2.
    expect(Math.abs(Math.sin(out[0].rotY))).toBeCloseTo(1, 5);
    expect(
      planMappedBuildings(
        osmSmall,
        grid,
        [road],
        () => true,
        () => true,
        3,
      ),
    ).toHaveLength(0);
  });

  it('scatters trees on open land away from roads, on a jittered grid', () => {
    const grid = new RoadGrid(25);
    grid.addPolyline(
      [
        [0, 0],
        [400, 0],
      ],
      8,
    );
    const sites = planTrees({ x0: 0, x1: 400, z0: -100, z1: 100 }, 20, grid, () => true, 5);
    expect(sites.length).toBeGreaterThan(50);
    for (const s of sites) {
      expect(Math.abs(s.z)).toBeGreaterThan(10);
      expect(s.scale).toBeGreaterThanOrEqual(0.7);
      expect(s.scale).toBeLessThanOrEqual(1.4);
    }
    expect(new Set(sites.map((s) => s.variant))).toEqual(new Set([0, 1]));
    expect(planTrees({ x0: 0, x1: 400, z0: -100, z1: 100 }, 20, grid, () => false, 5)).toHaveLength(0);
  });
});

describe('land, quay and ferry geometry', () => {
  it('lays the quay frame NE along the berths, inland to the NW, from the JSON edge point', () => {
    const f = quayFrame(quay);
    expect(f.at(0, 0)).toEqual([380, 256]);
    // 1,140 m NE of the edge start: x grows, z (= -north) shrinks.
    const [x, z] = f.at(1140, 0);
    expect(x).toBeGreaterThan(1300);
    expect(z).toBeLessThan(-200);
    // Inland is away from the river: the road (18.5 m inland) is on the land side of the shoreline.
    const [rx, rz] = f.at(300, 18.5);
    const river = (raw.river as { shoreline: number[][] }).shoreline;
    const land = [
      ...river.map((p): [number, number] => [p[0], p[2]]),
      [2100, -3200],
      [-2600, -3200],
      [-2600, river[0][2]],
    ] as [number, number][];
    expect(inPolygon(rx, rz, land)).toBe(true);
    const [wx, wz] = f.at(300, -30);
    expect(inPolygon(wx, wz, land)).toBe(false);
    expect(portPolygon(quay).length).toBe(14);
    const port = portPolygon(quay);
    expect(inPolygon(rx, rz, port)).toBe(true);
    expect(inPolygon(-400, -400, port)).toBe(false);
  });

  it('sails the ferry between its landings every 240 s, docked 5 % of the cycle at each, facing where it goes', () => {
    const a: [number, number] = [215, 245];
    const b: [number, number] = [415, 895];
    const at0 = ferryPose(a, b, 0, 240);
    expect([at0.x, at0.z]).toEqual(a);
    expect(at0.docked).toBe(false);
    const mid = ferryPose(a, b, 0.225 * 240, 240);
    expect(mid.along).toBeCloseTo(0.5, 6);
    expect(mid.x).toBeCloseTo(315, 3);
    const dockedAtB = ferryPose(a, b, 0.475 * 240, 240);
    expect(dockedAtB.docked).toBe(true);
    expect([dockedAtB.x, dockedAtB.z]).toEqual(b);
    const back = ferryPose(a, b, 0.725 * 240, 240);
    expect(back.along).toBeCloseTo(0.5, 6);
    // Outbound it faces Nhon Trach (+z), inbound it faces back.
    expect(Math.cos(mid.rotY)).toBeGreaterThan(0.9);
    expect(Math.cos(back.rotY)).toBeLessThan(-0.9);
    // Periodic, and a staggered second boat is on the other leg.
    expect(ferryPose(a, b, 17, 240).x).toBeCloseTo(ferryPose(a, b, 17 + 240, 240).x, 6);
    expect(ferryPose(a, b, 17, 240).along).not.toBeCloseTo(ferryPose(a, b, 17, 240, 0.5).along, 2);
    for (let t = 0; t < 480; t += 7) {
      const p = ferryPose(a, b, t, 240);
      expect(p.along).toBeGreaterThanOrEqual(0);
      expect(p.along).toBeLessThanOrEqual(1);
    }
  });

  it('places billboards along Nguyen Thi Dinh facing the traffic, brands alternating, houses making way', () => {
    const len = path.lengthM;
    const boards = planBillboards(
      path,
      CAT_LAI,
      [
        [70, 420],
        [len - 330, len - 60],
      ],
      62,
      9,
    );
    expect(boards.length).toBeGreaterThan(8);
    for (const b of boards) {
      expect(SPONSOR_MODELS).toContain(b.model);
      expect(existsSync(`public/assets/${b.model}`)).toBe(true);
      // The face (local -Z) looks back at the oncoming driver: local +Z is the direction of travel.
      const f = frameAt(path, tOf(b.x, b.z));
      expect(Math.sin(b.rotY) * f.tx + Math.cos(b.rotY) * f.tz).toBeGreaterThan(0.95);
      expect(clearance(b.x, b.z)).toBeGreaterThan(7);
    }
    for (let i = 1; i < boards.length; i++) expect(boards[i].model).not.toBe(boards[i - 1].model);
    const houses = shiftGate(planPlacements(data)).filter((i) => /^house_/.test(i.key));
    const cleared = clearBillboardLots(houses, boards);
    expect(cleared.length).toBeLessThan(houses.length);
    expect(houses.length - cleared.length).toBeLessThan(boards.length * 6);
    expect(clearBillboardLots([item('pole', boards[0].x, boards[0].z)], boards)).toHaveLength(1);
  });
});
