import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAT_LAI, CONG_HOA, PHAM_VAN_DONG as PVD, TRACKS, XA_LO, getTrack, roadWidthAt } from '../src/core/Data';
import raw from '../data/tracks/pham_van_dong.json';

const sections = raw.sections as { id: string; fromT: number; toT: number }[];
const sec = (id: string): { id: string; fromT: number; toT: number } => sections.find((s) => s.id === id) as never;

/** Every `models/…glb`, `textures/…png` and `sfx/…wav` path mentioned anywhere in a JSON value (notes included). */
function assetPaths(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') {
    for (const m of v.matchAll(/\b((?:models|textures|sfx)\/[\w./-]+\.(?:glb|png|wav))/g)) out.add(m[1]);
  } else if (Array.isArray(v)) v.forEach((x) => assetPaths(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => assetPaths(x, out));
  return out;
}

describe('Pham Van Dong Boulevard track data', () => {
  it('is the 4th map, a storm, with 2 laps and elevation', () => {
    expect(TRACKS.map((t) => t.id)).toEqual(['cat_lai', 'cong_hoa', 'xa_lo_ha_noi', 'pham_van_dong']);
    expect(getTrack('pham_van_dong')).toBe(PVD);
    expect(PVD.timeOfDay).toBe('storm');
    expect(PVD.laps).toBe(2);
    expect(PVD.hasElevation).toBe(true);
    expect(PVD.groundY).toBeLessThan(-3); // the flooded dip is 2.5 m under the land
    expect(PVD.lapLengthM).toBeGreaterThan(4700);
  });

  it('has a closed spline, 9 ordered checkpoints, a 6-slot grid and valid pickup lanes', () => {
    expect(raw.spline.closed).toBe(true);
    expect(PVD.spline.points.length).toBeGreaterThan(50);
    expect(PVD.checkpoints).toHaveLength(9);
    PVD.checkpoints.forEach((c, i) => {
      expect(c.id).toBe(i + 1);
      if (i > 0) expect(c.t).toBeGreaterThan(PVD.checkpoints[i - 1].t);
    });
    expect(PVD.startLine.grid).toHaveLength(6);
    for (const p of PVD.pickups) for (const it of p.items) expect(it.lane).toBeLessThan(PVD.laneOffsetsM.length);
  });

  it('races the 3 car lanes (11 m) outbound and the 7 m motorbike lanes from the flyover to the final U-turn', () => {
    expect(PVD.roadWidthM).toBe(11);
    expect(PVD.laneOffsetsM).toHaveLength(3);
    expect(PVD.laneOffsetsM[0]).toBeCloseTo(-11 / 3, 5);
    expect(PVD.laneOffsetsM[1]).toBeCloseTo(0, 5);
    expect(PVD.laneOffsetsM[2]).toBeCloseTo(11 / 3, 5);
    expect(PVD.roadTexture).toBe('textures/pvd_road_car_3lane.png');
    expect(PVD.widthProfile).toHaveLength(1);
    const moto = PVD.widthProfile[0];
    expect(moto.widthM).toBe(7);
    expect(moto.texture).toBe('textures/pvd_road_moto_2lane.png');
    expect(moto.fromT).toBeCloseTo(sec('F').toT, 6);
    expect(moto.toT).toBeCloseTo(sec('H').toT, 6);
    expect(roadWidthAt(PVD, 0.2)).toBeCloseTo(11, 5);
    expect(roadWidthAt(PVD, 0.75)).toBeCloseTo(7, 5);
    const edge = roadWidthAt(PVD, moto.fromT + 10 / PVD.lapLengthM);
    expect(edge).toBeGreaterThan(7);
    expect(edge).toBeLessThan(11);
  });

  it('has a wet look and the only weather block', () => {
    expect(PVD.daylight).not.toBeNull();
    expect(PVD.daylight?.road).toMatchObject({ roughness: 0.22, metalness: 0.15 });
    expect(PVD.daylight?.sky).toBe('textures/rain_sky_gradient.png');
    expect(PVD.weather).not.toBeNull();
    expect(PVD.weather?.puddles.items).toHaveLength(13);
    expect(PVD.weather?.rain.intensity).toEqual([0.9, 0.6]);
    expect(PVD.weather?.flood.fromT).toBeLessThan(PVD.weather?.flood.toT ?? 0);
    for (const t of [CAT_LAI, CONG_HOA, XA_LO]) expect(t.weather, t.id).toBeNull();
  });

  it('only references models, textures and sounds that exist', () => {
    const paths = assetPaths(raw);
    expect(paths.size).toBeGreaterThan(30);
    for (const p of paths) expect(existsSync(`public/assets/${p}`), p).toBe(true);
  });
});

describe('data/*.json', () => {
  it('never mentions the old city name', () => {
    const files = [
      ...readdirSync('data')
        .filter((f) => f.endsWith('.json'))
        .map((f) => `data/${f}`),
      ...readdirSync('data/tracks').map((f) => `data/tracks/${f}`),
    ];
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/sai\s?gon/i);
  });
});
