import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assets } from '../src/core/Assets';
import { PHAM_VAN_DONG } from '../src/core/Data';
import { userSettings } from '../src/core/Settings';
import {
  BUS_DWELL_SEC,
  FLOOD_CRAWL_KMH,
  KEEP_OUT_AHEAD_OF_LINE_M,
  KIND,
  PVD_TRAFFIC_MODELS,
  PvdTraffic,
  ZONE_KEYS,
  bakeVehicle,
  bandsOf,
  busSchedule,
  laneOffsetInBand,
  layoutOf,
  makeSchedule,
  planPvdTraffic,
  runSchedule,
  scheduleDistance,
  spreadOverZones,
  trafficT,
  trafficZones,
  type PlanInput,
} from '../src/world/PvdTraffic';
import { TrackPath } from '../src/world/TrackPath';

beforeAll(async () => {
  await RAPIER.init();
});

const raw = PHAM_VAN_DONG.raw as unknown as {
  ambientTraffic: {
    ponchoScooters: number;
    cars: number;
    buses: number;
    speedKmh: [number, number];
    models: Record<'scooters' | 'cars' | 'buses', string[]>;
  };
  roadLayout: { crossSectionFromCentre: { part: string; widthM: number }[] };
  sections: { id: string; fromT: number; toT: number }[];
};
const cfg = raw.ambientTraffic;
const path = new TrackPath(PHAM_VAN_DONG.spline.points, 2, 40);
const LAP = path.lengthM;
const layout = layoutOf(PHAM_VAN_DONG, path);
const sec = (id: string): { fromT: number; toT: number } => raw.sections.find((s) => s.id === id) as never;

const planInput = (seed = 2013): PlanInput => ({
  seed,
  lapLengthM: LAP,
  speedKmh: cfg.speedKmh,
  counts: { scooters: cfg.ponchoScooters, cars: cfg.cars, buses: cfg.buses },
  models: { scooters: cfg.models.scooters.length, cars: cfg.models.cars.length, buses: cfg.models.buses.length },
  zones: layout.zones,
  flood: layout.flood,
  bands: layout.bands,
  shelters: layout.shelters,
});

describe('schedules', () => {
  it('runs the cycle and wraps', () => {
    const s = makeSchedule([{ lenM: 100, durSec: 10 }]);
    expect(scheduleDistance(s, 0)).toBe(0);
    expect(scheduleDistance(s, 5)).toBeCloseTo(50, 9);
    expect(scheduleDistance(s, 10)).toBeCloseTo(0, 9); // back at the start
    expect(scheduleDistance(s, 25)).toBeCloseTo(50, 9);
    expect(scheduleDistance(s, -5)).toBeCloseTo(50, 9);
  });

  it('crawls through the flooded stretch at 8 km/h and runs at speed outside it', () => {
    const crawl = FLOOD_CRAWL_KMH / 3.6;
    const s = runSchedule(1000, 10, { fromM: 400, toM: 500, mps: crawl });
    const speedAt = (d0: number): number => {
      // find the time at which the distance reaches d0, then measure the local speed
      let t = 0;
      while (scheduleDistance(s, t) < d0) t += 0.01;
      return (scheduleDistance(s, t + 0.05) - scheduleDistance(s, t)) / 0.05;
    };
    expect(speedAt(200)).toBeCloseTo(10, 1);
    expect(speedAt(450)).toBeCloseTo(crawl, 1);
    expect(speedAt(800)).toBeCloseTo(10, 1);
    expect(s.cycleSec).toBeCloseTo(40 + 100 / crawl + 50, 6);
  });

  it('ignores a flood that is outside the zone', () => {
    const s = runSchedule(1000, 10, { fromM: 2000, toM: 2100, mps: 2 });
    expect(s.cycleSec).toBeCloseTo(100, 9);
  });

  it('holds a bus still for the dwell time at each stop', () => {
    const s = busSchedule(1000, 10, [300, 700], 12);
    expect(s.cycleSec).toBeCloseTo(100 + 24, 9);
    expect(scheduleDistance(s, 30)).toBeCloseTo(300, 9); // arrives at 30 s
    expect(scheduleDistance(s, 35)).toBeCloseTo(300, 9); // standing
    expect(scheduleDistance(s, 41.9)).toBeCloseTo(300, 9);
    expect(scheduleDistance(s, 42 + 5)).toBeCloseTo(350, 9); // moving again
    expect(scheduleDistance(s, 42 + 40 + 6)).toBeCloseTo(700, 9); // second stop
  });

  it('a bus with no stops just runs', () => {
    expect(busSchedule(500, 10, [], 12).cycleSec).toBeCloseTo(50, 9);
  });
});

describe('lanes and bands (real roadLayout)', () => {
  const b = bandsOf(raw.roadLayout.crossSectionFromCentre);

  it('reads 3 car lanes of 11 m, 2 motorbike lanes of 7 m and a 10.6 m offset between their centres', () => {
    expect(b).toMatchObject({ carWidthM: 11, carLanes: 3, motoWidthM: 7, motoLanes: 2 });
    expect(b.deltaM).toBeCloseTo(10.6, 6); // car lanes at 9.5 m from the centre, motorbike lanes at 20.1 m
  });

  it('puts lane 0 on the right (+) and the last lane on the left', () => {
    expect(laneOffsetInBand(11, 3, 0)).toBeCloseTo(11 / 3, 9);
    expect(laneOffsetInBand(11, 3, 1)).toBeCloseTo(0, 9);
    expect(laneOffsetInBand(11, 3, 2)).toBeCloseTo(-11 / 3, 9);
    expect(laneOffsetInBand(7, 2, 0)).toBeCloseTo(1.75, 9);
  });

  it('splits counts over zones by length without losing any', () => {
    const z = spreadOverZones(14, [
      { key: 'outA', lenM: 300 },
      { key: 'outB', lenM: 700 },
    ]);
    expect(z).toHaveLength(14);
    expect(z.filter((k) => k === 'outA')).toHaveLength(4);
    expect(z.filter((k) => k === 'outB')).toHaveLength(10);
    expect(spreadOverZones(0, [{ key: 'outA', lenM: 1 }])).toEqual([]);
  });
});

describe('zones (real path)', () => {
  it('the path matches the data: a 4.8 km lap with the bridge at N 520-1080 on both halves', () => {
    expect(LAP).toBeGreaterThan(4600);
    expect(LAP).toBeLessThan(5000);
    expect(layout.zones.outA.toT).toBeLessThan(sec('B').toT);
  });

  it('orders the four zones along the lap and keeps them clear of the start, bridges, flyover and final U-turn', () => {
    const z = layout.zones;
    const flyover = sec('F');
    const start = KEEP_OUT_AHEAD_OF_LINE_M / LAP;
    expect(z.outA.fromT).toBeGreaterThanOrEqual(start - 1e-9);
    for (const k of ZONE_KEYS) expect(z[k].toT).toBeGreaterThan(z[k].fromT + 100 / LAP); // each is at least 100 m long
    expect(z.outA.toT).toBeLessThan(z.outB.fromT);
    expect(z.outB.toT).toBeLessThanOrEqual(flyover.fromT);
    expect(z.retA.fromT).toBeGreaterThanOrEqual(flyover.toT);
    expect(z.retA.toT).toBeLessThan(z.retB.fromT);
    expect(z.retB.toT).toBeLessThanOrEqual(sec('H').toT);
  });

  it('puts no zone on the 12 m Binh Loi bridge decks', () => {
    for (let i = 0; i < path.count; i++) {
      const t = i / path.count;
      const onBridge = path.py[i] > 5; // the deck climbs to 12 m; the Go Dua hump is only 3.5 m
      if (!onBridge) continue;
      for (const k of ZONE_KEYS) expect(t >= layout.zones[k].fromT && t <= layout.zones[k].toT).toBe(false);
    }
  });

  it('trafficZones subtracts the bridges from each half', () => {
    const z = trafficZones({
      lapLengthM: 5000,
      outFromT: 0,
      flyoverFromT: 0.5,
      flyoverToT: 0.51,
      returnToT: 0.97,
      bridgeOut: { fromT: 0.1, toT: 0.2 },
      bridgeRet: { fromT: 0.7, toT: 0.8 },
      floodToT: 0.56,
    });
    expect(z.outA.fromT).toBeCloseTo(170 / 5000, 9);
    expect(z.outA.toT).toBeLessThan(0.1);
    expect(z.outB.fromT).toBeGreaterThan(0.2);
    expect(z.retB.fromT).toBeGreaterThan(0.8);
    expect(z.retB.toT).toBeLessThan(0.97);
    expect(z.retDry.fromT).toBeGreaterThan(0.56); // after the dip
    expect(z.retDry.toT).toBeLessThan(0.7);
  });

  it('finds the flood inside the first return zone and the shelters on both halves', () => {
    expect(layout.flood.fromT).toBeGreaterThan(layout.zones.retA.fromT);
    expect(layout.flood.toT).toBeLessThan(layout.zones.retA.toT);
    expect(layout.shelters).toHaveLength(6);
    expect(layout.shelters.filter((s) => s.half === 'out')).toHaveLength(3);
    expect(layout.shelters.filter((s) => s.half === 'ret')).toHaveLength(3);
  });
});

describe('plan (real pham_van_dong.json)', () => {
  const specs = planPvdTraffic(planInput());
  const of = (kind: number): typeof specs => specs.filter((s) => s.kind === kind);

  it('is deterministic and varies with the seed', () => {
    expect(planPvdTraffic(planInput())).toEqual(specs);
    expect(planPvdTraffic(planInput(7))).not.toEqual(specs);
  });

  it('plans 40 scooters, 10 cars and 3 buses', () => {
    expect(of(KIND.scooters)).toHaveLength(40);
    expect(of(KIND.cars)).toHaveLength(10);
    expect(of(KIND.buses)).toHaveLength(3);
  });

  it('keeps every vehicle inside its zone at any time, so none is ever on a bridge, the flyover or the grid', () => {
    for (const s of specs) {
      const z = layout.zones[s.zone];
      for (const time of [0, 1, 17, 60, 211, 1000, 5000, 123456]) {
        const t = trafficT(s, layout.zones, LAP, time);
        expect(t).toBeGreaterThanOrEqual(z.fromT - 1e-9);
        expect(t).toBeLessThanOrEqual(z.toT + 1e-9);
      }
    }
  });

  it('starts nothing in the start grid keep-out at t = 0', () => {
    for (const s of specs) {
      const t = trafficT(s, layout.zones, LAP, 0);
      expect(t > 0.03 || t < 0).toBe(true);
      expect(t * LAP).toBeGreaterThanOrEqual(KEEP_OUT_AHEAD_OF_LINE_M - 1);
    }
  });

  it('drives at 25-55 km/h (scooters and cars) except in the flooded dip', () => {
    for (const s of [...of(KIND.scooters), ...of(KIND.cars)]) {
      const fastest = Math.max(...s.schedule.segs.filter((g) => g.lenM > 0).map((g) => g.lenM / g.durSec));
      expect(fastest * 3.6).toBeGreaterThanOrEqual(cfg.speedKmh[0] - 1e-6);
      expect(fastest * 3.6).toBeLessThanOrEqual(cfg.speedKmh[1] + 1e-6);
    }
  });

  it('makes only the return-half scooters crawl, at 8 km/h', () => {
    const crawling = of(KIND.scooters).filter((s) =>
      s.schedule.segs.some((g) => g.lenM > 0 && (g.lenM / g.durSec) * 3.6 < 10),
    );
    expect(crawling.length).toBeGreaterThan(0);
    for (const s of crawling) {
      expect(s.zone).toBe('retA');
      const slow = s.schedule.segs.find((g) => (g.lenM / g.durSec) * 3.6 < 10);
      expect(((slow as { lenM: number; durSec: number }).lenM / (slow as { durSec: number }).durSec) * 3.6).toBeCloseTo(
        FLOOD_CRAWL_KMH,
        6,
      );
    }
    for (const s of of(KIND.cars)) expect(s.schedule.segs).toHaveLength(1); // cars never enter the dip
  });

  it('keeps cars out of the flooded dip entirely (the car lanes do not dip)', () => {
    const cars = of(KIND.cars);
    expect(cars.some((c) => c.zone === 'retDry')).toBe(true);
    for (const s of cars) {
      expect(s.zone).not.toBe('retA');
      for (let time = 0; time < 800; time += 7) {
        const t = trafficT(s, layout.zones, LAP, time);
        expect(t < layout.flood.fromT || t > layout.flood.toT).toBe(true);
      }
    }
  });

  it('puts the lanes where racers do not need them: outbound cars on the right lane of the car lanes', () => {
    const outCars = of(KIND.cars).filter((s) => s.zone.startsWith('out'));
    expect(outCars.length).toBe(5);
    for (const s of outCars) {
      expect(s.bandM).toBe(0);
      expect(s.laneM).toBeGreaterThan(laneOffsetInBand(11, 3, 0) - 0.4); // rightmost lane
    }
    const retCars = of(KIND.cars).filter((s) => s.zone.startsWith('ret'));
    for (const s of retCars) expect(s.bandM).toBeCloseTo(-10.6, 6); // the west car lanes, left of the return line
  });

  it('keeps the return-half scooters and buses to the curb lane of the racing motorbike lanes', () => {
    for (const s of [...of(KIND.scooters), ...of(KIND.buses)].filter((v) => v.zone.startsWith('ret'))) {
      expect(s.bandM).toBe(0);
      expect(s.laneM).toBeGreaterThan(1.75 - 0.6);
      expect(s.laneM).toBeLessThan(1.75 + 0.6);
    }
  });

  it('keeps buses in the motorbike lanes, never in the outbound racing line, and stopping at shelters', () => {
    for (const s of of(KIND.buses)) {
      if (s.zone.startsWith('out')) expect(s.bandM).toBeCloseTo(10.6, 6);
      expect(s.schedule.segs.some((g) => g.lenM === 0 && g.durSec === BUS_DWELL_SEC)).toBe(true);
    }
  });
});

// Real node-less stubs: the material names of the poncho riders, the civilian cars and the bus.
const PONCHO = ['Tire', 'Scooter_Dark', 'Scooter_Body', 'Light_Head', 'Light_Tail', 'Poncho', 'Skin', 'Helmet'];
const CAR = ['Civ_Paint', 'Glass', 'Trim', 'Light_Head', 'Light_Tail', 'Tire', 'Hub'];
const BUS = ['Bus_Paint', 'Bus_White', 'Glass', 'Route_Sign', 'Trim', 'Light_Head', 'Light_Tail', 'Tire', 'Hub'];
const stubAssets = {
  cloneModel(path: string): THREE.Group {
    const parts = path.includes('poncho') ? PONCHO : path.includes('bus') ? BUS : CAR;
    const g = new THREE.Group();
    for (const name of parts) {
      const mat = new THREE.MeshStandardMaterial({ color: '#888888' });
      mat.name = name;
      if (name.startsWith('Light_') || name === 'Route_Sign') {
        mat.emissive.set(name === 'Light_Tail' ? '#ff2020' : '#ffffff');
        mat.emissiveIntensity = 2;
      }
      g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
    }
    return g;
  },
} as unknown as Assets;

const build = (): { world: RAPIER.World; scene: THREE.Scene; traffic: PvdTraffic } => {
  const world = new RAPIER.World({ x: 0, y: -15, z: 0 });
  const scene = new THREE.Scene();
  return { world, scene, traffic: new PvdTraffic(scene, RAPIER, world, stubAssets, PHAM_VAN_DONG, path) };
};

const drawCalls = (t: PvdTraffic): number => {
  let n = 0;
  t.group.traverse((o) => {
    if (o instanceof THREE.Mesh && o.visible) n++;
  });
  return n;
};

describe('PvdTraffic scene (stub models)', () => {
  it('lists the ten traffic model files', () => {
    expect(PVD_TRAFFIC_MODELS).toHaveLength(10);
    expect(new Set(PVD_TRAFFIC_MODELS).size).toBe(10);
  });

  it('bakes a vehicle into ONE mesh with the lamps flagged to glow', () => {
    const g = bakeVehicle(stubAssets.cloneModel('models/props_conghoa/car_taxi.glb'));
    expect(g).not.toBeNull();
    const glow = (g as THREE.BufferGeometry).getAttribute('glow');
    let lit = 0;
    for (let i = 0; i < glow.count; i++) lit += glow.getX(i);
    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThan(glow.count);
    expect((g as THREE.BufferGeometry).getAttribute('color')).toBeDefined();
  });

  it('builds 53 kinematic bodies within 10 draw calls, steps, slows in the wet, and disposes cleanly', () => {
    userSettings.preset = 'med';
    const { world, scene, traffic } = build();
    expect(world.bodies.len()).toBe(40 + 10 + 3);
    expect(drawCalls(traffic)).toBeLessThanOrEqual(10);
    expect(traffic.debugTrafficTs(KIND.scooters)).toHaveLength(40);
    expect(traffic.debugTrafficTs(KIND.cars)).toHaveLength(10);
    expect(traffic.debugTrafficTs(KIND.buses)).toHaveLength(3);

    traffic.setFocus(1e6, 1e6);
    traffic.update(1 / 60);
    expect(drawCalls(traffic)).toBe(0); // everything is far from the focus

    const before = traffic.debugTrafficTs(KIND.cars);
    for (let i = 0; i < 120; i++) {
      world.step();
      traffic.update(1 / 60);
    }
    const dry = traffic.debugTrafficTs(KIND.cars);
    expect(dry.some((t, i) => t !== before[i])).toBe(true);

    // a standstill storm: the clock stops
    traffic.setWetSpeedMul(0);
    traffic.update(1);
    expect(traffic.debugTrafficTs(KIND.cars)).toEqual(dry);
    traffic.setWetSpeedMul(1);

    const pos = traffic.debugPositions();
    expect(pos).toHaveLength(53);
    for (const p of pos) expect(Number.isFinite(p.x + p.z)).toBe(true);

    traffic.dispose();
    expect(world.bodies.len()).toBe(0);
    expect(scene.children.length).toBe(0);
  });

  it('creates no bodies on the Low preset', () => {
    userSettings.preset = 'low';
    const { world, traffic } = build();
    expect(world.bodies.len()).toBe(0);
    traffic.update(1 / 60);
    traffic.dispose();
    userSettings.preset = 'med';
  });
});
