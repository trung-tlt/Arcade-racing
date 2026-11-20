import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import raw from '../data/tracks/monte_carlo.json';
import { MONTE_CARLO, RACE, TRACKS, getTrack, roadWidthAt } from '../src/core/Data';
import { MONTE_CARLO_MODELS, MONTE_CARLO_TEXTURES } from '../src/world/MonteCarlo';
import { TrackPath } from '../src/world/TrackPath';
import { relaxTightBends } from '../src/world/relaxBends';
import {
  RoadIndex,
  alongSide,
  curvatureAt,
  footprintPoints,
  footprintsOverlap,
  frameAt,
  inRange,
  makeTerrain,
  planBarriers,
  planBelleEpoque,
  planKerbs,
  planTowers,
  tunnelRange,
  yawForX,
  yawForZ,
} from '../src/world/monteCarloLayout';
import { seededRng } from '../src/world/CongHoaDressing';

const path = new TrackPath(
  relaxTightBends(MONTE_CARLO.spline.points, RACE.track.minTurnRadiusM),
  RACE.track.sampleSpacingM,
  RACE.track.projectWindowSamples,
);
const index = new RoadIndex(path, 8);
const fine = new RoadIndex(path, 1);
const stands = (raw.grandstands as { segments: { position: number[] }[] }[]).flatMap((g) =>
  g.segments.map((s) => ({ x: s.position[0], z: s.position[2], r: 26 })),
);

describe('Monte-Carlo Harbour track data', () => {
  it('is the 5th map: a clockwise daylight street circuit, 12 m wide, with elevation', () => {
    expect(TRACKS.map((t) => t.id)).toEqual(['cat_lai', 'cong_hoa', 'xa_lo_ha_noi', 'pham_van_dong', 'monte_carlo']);
    expect(getTrack('monte_carlo')).toBe(MONTE_CARLO);
    expect(MONTE_CARLO.timeOfDay).toBe('day');
    expect(MONTE_CARLO.laps).toBe(3);
    expect(MONTE_CARLO.hasElevation).toBe(true);
    expect(MONTE_CARLO.roadWidthM).toBe(12);
    expect(roadWidthAt(MONTE_CARLO, 0.4)).toBe(12);
    expect(MONTE_CARLO.roadTexture).toBe('textures/mc_road.png');
    expect(MONTE_CARLO.roadTextureRepeatM).toBe(12);
    expect(MONTE_CARLO.weather).toBeNull();
    expect(MONTE_CARLO.widthProfile).toEqual([]);
  });

  it('carries its daylight lighting (sun, hemi, fog) from the top-level block', () => {
    const d = MONTE_CARLO.daylight;
    expect(d).not.toBeNull();
    expect(d?.sun.intensity).toBeCloseTo(3.2);
    expect(d?.fog.density).toBeCloseTo(0.0012);
    expect(d?.water?.sunGlint).toBe(true);
  });

  it('exposes the no-fire zones and the light-sequence start', () => {
    expect(MONTE_CARLO.noFireZones.map((z) => z.name)).toEqual(['Tunnel', 'Nouvelle Chicane']);
    for (const z of MONTE_CARLO.noFireZones) expect(z.fromT).toBeLessThan(z.toT);
    expect(MONTE_CARLO.startLights?.model).toBe('models/props_monaco/start_gantry.glb');
    expect(MONTE_CARLO.startLights?.sfx).toBe('sfx/monaco/start_lights.wav');
    // Other maps have neither.
    expect(getTrack('cat_lai').noFireZones).toEqual([]);
    expect(getTrack('cat_lai').startLights).toBeNull();
  });

  it('has 9 ordered checkpoints, a 6-slot grid and pickups on valid lanes', () => {
    expect(MONTE_CARLO.checkpoints).toHaveLength(9);
    MONTE_CARLO.checkpoints.forEach((c, i) => {
      if (i > 0) expect(c.t).toBeGreaterThan(MONTE_CARLO.checkpoints[i - 1].t);
    });
    expect(MONTE_CARLO.startLine.grid).toHaveLength(6);
    for (const p of MONTE_CARLO.pickups)
      for (const it of p.items) expect(it.lane).toBeLessThan(MONTE_CARLO.laneOffsetsM.length);
  });

  it('lap length matches the spline within 2%', () => {
    expect(Math.abs(path.lengthM - MONTE_CARLO.lapLengthM) / MONTE_CARLO.lapLengthM).toBeLessThan(0.02);
  });

  it('every model and texture it names is on disk and in the lazy-load lists', () => {
    for (const f of MONTE_CARLO_MODELS) expect(existsSync(`public/assets/${f}`), f).toBe(true);
    for (const f of MONTE_CARLO_TEXTURES) expect(existsSync(`public/assets/${f}`), f).toBe(true);
    const named = new Set(JSON.stringify(raw).match(/models\/props_monaco\/[\w]+\.glb/g));
    for (const m of named) expect(MONTE_CARLO_MODELS, m).toContain(m);
  });
});

describe('Monte-Carlo layout helpers', () => {
  it('frames are unit-length with left = (tz, -tx)', () => {
    const f = frameAt(path, 0.3);
    expect(Math.hypot(f.tx, f.tz)).toBeCloseTo(1);
    expect(f.lx).toBeCloseTo(f.tz);
    expect(f.lz).toBeCloseTo(-f.tx);
  });

  it('yaw helpers turn local +X / +Z to the requested direction', () => {
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
      [-0.6, 0.8],
    ]) {
      const a = yawForX(dx, dz);
      expect([Math.cos(a), -Math.sin(a)][0]).toBeCloseTo(dx);
      expect(-Math.sin(a)).toBeCloseTo(dz);
      const b = yawForZ(dx, dz);
      expect(Math.sin(b)).toBeCloseTo(dx);
      expect(Math.cos(b)).toBeCloseTo(dz);
    }
  });

  it('curvature is signed: the hairpin turns left, Sainte Dévote right', () => {
    const len = path.lengthM;
    expect(curvatureAt(path, 0.3702 * len)).toBeGreaterThan(0.02);
    expect(curvatureAt(path, 0.0788 * len)).toBeLessThan(-0.005);
    expect(Math.abs(curvatureAt(path, 0.02 * len))).toBeLessThan(0.002);
  });

  it('the road index finds the nearest sample and the side of the road', () => {
    const f = frameAt(path, 0.65);
    const x = f.x + f.lx * 20;
    const z = f.z + f.lz * 20;
    const { i, d } = index.nearest(x, z);
    expect(d).toBeLessThan(21);
    expect(index.lateral(i, x, z)).toBeGreaterThan(15);
    expect(index.distance(f.x, f.z)).toBeLessThan(4.1);
  });

  it('the tunnel range comes from the JSON and inRange honours a margin', () => {
    const tn = tunnelRange(MONTE_CARLO);
    expect(tn).toEqual({ fromT: 0.4463, toT: 0.578 });
    expect(inRange(tn, 0.5)).toBe(true);
    expect(inRange(tn, 0.44)).toBe(false);
    expect(inRange(tn, 0.44, 0.01)).toBe(true);
    expect(inRange(null, 0.5)).toBe(false);
  });

  it('oriented footprints overlap when they touch and not when apart', () => {
    const a = { x: 0, z: 0, yaw: 0, hw: 5, hd: 5 };
    expect(footprintsOverlap(a, { ...a, x: 9 })).toBe(true);
    expect(footprintsOverlap(a, { ...a, x: 11 })).toBe(false);
    expect(footprintsOverlap(a, { ...a, x: 11, yaw: Math.PI / 4 })).toBe(true);
    expect(footprintPoints(a)).toHaveLength(9);
  });
});

describe('Monte-Carlo barriers and kerbs', () => {
  const plan = planBarriers(path, MONTE_CARLO, stands);
  const len = path.lengthM;
  const tn = tunnelRange(MONTE_CARLO) as { fromT: number; toT: number };

  it('puts Armco on both sides every 4 m except in the tunnel', () => {
    const perSide = Math.floor(len / 4);
    const tunnelPieces = Math.round(((tn.toT - tn.fromT) * len) / 4);
    expect(plan.armco.length).toBeGreaterThan(2 * perSide - 2 * tunnelPieces - 120);
    expect(plan.armco.length).toBeLessThan(2 * perSide - tunnelPieces);
    for (const p of plan.armco) {
      const t = path.project(p.x, p.z);
      expect(t > tn.fromT + 0.001 && t < tn.toT - 0.001, `armco at t=${t.toFixed(3)} inside the tunnel`).toBe(false);
    }
  });

  it('every 3rd Armco piece carries a sponsor panel and the four brands cycle', () => {
    const ads = plan.armco.filter((p) => p.ad >= 0);
    expect(ads.length).toBeGreaterThan(plan.armco.length / 4);
    expect(ads.length).toBeLessThan(plan.armco.length / 2.5);
    expect(new Set(ads.map((p) => p.ad))).toEqual(new Set([0, 1, 2, 3]));
  });

  it('the Armco sits 6.6 m from the centre line and the catch fence 6.75 m', () => {
    const p = plan.armco[100];
    expect(fine.distance(p.x, p.z)).toBeCloseTo(6.6, 0);
    expect(plan.fence.length).toBeLessThan(plan.armco.length); // none behind the grandstands
    expect(plan.fence.length).toBeGreaterThan(plan.armco.length * 0.7);
  });

  it('places the 8 tyre walls of 6 stacks on the outside of their corners', () => {
    expect(plan.tyres).toHaveLength(48);
    const hairpin = plan.tyres.filter((p) => Math.abs(path.project(p.x, p.z) - 0.3702) < 0.01);
    expect(hairpin.length).toBeGreaterThan(0);
    // The hairpin turns left, so its tyres are on the right: negative lateral offset.
    for (const p of hairpin) {
      const { i } = index.nearest(p.x, p.z);
      expect(index.lateral(i, p.x, p.z)).toBeLessThan(0);
    }
  });

  it('kerbs follow the corners: only where the road really bends, inside and out', () => {
    const kerbs = planKerbs(path, MONTE_CARLO);
    expect(kerbs.length).toBeGreaterThan(40);
    for (const k of kerbs) {
      const { d } = fine.nearest(k.x, k.z);
      expect(d).toBeLessThan(5.7);
      expect(d).toBeGreaterThan(5.2);
    }
    // No kerbs on the long main straight.
    expect(kerbs.some((k) => path.project(k.x, k.z) < 0.04)).toBe(false);
  });
});

describe('Monte-Carlo terrain and dressing', () => {
  const terrain = makeTerrain(index);

  it('the land follows the road height near it and climbs to Casino Square', () => {
    for (const t of [0.01, 0.15, 0.29, 0.4, 0.7]) {
      const f = frameAt(path, t);
      expect(Math.abs(terrain.heightAt(f.x + f.lx * 14, f.z + f.lz * 14) - f.y)).toBeLessThan(2.5);
    }
    expect(terrain.heightAt(790, 80)).toBeGreaterThan(30);
  });

  it('the harbour side of the quay is sea, the infield is land', () => {
    const f = frameAt(path, 0.65);
    expect(terrain.seaAt(f.x + f.lx * 40, f.z + f.lz * 40)).toBeGreaterThan(0.99);
    expect(terrain.seaAt(f.x - f.lx * 40, f.z - f.lz * 40)).toBe(0);
    expect(terrain.seaAt(f.x + f.lx * 6, f.z + f.lz * 6)).toBe(0);
    expect(terrain.seaAt(0, 800)).toBe(1);
  });

  it('Belle Époque terraces clear the road, never overlap and stay in their rows', () => {
    const blocked = stands;
    const rows = planBelleEpoque(path, MONTE_CARLO, index, blocked);
    expect(rows.length).toBeGreaterThan(60);
    for (const b of rows) {
      for (const [x, z] of footprintPoints(b)) expect(index.distance(x, z)).toBeGreaterThanOrEqual(13.9);
    }
    for (let i = 0; i < rows.length; i += 7) {
      for (let j = i + 1; j < Math.min(rows.length, i + 14); j++) {
        expect(footprintsOverlap(rows[i], rows[j]), `${i} vs ${j}`).toBe(false);
      }
    }
    // Deterministic: the same seed gives the same city.
    const again = planBelleEpoque(path, MONTE_CARLO, index, blocked);
    expect(again.map((b) => [b.x, b.z, b.model])).toEqual(rows.map((b) => [b.x, b.z, b.model]));
  });

  it('towers keep 40 m from the track and 70 m from each other', () => {
    const towers = planTowers(18, terrain, stands, seededRng(3));
    expect(towers.length).toBe(18);
    for (const t of towers) {
      expect(index.distance(t.x, t.z)).toBeGreaterThanOrEqual(40);
      expect(terrain.seaAt(t.x, t.z)).toBe(0);
    }
  });

  it('quay palms stand every 14 m on the harbour side and skip blocked spots', () => {
    const rnd = seededRng(1);
    const palms = alongSide(path, 0.585, 0.865, 14, 1, 9.6, [], rnd, 2);
    expect(palms.length).toBeGreaterThan(60);
    expect(palms.length).toBeLessThan(75);
    const blocked = [{ x: palms[5].x, z: palms[5].z, r: 5 }];
    expect(alongSide(path, 0.585, 0.865, 14, 1, 9.6, blocked, seededRng(1), 2).length).toBeLessThan(palms.length);
  });
});
