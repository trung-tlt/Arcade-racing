import { describe, expect, it } from 'vitest';
import { SUZUKA } from '../src/core/Data';
import { trackAudioFiles } from '../src/audio/SuzukaAudio';
import {
  ItemGrid,
  NEAR_M,
  planPlacements,
  selectWindow,
  suzukaTerrainColor,
  windowFor,
  type Item,
} from '../src/world/suzukaLayout';

const item = (x: number, z: number): Item => ({ x, y: 0, z, yaw: 0, scale: 1 });

describe('Suzuka placements', () => {
  it('resolve heights: road rows use the road height at t, the rest sample the terrain', () => {
    const out = planPlacements(
      {
        groups: {
          a: [
            { model: 'm1', x: 1, z: 2, rotY: 0.5, y: 'road', t: 0.25, yOff: 1 },
            { model: 'm1', x: 3, z: 4, rotY: 0, scale: 2 },
            { model: 'm2', x: 5, z: 6, rotY: 0, y: 12 },
          ],
        },
      },
      () => 40,
      (t) => 100 * t,
    );
    expect(out.get('m1')).toEqual([
      { x: 1, y: 26, z: 2, yaw: 0.5, scale: 1 },
      { x: 3, y: 39.95, z: 4, yaw: 0, scale: 2 },
    ]);
    expect(out.get('m2')?.[0].y).toBe(12);
  });
});

describe('Suzuka view window', () => {
  const view = { x: 0, z: 0, fx: 0, fz: 1 };
  const cfg = { radiusM: 300, cap: 5, wedge: true, keepNear: 1, keepFar: 1 };

  it('keeps what is in range and inside the wedge, and everything close by', () => {
    const grid = new ItemGrid([item(0, 100), item(0, -100), item(400, 0), item(0, -(NEAR_M - 5)), item(200, 10)]);
    const got = selectWindow(grid, view, cfg).map((i) => [i.x, i.z]);
    expect(got).toContainEqual([0, 100]); // ahead
    expect(got).toContainEqual([0, -(NEAR_M - 5)]); // behind but close
    expect(got).not.toContainEqual([0, -100]); // behind
    expect(got).not.toContainEqual([400, 0]); // out of range
    expect(got).not.toContainEqual([200, 10]); // off to the side, outside the 62 degree wedge
  });

  it('caps the count and keeps the nearest', () => {
    const items = Array.from({ length: 40 }, (_, i) => item(0, 40 + i * 5));
    const got = selectWindow(new ItemGrid(items), view, cfg);
    expect(got).toHaveLength(5);
    expect(got.map((i) => i.z)).toEqual([40, 45, 50, 55, 60]);
  });

  it('thins deterministically with distance: the same camera always draws the same trees', () => {
    const items = Array.from({ length: 600 }, (_, i) => item((i % 30) * 3 - 45, 50 + Math.floor(i / 30) * 12));
    const thin = { radiusM: 400, cap: 1000, wedge: false, keepNear: 0.9, keepFar: 0.1 };
    const a = selectWindow(new ItemGrid(items), view, thin);
    const b = selectWindow(new ItemGrid(items), view, thin);
    expect(a.map((i) => [i.x, i.z])).toEqual(b.map((i) => [i.x, i.z]));
    const near = a.filter((i) => i.z < 150).length;
    const far = a.filter((i) => i.z >= 250).length;
    const nearAll = items.filter((i) => i.z < 150).length;
    const farAll = items.filter((i) => i.z >= 250).length;
    expect(near / nearAll).toBeGreaterThan(far / farAll);
  });

  it('every model family has a window; trees are thinned and capped', () => {
    expect(windowFor('models/props_suzuka/maple_autumn.glb').keepFar).toBeLessThan(0.2);
    expect(windowFor('models/props_suzuka/house_a.glb').wedge).toBe(true);
    expect(windowFor('models/props_suzuka/ferris_wheel.glb').radiusM).toBeGreaterThan(2000);
    expect(windowFor('models/props_unknown/thing.glb').cap).toBeGreaterThan(0);
  });
});

describe('Suzuka terrain colour', () => {
  it('forest is darker than open grass, paddy is straw, built-up is grey, water is bluer', () => {
    const grass = suzukaTerrainColor({ forest: 0, paddy: 0, built: 0, water: 0 }, 0.5, 0.2);
    const forest = suzukaTerrainColor({ forest: 1, paddy: 0, built: 0, water: 0 }, 0.5, 0.2);
    const paddy = suzukaTerrainColor({ forest: 0, paddy: 1, built: 0, water: 0 }, 0.5, 0.2);
    const water = suzukaTerrainColor({ forest: 0, paddy: 0, built: 0, water: 1 }, 0.5, 0.2);
    const sum = (c: number[]): number => c[0] + c[1] + c[2];
    expect(sum(forest)).toBeLessThan(sum(grass));
    expect(paddy[0]).toBeGreaterThan(paddy[2]);
    expect(water[2]).toBeGreaterThan(water[0]);
  });
});

describe('Suzuka audio files', () => {
  it('lists the five sounds from the track JSON', () => {
    expect(trackAudioFiles(SUZUKA).sort()).toEqual(
      [
        'sfx/suzuka/autumn_evening_loop.wav',
        'sfx/suzuka/crossover_whoosh.wav',
        'sfx/suzuka/hill_crowd_loop.wav',
        'sfx/suzuka/pa_chime.wav',
        'sfx/suzuka/park_far_loop.wav',
      ].sort(),
    );
  });
});

describe('run-off tint beside the circuit', () => {
  it('is full next to the road, gone far away, and tints the terrain colour towards green', async () => {
    const { runoffShare, suzukaTerrainColor } = await import('../src/world/suzukaLayout');
    expect(runoffShare(8)).toBe(1);
    expect(runoffShare(60)).toBe(0);
    expect(runoffShare(26)).toBeGreaterThan(0.3);
    expect(runoffShare(26)).toBeLessThan(0.7);
    const land = { forest: 0, paddy: 0, built: 1, water: 0 };
    const plain = suzukaTerrainColor(land, 0.5, 0.5, [0, 0, 0], 0);
    const near = suzukaTerrainColor(land, 0.5, 0.5, [0, 0, 0], 1);
    expect(near[1]).toBeGreaterThan(near[0]); // green wins over the concrete grey
    expect(near[1] - near[0]).toBeGreaterThan(plain[1] - plain[0]);
  });
});
