import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assets } from '../src/core/Assets';
import { XA_LO } from '../src/core/Data';
import { userSettings } from '../src/core/Settings';
import {
  CREST_FROM_T,
  CREST_TO_T,
  KIND,
  XALO_TRAFFIC_MODELS,
  XaLoTraffic,
  frontageSection,
  keepOutZones,
  laneOffsetAt,
  pitchFromSlope,
  roadProfileOf,
  roadWidthAt,
  sampleRoad,
  trafficPlan,
  trafficT,
  type RoadSample,
} from '../src/world/XaLoTraffic';
import { TrackPath } from '../src/world/TrackPath';

beforeAll(async () => {
  await RAPIER.init();
});

const profile = roadProfileOf(XA_LO);
const section = frontageSection(XA_LO.raw as unknown as Parameters<typeof frontageSection>[0]);
const raw = XA_LO.raw as unknown as {
  ambientTraffic: { trucks: number; cars: number; buses: number; scooters: number; speedKmh: [number, number] };
};
const LAP = XA_LO.lapLengthM;

const mainT = 0.2; // section B: plain main carriageway
const frontT = 0.65; // deep inside section F

describe('XaLoTraffic pure helpers (real xa_lo_ha_noi.json)', () => {
  it('finds the frontage section F', () => {
    expect(section).not.toBeNull();
    expect(section?.fromT).toBeCloseTo(0.492, 3);
    expect(section?.toT).toBeCloseTo(0.8605, 3);
  });

  it('uses the actual road width per section', () => {
    expect(roadWidthAt(profile, mainT)).toBeCloseTo(XA_LO.roadWidthM, 6);
    expect(roadWidthAt(profile, frontT)).toBeCloseTo(8, 6);
  });

  it('puts the right lane at -(width/2 - laneWidth/2) from the line on the main carriageway', () => {
    const w = XA_LO.roadWidthM;
    const laneW = w / profile.mainLanes;
    // Offsets are + to the right; the right lane centre is half the road minus half a lane away.
    expect(laneOffsetAt(profile, mainT, 0)).toBeCloseTo(w / 2 - laneW / 2, 6);
    expect(laneOffsetAt(profile, mainT, 1)).toBeCloseTo(w / 2 - laneW * 1.5, 6);
    expect(laneOffsetAt(profile, mainT, 2)).toBeCloseTo(w / 2 - laneW * 2.5, 6);
  });

  it('uses the frontage width in section F (2 lanes of 4 m)', () => {
    expect(laneOffsetAt(profile, frontT, 0)).toBeCloseTo(8 / 2 - 2, 6);
  });

  it('plans deterministically from the seed', () => {
    const opts = { seed: 1978, lapLengthM: LAP, speedKmh: raw.ambientTraffic.speedKmh, section };
    const a = trafficPlan('trucks', raw.ambientTraffic.trucks, 2, opts);
    const b = trafficPlan('trucks', raw.ambientTraffic.trucks, 2, opts);
    expect(a).toEqual(b);
    expect(a).toHaveLength(6);
    const c = trafficPlan('trucks', 6, 2, { ...opts, seed: 7 });
    expect(c).not.toEqual(a);
  });

  it('drives at 40-70 km/h and keeps trucks, buses and scooters in the right lane, cars in lanes 2/3', () => {
    const opts = { seed: 1978, lapLengthM: LAP, speedKmh: raw.ambientTraffic.speedKmh, section };
    for (const kind of ['trucks', 'cars', 'buses', 'scooters'] as const) {
      const specs = trafficPlan(kind, raw.ambientTraffic[kind], 2, opts);
      for (const s of specs) {
        expect(s.speedMps * 3.6).toBeGreaterThanOrEqual(40);
        expect(s.speedMps * 3.6).toBeLessThanOrEqual(70);
        if (kind === 'cars') expect([1, 2]).toContain(s.lane);
        else expect(s.lane).toBe(0);
      }
    }
  });

  it('keeps whole-lap vehicles out of the start grid and the bridge crest at t = 0', () => {
    const opts = { seed: 1978, lapLengthM: LAP, speedKmh: raw.ambientTraffic.speedKmh, section };
    const zones = keepOutZones(LAP);
    for (const kind of ['trucks', 'cars', 'buses'] as const) {
      for (const s of trafficPlan(kind, raw.ambientTraffic[kind], 2, opts)) {
        const t = trafficT(s, 0, LAP, section);
        for (const z of zones) expect(t >= z.from && t <= z.to).toBe(false);
        expect(t < CREST_FROM_T || t > CREST_TO_T).toBe(true);
      }
    }
  });

  it('wraps scooters inside section F forever', () => {
    const opts = { seed: 1978, lapLengthM: LAP, speedKmh: raw.ambientTraffic.speedKmh, section };
    const specs = trafficPlan('scooters', raw.ambientTraffic.scooters, 2, opts);
    expect(specs).toHaveLength(30);
    for (const s of specs) {
      expect(s.inSection).toBe(true);
      for (const time of [0, 7, 60, 333, 1200, 99999]) {
        const t = trafficT(s, time, LAP, section);
        expect(t).toBeGreaterThanOrEqual((section as { fromT: number }).fromT);
        expect(t).toBeLessThanOrEqual((section as { toT: number }).toT);
      }
    }
  });

  it('loops whole-lap vehicles around the lap', () => {
    const opts = { seed: 1978, lapLengthM: LAP, speedKmh: raw.ambientTraffic.speedKmh, section };
    const [s] = trafficPlan('buses', 3, 1, opts);
    const t0 = trafficT(s, 0, LAP, section);
    const tLap = trafficT(s, LAP / s.speedMps, LAP, section);
    expect(tLap).toBeCloseTo(t0, 6);
  });

  it('pitches along the slope of the road', () => {
    expect(pitchFromSlope(0)).toBe(0);
    expect(pitchFromSlope(1)).toBeCloseTo(Math.PI / 4, 9);
    expect(pitchFromSlope(-0.1)).toBeLessThan(0);
  });

  it('samples height and slope from the 3D path', () => {
    const path = new TrackPath(XA_LO.spline.points, 2, 40);
    const out: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, slope: 0 };
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 400; i++) {
      sampleRoad(path, i / 400, out);
      minY = Math.min(minY, out.y);
      maxY = Math.max(maxY, out.y);
      expect(out.y).toBeCloseTo(path.yAt(i / 400), 1);
      expect(Math.hypot(out.tx, out.tz)).toBeCloseTo(1, 5);
    }
    expect(maxY - minY).toBeGreaterThan(1); // the first map with elevation
  });
});

const PARTS = ['Body', 'Glass', 'Light_Head', 'Light_Tail', 'Tire'];
const stubAssets = {
  cloneModel(): THREE.Group {
    const g = new THREE.Group();
    for (const name of PARTS) {
      const mat = new THREE.MeshStandardMaterial({ color: '#888888' });
      mat.name = name;
      if (name.startsWith('Light_')) {
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

const build = (): { world: RAPIER.World; scene: THREE.Scene; traffic: XaLoTraffic } => {
  const path = new TrackPath(XA_LO.spline.points, 2, 40);
  const world = new RAPIER.World({ x: 0, y: -15, z: 0 });
  const scene = new THREE.Scene();
  return { world, scene, traffic: new XaLoTraffic(scene, RAPIER, world, stubAssets, XA_LO, path) };
};

const drawCalls = (t: XaLoTraffic): number => {
  let n = 0;
  t.group.traverse((o) => {
    if (o instanceof THREE.Mesh && o.visible) n++;
  });
  return n;
};

describe('XaLoTraffic scene (stub models)', () => {
  it('lists the ten traffic model files', () => {
    expect(XALO_TRAFFIC_MODELS).toHaveLength(10);
  });

  it('builds 49 kinematic bodies within 22 draw calls, steps, and disposes cleanly', () => {
    userSettings.preset = 'med';
    const { world, scene, traffic } = build();
    expect(world.bodies.len()).toBe(6 + 10 + 3 + 30);
    expect(traffic.skippedKinds).toEqual([]);
    expect(drawCalls(traffic)).toBeLessThanOrEqual(22);
    expect(traffic.debugTrafficTs(KIND.scooters)).toHaveLength(30);
    expect(traffic.debugTrafficTs(KIND.trucks)).toHaveLength(6);

    traffic.setFocus(1e6, 1e6);
    traffic.update(1 / 60);
    expect(drawCalls(traffic)).toBe(0); // everything is far from the focus

    const before = traffic.debugTrafficTs(KIND.cars);
    for (let i = 0; i < 120; i++) {
      world.step();
      traffic.update(1 / 60);
    }
    const after = traffic.debugTrafficTs(KIND.cars);
    expect(after.some((t, i) => t !== before[i])).toBe(true);

    traffic.dispose();
    expect(world.bodies.len()).toBe(0);
    expect(scene.children.length).toBe(0);
  });

  it('creates no bodies on the Low preset', () => {
    userSettings.preset = 'low';
    const { world, traffic } = build();
    expect(world.bodies.len()).toBe(0);
    expect(traffic.skippedKinds).toEqual([]);
    traffic.dispose();
    userSettings.preset = 'med';
  });
});
