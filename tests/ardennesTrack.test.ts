import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import raw from '../data/tracks/ardennes.json';
import placements from '../data/tracks/ardennes_placements.json';
import terrainMeta from '../data/tracks/ardennes_terrain.json';
import { ARDENNES, RACE, TRACKS, getTrack, roadWidthAt } from '../src/core/Data';
import { ARDENNES_MODELS, ARDENNES_TEXTURES } from '../src/world/Ardennes';
import {
  ExclusionGrid,
  FOREST,
  GROUND_FAR_M,
  GROUND_NEAR_M,
  GroundField,
  HeightField,
  ROAD_DROP_M,
  buildTerrainGrid,
  carvedHeight,
  decodeHeight,
  forestTrees,
  gridBoxSites,
  gridChunks,
  gridNormal,
  groundNoise,
  groundScatter,
  groupByModel,
  hash2,
  inViewWedge,
  placementClearances,
  planBarriers,
  planBridges,
  planPlacements,
  planSigns,
  planStands,
  projectRoad,
  racingLineOffset,
  roadPose,
  terrainBand,
  terrainColor,
  yawFacingDrivers,
  yawTowardsRoad,
  type PlacementData,
  type Pixels,
  type TerrainMeta,
} from '../src/world/ardennesLayout';
import { RoadIndex, curvatureAt, frameAt, yawForX } from '../src/world/monteCarloLayout';
import { TrackPath } from '../src/world/TrackPath';
import { relaxTightBends } from '../src/world/relaxBends';

const meta = terrainMeta as unknown as TerrainMeta;
const data = placements as unknown as PlacementData;

/** Minimal PNG reader (8-bit, non-interlaced, grey / RGB / RGBA) so the real heightmap can be tested without a browser. */
function readPng(file: string): Pixels {
  const buf = readFileSync(file);
  let pos = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      type = body[9];
    } else if (name === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 6: 4 }[type] as number;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8ClampedArray(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = b;
      else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (ch === 1) out.set([line[x], line[x], line[x], 255], o);
      else out.set([line[x * ch], line[x * ch + 1], line[x * ch + 2], ch === 4 ? line[x * ch + 3] : 255], o);
    }
    prev = line;
  }
  return { data: out, width: w, height: h };
}

const path = new TrackPath(
  relaxTightBends(ARDENNES.spline.points, RACE.track.minTurnRadiusM),
  RACE.track.sampleSpacingM,
  RACE.track.projectWindowSamples,
);
const index = new RoadIndex(path, 4);
const field = new HeightField(
  meta,
  readPng('public/assets/textures/spa_terrain_height.png'),
  readPng('public/assets/textures/spa_forest_mask.png'),
  readPng('public/assets/textures/spa_terrain_splat.png'),
);
const ground = new GroundField(field, index);

describe('Ardennes Forest Circuit track data', () => {
  it('is the 6th map: a clockwise daylight forest circuit, 15 m wide, 2 laps, with elevation', () => {
    expect(TRACKS.map((t) => t.id)).toEqual([
      'cat_lai',
      'cong_hoa',
      'xa_lo_ha_noi',
      'pham_van_dong',
      'monte_carlo',
      'ardennes',
    ]);
    expect(getTrack('ardennes')).toBe(ARDENNES);
    expect(ARDENNES.timeOfDay).toBe('day');
    expect(ARDENNES.laps).toBe(2);
    expect(ARDENNES.hasElevation).toBe(true);
    expect(ARDENNES.roadWidthM).toBe(15);
    expect(roadWidthAt(ARDENNES, 0.4)).toBe(15);
    expect(ARDENNES.roadTexture).toBe('textures/spa_road.png');
    expect(ARDENNES.roadTextureRepeatM).toBe(15);
    // The shower is a visual / audio brief: the shared sim must never see a weather block.
    expect(ARDENNES.weather).toBeNull();
  });

  it('carries its daylight lighting with the borrowed day sky gradient', () => {
    const d = ARDENNES.daylight;
    expect(d?.sun.intensity).toBeCloseTo(2.6);
    expect(d?.fog.density).toBeCloseTo(0.0009);
    expect(d?.sky).toBe('textures/day_sky_gradient.png');
  });

  it('has the Eau Rouge and Bus Stop no-fire zones and the light-sequence start', () => {
    expect(ARDENNES.noFireZones.map((z) => z.name)).toEqual(['Eau Rouge – Raidillon', 'Bus Stop']);
    expect(ARDENNES.startLights?.model).toBe('models/props_monaco/start_gantry.glb');
  });

  it('has 8 ordered checkpoints and a 6-slot grid', () => {
    expect(ARDENNES.checkpoints).toHaveLength(8);
    ARDENNES.checkpoints.forEach((c, i) => {
      if (i > 0) expect(c.t).toBeGreaterThan(ARDENNES.checkpoints[i - 1].t);
    });
    expect(ARDENNES.startLine.grid).toHaveLength(6);
  });

  it('lap length matches the spline within 2%', () => {
    expect(Math.abs(path.lengthM - ARDENNES.lapLengthM) / ARDENNES.lapLengthM).toBeLessThan(0.02);
  });

  it('every model and texture it names is on disk and in the lazy-load lists', () => {
    for (const f of ARDENNES_MODELS) expect(existsSync(`public/assets/${f}`), f).toBe(true);
    for (const f of ARDENNES_TEXTURES) expect(existsSync(`public/assets/${f}`), f).toBe(true);
    const { vegetation: _veg, ...rest } = raw;
    void _veg;
    const named = new Set(JSON.stringify(rest).match(/models\/props_(?:spa|monaco)\/[\w]+\.glb/g));
    // (The `vegetation` block names four cone spruces; the game plants two of them plus two card spruces.)
    for (const m of named) expect(ARDENNES_MODELS, m).toContain(m);
    for (const m of Object.values(data.models)) expect(ARDENNES_MODELS, m).toContain(m);
  });
});

describe('heightmap and ground', () => {
  it('decodes the 16-bit R+G height over -30..230 m', () => {
    expect(decodeHeight(0, 0, meta)).toBeCloseTo(-30);
    expect(decodeHeight(255, 255, meta)).toBeCloseTo(230);
    expect(decodeHeight(128, 0, meta)).toBeCloseTo((32768 / 65535) * 260 - 30, 3);
    expect(decodeHeight(1, 0, meta)).toBeCloseTo((256 / 65535) * 260 - 30, 3);
  });

  it('samples a synthetic map bilinearly, row 0 = the north edge, z = -north', () => {
    const w = 4;
    const h = 3;
    const px = (fn: (x: number, y: number) => [number, number]): Pixels => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) d.set([...fn(x, y), 0, 255], (y * w + x) * 4);
      }
      return { data: d, width: w, height: h };
    };
    // Height rises to the east (x) and to the south (row index): R = column * 40, G = 0.
    const mini: TerrainMeta = {
      bounds: { xMin: 0, xMax: 300, nMin: -200, nMax: 200 },
      size: [w, h],
      height: { min: -30, max: 230 },
    };
    const f = new HeightField(
      mini,
      px((x, y) => [x * 40 + y, 0]),
      px((x) => [x * 85, 0]),
    );
    expect(f.heightAt(0, -200)).toBeCloseTo(decodeHeight(0, 0, mini), 4);
    expect(f.heightAt(300, 200)).toBeCloseTo(decodeHeight(3 * 40 + 2, 0, mini), 4);
    // Mid-way between column 1 and 2 on row 0 (north edge, z = -200).
    expect(f.heightAt(150, -200)).toBeCloseTo((decodeHeight(40, 0, mini) + decodeHeight(80, 0, mini)) / 2, 4);
    // The north edge (n = +200) is z = -200: row 0.
    expect(f.heightAt(0, -200)).toBeLessThan(f.heightAt(0, 200));
    expect(f.forestAt(0, 0)).toBeCloseTo(0);
    expect(f.forestAt(300, 0)).toBeCloseTo(255 / 255);
    // Out-of-bounds queries clamp to the edge instead of reading garbage.
    expect(f.heightAt(-5000, -5000)).toBeCloseTo(f.heightAt(0, -200), 4);
  });

  it('the real heightmap spans the circuit: roughly 0..102 m of road sits on terrain within a metre or so', () => {
    const len = path.lengthM;
    for (let s = 0; s < len; s += 150) {
      const f = frameAt(path, s / len);
      const natural = field.heightAt(f.x, f.z);
      expect(natural, `s=${s}`).toBeGreaterThan(f.y - 3.5);
      expect(natural, `s=${s}`).toBeLessThan(f.y + 0.5);
    }
  });

  it('carving: the road drops 0.35 m under the ribbon and blends to the natural land by 52 m', () => {
    expect(ROAD_DROP_M).toBe(0.35);
    expect(carvedHeight(100, 10, 0)).toBeCloseTo(10 - ROAD_DROP_M);
    expect(carvedHeight(100, 10, GROUND_NEAR_M)).toBeCloseTo(10 - ROAD_DROP_M);
    expect(carvedHeight(100, 10, GROUND_FAR_M)).toBeCloseTo(100);
    expect(carvedHeight(100, 10, 200)).toBeCloseTo(100);
    const mid = carvedHeight(100, 10, (GROUND_NEAR_M + GROUND_FAR_M) / 2);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(100);
  });

  it('projectRoad finds the foot of the perpendicular and its height along the centre line', () => {
    const len = path.lengthM;
    for (const t of [0.05, 0.1422, 0.1515, 0.4, 0.75, 0.97]) {
      const f = frameAt(path, t);
      const hit = projectRoad(index, f.x + f.lx * 11, f.z + f.lz * 11, 60);
      expect(hit, `t=${t}`).not.toBeNull();
      expect(hit?.d).toBeGreaterThan(10.5);
      expect(hit?.d).toBeLessThan(11.5);
      expect(Math.abs((hit?.y ?? 0) - f.y)).toBeLessThan(0.6);
      expect(Math.abs((hit?.t ?? 0) - t) * len).toBeLessThan(8);
    }
    expect(projectRoad(index, 5000, 5000, 60)).toBeNull();
  });

  it('the ground under the road is the road height minus 0.35 m, away from it the natural hills', () => {
    const len = path.lengthM;
    for (const t of [0.02, 0.1422, 0.1515, 0.3, 0.66, 0.9]) {
      const f = frameAt(path, t);
      const s = ground.sample(f.x, f.z);
      expect(s.y).toBeLessThan(f.y);
      expect(s.y).toBeGreaterThan(f.y - 0.6);
      expect(s.roadD).toBeLessThan(1);
    }
    const f = frameAt(path, 0.5);
    const far = ground.sample(f.x + f.lx * 200, f.z + f.lz * 200);
    expect(far.roadD).toBe(Infinity);
    expect(far.y).toBeCloseTo(field.heightAt(f.x + f.lx * 200, f.z + f.lz * 200), 6);
    expect(len).toBeGreaterThan(6500);
  });
});

describe('terrain grid, collider band and colours', () => {
  const grid = buildTerrainGrid(ground, 16);

  it('is a ~16 m grid over the whole 4.1 x 2.6 km heightmap', () => {
    expect(grid.cell).toBe(16);
    expect(grid.x0).toBe(meta.bounds.xMin);
    expect(grid.z0).toBe(-meta.bounds.nMax);
    expect(grid.nx).toBe(Math.ceil(4100 / 16) + 1);
    expect(grid.nz).toBe(Math.ceil(2600 / 16) + 1);
    expect(grid.heights).toHaveLength(grid.nx * grid.nz);
    expect(Math.min(...grid.heights)).toBeGreaterThanOrEqual(-30);
    expect(Math.max(...grid.heights)).toBeLessThanOrEqual(230);
  });

  it('chunks tile every cell exactly once', () => {
    const chunks = gridChunks(grid, 64);
    let cells = 0;
    for (const c of chunks) cells += (c.i1 - c.i0) * (c.j1 - c.j0);
    expect(cells).toBe((grid.nx - 1) * (grid.nz - 1));
  });

  it('vertex normals point up and lean downhill', () => {
    const n: [number, number, number] = [0, 0, 0];
    for (const [i, j] of [
      [0, 0],
      [100, 80],
      [grid.nx - 1, grid.nz - 1],
    ]) {
      gridNormal(grid, i, j, n);
      expect(Math.hypot(...n)).toBeCloseTo(1, 5);
      expect(n[1]).toBeGreaterThan(0);
    }
  });

  it('the collider band is a small up-facing mesh hugging the road', () => {
    const band = terrainBand(grid, 36);
    const tris = band.indices.length / 3;
    expect(tris).toBeGreaterThan(3000);
    expect(tris).toBeLessThan(30_000);
    // Light enough to bake into data/colliders/ardennes.json (a few hundred KB).
    expect(band.positions.length).toBeLessThan(40_000 * 3);
    let down = 0;
    for (let k = 0; k < band.indices.length; k += 3) {
      const [a, b, c] = [0, 1, 2].map((q) => band.indices[k + q] * 3);
      const p = band.positions;
      const ux = p[b] - p[a];
      const uy = p[b + 1] - p[a + 1];
      const uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a];
      const vy = p[c + 1] - p[a + 1];
      const vz = p[c + 2] - p[a + 2];
      if (uz * vx - ux * vz <= 0) down++;
      void uy;
      void vy;
    }
    expect(down).toBe(0);
    // Every band vertex is within reach of the road (cell corners up to 36 m + one diagonal).
    for (let k = 0; k < band.positions.length; k += 3) {
      const d = index.nearest(band.positions[k], band.positions[k + 2], 120).d;
      expect(d).toBeLessThan(36 + 16 * 1.5);
    }
    // And it covers the carriageway: a point on the road is inside a band triangle's footprint.
    const f = frameAt(path, 0.1515);
    const i = Math.floor((f.x - grid.x0) / grid.cell);
    const j = Math.floor((f.z - grid.z0) / grid.cell);
    expect(grid.roadD[j * grid.nx + i]).toBeLessThan(36);
  });

  it('splat colours: dark forest floor under the trees, bright verge grass beside the road', () => {
    const lum = (c: number[]): number => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
    const open = terrainColor(0, 0, 0.5, 0.5);
    const forest = terrainColor(1, 0, 0.5, 0.5);
    const verge = terrainColor(1, 1, 0.5, 0.5);
    expect(lum(forest)).toBeLessThan(lum(open) * 0.6);
    expect(lum(verge)).toBeGreaterThan(lum(forest));
    for (const c of [open, forest, verge]) for (const v of c) expect(v).toBeGreaterThanOrEqual(0);
    const [a, b] = groundNoise(123, -456);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(1);
  });
});

describe('forest and scatter', () => {
  const centre = frameAt(path, 0.2);
  const skip = new ExclusionGrid([{ x: centre.x + 90, z: centre.z + 40, r: 40 }]);

  it('hash is deterministic and spread over [0, 1)', () => {
    expect(hash2(3, 4, 5)).toBe(hash2(3, 4, 5));
    expect(hash2(3, 4, 5)).not.toBe(hash2(4, 3, 5));
    const v = Array.from({ length: 2000 }, (_, i) => hash2(i, i * 7, 1));
    expect(Math.min(...v)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...v)).toBeLessThan(1);
    expect(v.reduce((a, b) => a + b, 0) / v.length).toBeGreaterThan(0.45);
    expect(v.reduce((a, b) => a + b, 0) / v.length).toBeLessThan(0.55);
  });

  it('plants trees only on the forest mask, off the road and clear of the exclusions', () => {
    const trees = forestTrees(ground, skip, centre.x, centre.z, 0, 300);
    expect(trees.length).toBeGreaterThan(300);
    const s = { y: 0, roadD: 0 };
    for (const t of trees) {
      expect(field.forestAt(t.x, t.z)).toBeGreaterThanOrEqual(FOREST.maskMin);
      ground.sample(t.x, t.z, s);
      expect(s.roadD).toBeGreaterThanOrEqual(FOREST.roadClearM);
      expect(skip.hit(t.x, t.z)).toBe(false);
      expect(Math.hypot(t.x - centre.x, t.z - centre.z)).toBeLessThanOrEqual(300);
      expect(t.scale).toBeGreaterThanOrEqual(0.8);
      expect(t.scale).toBeLessThanOrEqual(1.25);
      expect(t.variant).toBeGreaterThanOrEqual(0);
      expect(t.variant).toBeLessThan(FOREST.variants);
      expect(t.tint[0]).toBeGreaterThanOrEqual(0.24);
      expect(t.tint[0]).toBeLessThanOrEqual(0.3);
      expect(t.tint[1]).toBeGreaterThanOrEqual(0.25);
      expect(t.tint[1]).toBeLessThanOrEqual(0.55);
      expect(t.tint[2]).toBeGreaterThanOrEqual(0.42);
      expect(t.tint[2]).toBeLessThanOrEqual(0.64);
    }
  });

  it('is a pure function of the cell grid: re-centring does not reshuffle the forest', () => {
    const a = forestTrees(ground, skip, centre.x, centre.z, 0, 200);
    const b = forestTrees(ground, skip, centre.x + 60, centre.z + 20, 0, 200);
    const key = (t: { x: number; z: number }): string => `${t.x.toFixed(3)},${t.z.toFixed(3)}`;
    const inB = new Set(b.map(key));
    // Trees of `a` that also lie within `b`'s circle are the very same trees.
    const shared = a.filter((t) => Math.hypot(t.x - centre.x - 60, t.z - centre.z - 20) <= 200);
    expect(shared.length).toBeGreaterThan(50);
    for (const t of shared) expect(inB.has(key(t))).toBe(true);
  });

  it('rings split cleanly: inner + outer = the whole disc, and a finer cell gives more trees', () => {
    const whole = forestTrees(ground, null, centre.x, centre.z, 0, 250);
    const inner = forestTrees(ground, null, centre.x, centre.z, 0, 120);
    const outer = forestTrees(ground, null, centre.x, centre.z, 120, 250);
    expect(inner.length + outer.length).toBe(whole.length);
    const sparse = forestTrees(ground, null, centre.x, centre.z, 0, 250, { ...FOREST, cellM: 14 });
    expect(sparse.length).toBeLessThan(whole.length * 0.6);
  });

  it('density is about one tree per 80-100 m2 inside the forest', () => {
    // Find a forest patch: count trees per forest-mask area.
    const trees = forestTrees(ground, null, centre.x, centre.z, 0, 400);
    let forestCells = 0;
    for (let x = -400; x <= 400; x += 10) {
      for (let z = -400; z <= 400; z += 10) {
        if (x * x + z * z <= 160_000 && field.forestAt(centre.x + x, centre.z + z) >= 0.5) forestCells++;
      }
    }
    // Rough: forest area minus the road corridor; trees / area within a factor of ~2 of 0.85 / 81.
    const perM2 = trees.length / (forestCells * 100);
    expect(perM2).toBeGreaterThan(0.85 / 81 / 2.2);
    expect(perM2).toBeLessThan(1 / 70);
  });

  it('ground scatter stays more than 10 m from the road and is sparse in the forest', () => {
    const items = groundScatter(ground, null, centre.x, centre.z, 150, 5.5);
    expect(items.length).toBeGreaterThan(200);
    const s = { y: 0, roadD: 0 };
    for (const it of items) {
      ground.sample(it.x, it.z, s);
      expect(s.roadD).toBeGreaterThanOrEqual(10);
      expect([0, 1, 2]).toContain(it.kind);
    }
    expect(items.filter((i) => i.kind === 2).length).toBeLessThan(items.length * 0.1);
  });

  it('view wedge keeps the near disc and what lies ahead, drops what is behind', () => {
    expect(inViewWedge(10, 0, 0, 1, Math.cos(1.2), 30)).toBe(true); // near: always
    expect(inViewWedge(0, 100, 0, 1, Math.cos(1.2), 30)).toBe(true); // dead ahead
    expect(inViewWedge(0, -100, 0, 1, Math.cos(1.2), 30)).toBe(false); // behind
    expect(inViewWedge(100, 5, 0, 1, Math.cos(1.2), 30)).toBe(false); // off to the side, outside +-68 deg
    expect(inViewWedge(60, 100, 0, 1, Math.cos(1.2), 30)).toBe(true); // inside the wedge
  });

  it('the exclusion grid finds points inside a footprint only', () => {
    const g = new ExclusionGrid([{ x: 100, z: 100, r: 20 }]);
    expect(g.hit(110, 100)).toBe(true);
    expect(g.hit(100, 125)).toBe(false);
    expect(g.hit(-500, 40)).toBe(false);
  });
});

describe('placements', () => {
  const items = planPlacements(data, ground, (t) => frameAt(path, t).y);

  it('resolves all 2193 objects of the 10 groups to a GLB and a world pose', () => {
    expect(items).toHaveLength(2193);
    expect(new Set(items.map((i) => i.group)).size).toBe(10);
    for (const it of items) {
      expect(it.model).toMatch(/^models\/props_spa\/.+\.glb$/);
      expect(Number.isFinite(it.y)).toBe(true);
      expect(it.scale).toBeGreaterThan(0);
    }
  });

  it('kerbs sit at the road height at their t (the road ribbon rides 3 cm above the centre line)', () => {
    const kerbs = items.filter((i) => i.group === 'kerbs');
    expect(kerbs).toHaveLength(442);
    const rows = data.groups.kerbs;
    rows.slice(0, 40).forEach((r, k) => {
      expect(kerbs[k].y).toBeCloseTo(frameAt(path, r.t as number).y, 5);
    });
  });

  it('other objects stand on the carved ground; the culvert dips 0.6 m under the road', () => {
    const church = items.find((i) => i.model.endsWith('village_church.glb'));
    expect(church).toBeDefined();
    expect(church?.y).toBeCloseTo(ground.heightAt(church?.x ?? 0, church?.z ?? 0) - 0.05, 5);
    const culvert = items.find((i) => i.model.endsWith('brook_culvert.glb'));
    const row = data.groups.landmarks.find((r) => r.model === 'culvert');
    expect(culvert?.y).toBeCloseTo(frameAt(path, row?.t as number).y - 0.6, 5);
  });

  it('groups by GLB with the widest window of the groups using it', () => {
    const by = groupByModel(items);
    const win = (m: string): number[] => by.filter((e) => e.model.endsWith(m)).map((e) => e.windowM);
    expect(win('grass_patch_a.glb')).toEqual([150]);
    expect(win('kerb_3d_4m.glb')).toEqual([450]);
    expect(win('village_church.glb')).toEqual([900]);
    // Crowds (3,000+ triangles a group) are capped at 160 m wherever they are placed (paddock 700, crowd 160).
    expect(win('spectators_a.glb').every((w) => w <= 160)).toBe(true);
    // Props shared by two groups with different windows get one set per window.
    expect(new Set(by.map((e) => `${e.model}|${e.windowM}`)).size).toBe(by.length);
    let n = 0;
    for (const e of by) n += e.items.length;
    expect(n).toBe(items.length);
  });

  it('keeps the forest clear of the villages, paddock and campsite', () => {
    const clear = placementClearances(items);
    expect(clear.length).toBeGreaterThan(100);
    expect(clear.every((c) => c.r >= 8)).toBe(true);
    expect(items.some((i) => i.group === 'kerbs')).toBe(true);
    expect(clear.length).toBeLessThan(items.length);
  });
});

describe('barriers, signs, bridges and stands', () => {
  const len = path.lengthM;
  const crowd = data.groups.crowd.map((r) => ({ x: r.x, z: r.z, r: 30 }));
  const plan = planBarriers(path, ARDENNES, crowd);
  const armcoLat = (raw.barriers as { armco: { lateralM: number } }).armco.lateralM;

  it('lines both sides of the lap with Armco every 4 m at the lateral the wall colliders expect', () => {
    const perSide = Math.floor(len / 4);
    const gaps = plan.tyres.length + plan.tecpro.length;
    expect(plan.armco.length).toBeGreaterThan(perSide * 2 - gaps - 10);
    expect(plan.armco.length).toBeLessThanOrEqual(perSide * 2);
    for (const p of plan.armco.slice(0, 200)) {
      const { i, d } = index.nearest(p.x, p.z, 60);
      expect(i).toBeGreaterThanOrEqual(0);
      // A 4 m chord of a bend sits a touch inside the arc: allow a few cm either way.
      expect(Math.abs(d - armcoLat)).toBeLessThan(0.3);
    }
    // The wall collider stands at lateralM - 0.2 from the line plus the road half width: the Armco face is flush.
    const wallFromCentre = roadWidthAt(ARDENNES, 0) / 2 + (armcoLat - 0.2 - roadWidthAt(ARDENNES, 0) / 2);
    expect(wallFromCentre).toBeCloseTo(armcoLat - 0.2);
  });

  it('every fourth Armco piece carries one of the four sponsor panels, evenly', () => {
    const ads = plan.armco.filter((p) => p.ad >= 0);
    expect(ads.length).toBeGreaterThan(plan.armco.length / 5);
    expect(ads.length).toBeLessThan(plan.armco.length / 3);
    for (let k = 0; k < 4; k++) expect(ads.filter((p) => p.ad === k).length).toBeGreaterThan(ads.length / 6);
    expect(Math.max(...ads.map((p) => p.ad))).toBe(3);
  });

  it('puts 4 tyre walls of 8 pieces and tecpro on the outside of the named corners', () => {
    expect(plan.tyres).toHaveLength(32);
    expect(plan.tecpro.length).toBeGreaterThan(40);
    // La Source is a right hairpin: its tecpro is on the LEFT (outside), 19.3 + 0.9 m from the line.
    const t1 = (raw.corners as { name: string; t: number }[]).find((c) => c.name === 'La Source') as { t: number };
    const apex = frameAt(path, t1.t);
    const near = plan.tecpro.filter((p) => Math.hypot(p.x - apex.x, p.z - apex.z) < 30);
    expect(near.length).toBeGreaterThan(5);
    for (const p of near) {
      const { i } = index.nearest(p.x, p.z, 60);
      expect(index.lateral(i, p.x, p.z)).toBeGreaterThan(0); // + = left of the driving direction
    }
  });

  it('no Armco where a tecpro wall or tyre stack already is', () => {
    for (const w of [...plan.tecpro, ...plan.tyres].slice(0, 60)) {
      const clash = plan.armco.some((a) => Math.hypot(a.x - w.x, a.z - w.z) < 1.5);
      expect(clash).toBe(false);
    }
  });

  it('catch fence only stands near the spectators', () => {
    expect(plan.fence.length).toBeGreaterThan(20);
    for (const f of plan.fence) expect(crowd.some((c) => Math.hypot(c.x - f.x, c.z - f.z) < c.r + 1)).toBe(true);
    const none = planBarriers(path, ARDENNES, []);
    expect(none.fence).toHaveLength(0);
  });

  it('pieces face the road: local +X points at the centre line', () => {
    for (const p of plan.armco.slice(0, 50)) {
      const { i } = index.nearest(p.x, p.z, 60);
      const want = yawForX(index.xs[i] - p.x, index.zs[i] - p.z);
      expect(Math.abs(Math.atan2(Math.sin(p.yaw - want), Math.cos(p.yaw - want)))).toBeLessThan(0.12);
    }
  });

  it('plans 6 corner signs, 12 distance boards and the 2 big screens', () => {
    const signs = planSigns(path, ARDENNES);
    expect(signs).toHaveLength(20);
    expect(signs.filter((s) => /corner_sign_/.test(s.model))).toHaveLength(6);
    expect(signs.filter((s) => /distance_board_/.test(s.model))).toHaveLength(12);
    expect(signs.filter((s) => /big_screen/.test(s.model))).toHaveLength(2);
    // Signs left of the line (negative lateralM = ... the JSON counts + as right): La Source's board is 13.5 m LEFT.
    const la = signs.find((s) => s.model.endsWith('corner_sign_la_source.glb')) as { x: number; z: number };
    const { i, d } = index.nearest(la.x, la.z, 60);
    expect(d).toBeGreaterThan(13);
    expect(d).toBeLessThan(14);
    expect(index.lateral(i, la.x, la.z)).toBeGreaterThan(0);
  });

  it('distance boards come 100 / 200 / 300 m before their corner', () => {
    const signs = planSigns(path, ARDENNES);
    const b300 = signs.find((s) => s.model.endsWith('distance_board_300.glb')) as { x: number; z: number };
    const b100 = signs.find((s) => s.model.endsWith('distance_board_100.glb')) as { x: number; z: number };
    // Both are on the same side, and the 300 board is further from the La Source apex than the 100 board.
    const apex = frameAt(path, (raw.corners as { name: string; t: number }[])[0].t);
    expect(Math.hypot(b300.x - apex.x, b300.z - apex.z)).toBeGreaterThan(Math.hypot(b100.x - apex.x, b100.z - apex.z));
  });

  it('two footbridges span the carriageway from 15 m left to 19 m right of the line', () => {
    const bridges = planBridges(path, ARDENNES);
    expect(bridges).toHaveLength(2);
    for (const b of bridges) {
      const { i, d } = index.nearest(b.x, b.z, 60);
      expect(d).toBeGreaterThan(14);
      expect(d).toBeLessThan(16);
      // Origin on the RIGHT (negative lateral), local +X (the 4 m end) pointing further right: away from the line.
      expect(index.lateral(i, b.x, b.z)).toBeLessThan(0);
      const ax = Math.cos(b.yaw);
      const az = -Math.sin(b.yaw);
      const away = ax * (b.x - index.xs[i]) + az * (b.z - index.zs[i]);
      expect(away).toBeGreaterThan(0);
    }
  });

  it('stands are pushed clear of the Armco line and face the road', () => {
    const stands = planStands(ARDENNES, index, 22);
    const listed = (raw.grandstands as { segments: unknown[] }[]).reduce((n, g) => n + g.segments.length, 0);
    expect(stands.length).toBeGreaterThan(listed * 0.7);
    for (const s of stands) {
      expect(index.nearest(s.x, s.z, 300).d).toBeGreaterThan(21);
      expect(Math.abs(yawTowardsRoad(index, s.x, s.z) - s.yaw)).toBeLessThan(1e-6);
    }
  });

  it('road poses: positive latRight is to the right of travel; drivers face the sign', () => {
    const left = roadPose(path, 0.3, -10);
    const right = roadPose(path, 0.3, 10);
    const { i } = index.nearest(right.x, right.z, 60);
    expect(index.lateral(i, right.x, right.z)).toBeLessThan(0);
    expect(index.lateral(i, left.x, left.z)).toBeGreaterThan(0);
    const yaw = yawFacingDrivers(right);
    // +X of the model (cos yaw, -sin yaw) runs against the direction of travel.
    expect(Math.cos(yaw) * right.tx - Math.sin(yaw) * right.tz).toBeLessThan(-0.99);
  });
});

describe('road paint', () => {
  it('the racing line drifts to the outside of a bend, within 4.2 m', () => {
    const len = path.lengthM;
    // Before a left-hander (La Source is a right hairpin at 0.0583) the line leans left (+) on the way in.
    let min = 0;
    let max = 0;
    for (let s = 0; s < len; s += 10) {
      const o = racingLineOffset(path, s);
      min = Math.min(min, o);
      max = Math.max(max, o);
      expect(Math.abs(o)).toBeLessThanOrEqual(4.2 + 1e-9);
    }
    expect(min).toBeLessThan(-3);
    expect(max).toBeGreaterThan(3);
    const s = 0.0583 * len - 20;
    expect(Math.sign(racingLineOffset(path, s))).toBe(-Math.sign(curvatureAt(path, s + 20)));
  });

  it('20 grid boxes 8 m apart, staggered +-2.4 m, matching the first grid slots', () => {
    const boxes = gridBoxSites();
    expect(boxes).toHaveLength(20);
    expect(boxes[1].behindM - boxes[0].behindM).toBe(8);
    ARDENNES.startLine.grid.forEach(([lateral, behind], k) => {
      expect(boxes[k].lateralM).toBeCloseTo(lateral);
      expect(boxes[k].behindM).toBeCloseTo(Math.abs(behind));
    });
  });
});
