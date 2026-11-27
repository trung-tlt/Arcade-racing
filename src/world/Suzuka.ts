import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { Assets } from '../core/Assets';
import { RACE, roadWidthAt, type TrackDef } from '../core/Data';
import terrainJson from '../../data/tracks/suzuka_terrain.json';
import {
  GroundField,
  HeightField,
  PAINT,
  buildTerrainGrid,
  gridChunks,
  gridNormal,
  groundNoise,
  projectRoad,
  racingLineOffset,
  GROUND_FAR_M,
  ROAD_DROP_M,
  type GroundSample,
  type TerrainGrid,
  type TerrainMeta,
} from './ardennesLayout';
import { InstancePool, readPixels } from './instancing';
import { StartGantry } from './MonteCarlo';
import { RoadIndex, frameAt } from './monteCarloLayout';
import {
  ItemGrid,
  planPlacements,
  selectWindow,
  suzukaTerrainColor,
  windowFor,
  type Item,
  type SuzukaPlacements,
  type View,
  type WindowCfg,
} from './suzukaLayout';
import { buildSurroundings, type Osm, type Surroundings } from './suzukaSurroundings';
import type { TrackPath } from './TrackPath';

type Rapier = typeof RAPIER;
type Quality = 'low' | 'med' | 'high';

const TERRAIN_META = terrainJson as unknown as TerrainMeta;
const GANTRY = 'models/props_monaco/start_gantry.glb';

/** The big data files are fetched the first time the map is raced (the placements alone are 2.6 MB). */
export interface SuzukaData {
  placements: SuzukaPlacements;
  osm: Osm;
}
let DATA: SuzukaData | null = null;

export async function loadSuzukaData(base = '/assets/tracks/'): Promise<SuzukaData> {
  if (DATA) return DATA;
  const get = async <T>(name: string): Promise<T> => {
    const res = await fetch(`${base}${name}`);
    if (!res.ok) throw new Error(`Suzuka data not loaded: ${name} (${res.status})`);
    return (await res.json()) as T;
  };
  const [placements, osm] = await Promise.all([
    get<SuzukaPlacements>('suzuka_hills_placements.json'),
    get<Osm>('suzuka_hills_osm.json'),
  ]);
  DATA = { placements, osm };
  return DATA;
}

/** The placements the audio needs (stand and wheel positions); the data must be loaded. */
export function suzukaPlacements(): SuzukaPlacements {
  if (!DATA) throw new Error('Suzuka data not loaded');
  return DATA.placements;
}

/** For tests and tools that already hold the data. */
export function setSuzukaData(d: SuzukaData): void {
  DATA = d;
}

/** Every GLB the map draws (placements, the start gantry), relative to /assets/. */
export function suzukaModels(data: SuzukaData): string[] {
  const out = new Set<string>([GANTRY]);
  for (const rows of Object.values(data.placements.groups)) for (const r of rows) out.add(r.model);
  return [...out];
}

/** Standalone textures (everything else is embedded in the GLBs). */
export const SUZUKA_TEXTURES: string[] = [
  'textures/spa_road.png',
  'textures/spa_markings.png',
  'textures/spa_kerb.png',
  'textures/suzuka_terrain_height.png',
  'textures/suzuka_landcover.png',
  'textures/suzuka_grass.png',
  'textures/suzuka_mountains.png',
];

/** Within this distance (m) of a road the ground is a flat shelf 0.35 m under it; it blends to the hills by `GROUND_FAR_M`. */
const SHELF_M = 24;
/** The road is looked for in the 3x3 cells around a point (cell size m; covers `GROUND_FAR_M`). */
const ROAD_CELL_M = 64;
/**
 * Around the crossover the two legs lie 8.5 m apart in height over the same ground, so there (and only there) a height
 * gap counts this many times as much as a plan distance when picking the road leg. Everywhere else the nearest road in
 * plan is the right one, even where a hillside road lies above or below.
 */
const HEIGHT_WEIGHT = 3;
const CROSSOVER_ZONE_M = 110;
const smoothstep = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * The land: a flat shelf under the road (so the coarse grid never makes a lip or bank at the road's edge, which a fast
 * car would take off from) blending out to the heightmap's hills. The road leg is picked by height as well as plan
 * distance, so the lower road of the crossover is not lifted to the bridge deck.
 */
class SuzukaGround extends GroundField {
  private readonly cells = new Map<number, number[]>();

  constructor(
    height: HeightField,
    index: RoadIndex,
    /** The crossover's world x and z. */
    private readonly crossing: readonly [number, number] | null,
  ) {
    super(height, index);
    for (let i = 0; i < index.count; i++) {
      const k = this.key(Math.floor(index.xs[i] / ROAD_CELL_M), Math.floor(index.zs[i] / ROAD_CELL_M));
      const list = this.cells.get(k);
      if (list) list.push(i);
      else this.cells.set(k, [i]);
    }
  }

  private key(cx: number, cz: number): number {
    return (cx + 1024) * 4096 + (cz + 1024);
  }

  override sample(x: number, z: number, out: GroundSample = { y: 0, roadD: Infinity }): GroundSample {
    const natural = this.height.heightAt(x, z);
    const { xs, zs, ys } = this.index;
    const cx = Math.floor(x / ROAD_CELL_M);
    const cz = Math.floor(z / ROAD_CELL_M);
    const wy =
      this.crossing && Math.hypot(x - this.crossing[0], z - this.crossing[1]) < CROSSOVER_ZONE_M ? HEIGHT_WEIGHT : 0;
    let best = Infinity;
    let bestD = Infinity;
    let bestY = 0;
    for (let j = cz - 1; j <= cz + 1; j++) {
      for (let i = cx - 1; i <= cx + 1; i++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (const s of list) {
          const dx = x - xs[s];
          const dz = z - zs[s];
          const dy = (ys[s] - natural) * wy;
          const score = dx * dx + dz * dz + dy * dy;
          if (score < best) {
            best = score;
            bestD = Math.hypot(dx, dz);
            bestY = ys[s];
          }
        }
      }
    }
    if (bestD > GROUND_FAR_M) {
      out.roadD = Infinity;
      out.y = natural;
      return out;
    }
    out.roadD = bestD;
    const k = smoothstep(SHELF_M, GROUND_FAR_M, bestD);
    out.y = (bestY - ROAD_DROP_M) * (1 - k) + natural * k;
    return out;
  }
}

/** Per quality preset: the share of the view distances and caps that is drawn. */
const DETAIL = { low: 0.6, med: 0.85, high: 1 } as const;
/** A model's window is refilled when the camera has moved this far (m) or turned this much (radians). */
const MOVE_M = 15;
const TURN_RAD = (6 * Math.PI) / 180;
const TERRAIN_CELL_M = 16;
const SKY_SCALE = 1000;
/**
 * The brightest value the sky may output (before tone mapping): the Sky shader's sun glow is far above 1, which bloomed
 * into a white-out (and a black hole where the bloom overflowed) whenever the road pointed at the low sun.
 */
const SKY_MAX = 1.8;

/** Caps the sky shader's output so the sun is a bright spot, not a veil over the whole screen. */
function clampSky(sky: Sky): void {
  sky.material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      `gl_FragColor = vec4( min( texColor, vec3( ${SKY_MAX.toFixed(2)} ) ), 1.0 );`,
    );
  };
  sky.material.needsUpdate = true;
}
/** The sky's share of the ambient light: the design render's full-strength environment is too bright at exposure 0.62 here. */
const ENV_INTENSITY = 0.3;
const MOUNTAIN_RADIUS_M = 1300;

interface Windowed {
  grid: ItemGrid;
  cfg: WindowCfg;
  pool: InstancePool;
}

/**
 * Suzuka Hills Circuit (Map 7): the heightmap terrain and its collider, a physical sky and the mountain band, kerbs and
 * paint, the OpenStreetMap surroundings, and ~27,000 placed props drawn in a window around the camera.
 */
export class Suzuka {
  readonly group = new THREE.Group();
  readonly gantry: StartGantry;
  readonly ground: SuzukaGround;
  readonly grid: TerrainGrid;
  private readonly index: RoadIndex;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly windows: Windowed[] = [];
  private readonly sky: Sky;
  private readonly mountains: THREE.Mesh;
  private surroundings: Surroundings | null = null;
  private lastView: { x: number; z: number; yaw: number } | null = null;
  private readonly scratch: number[] = [];
  private readonly dir = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    _R: Rapier,
    _world: RAPIER.World,
    private readonly assets: Assets,
    private readonly def: TrackDef,
    private readonly path: TrackPath,
    private readonly opts: { camera: THREE.Camera; quality: Quality; renderer?: THREE.WebGLRenderer },
  ) {
    if (!DATA) throw new Error('Suzuka data not loaded: call loadSuzukaData() first');
    this.group.name = 'suzuka';
    this.index = new RoadIndex(path, 4);
    const field = new HeightField(
      TERRAIN_META,
      readPixels(assets.texture('textures/suzuka_terrain_height.png')),
      readPixels(assets.texture('textures/suzuka_landcover.png')),
    );
    const bridge = (def.raw.crossover as { bridge?: { position: [number, number, number] } } | undefined)?.bridge;
    this.ground = new SuzukaGround(field, this.index, bridge ? [bridge.position[0], bridge.position[2]] : null);
    this.grid = buildTerrainGrid(this.ground, TERRAIN_CELL_M);
    this.group.add(this.buildTerrain());

    this.sky = this.buildSky();
    this.buildEnvironment();
    this.mountains = this.buildMountains();
    this.buildPaint();
    this.buildKerbs();
    this.surroundings = buildSurroundings(DATA.osm, {
      heightAt: (x, z) => field.heightAt(x, z),
      trackDistance: (x, z) => projectRoad(this.index, x, z, 60)?.d ?? Infinity,
      bounds: {
        xMin: TERRAIN_META.bounds.xMin,
        xMax: TERRAIN_META.bounds.xMax,
        zMin: -TERRAIN_META.bounds.nMax,
        zMax: -TERRAIN_META.bounds.nMin,
      },
    });
    this.group.add(this.surroundings.group);
    this.buildPlaced(DATA.placements);
    this.gantry = new StartGantry(assets, path, this.group, this.def.startLine ? this.startT() : 0, GANTRY);
    scene.add(this.group);
  }

  private startT(): number {
    return (this.def.raw.startLine as { t?: number } | undefined)?.t ?? 0;
  }

  // ------------------------------------------------------------------------------------------------ terrain

  private buildTerrain(): THREE.Group {
    const out = new THREE.Group();
    out.name = 'terrain';
    const g = this.grid;
    const field = this.ground.height;
    const tex = this.assets.texture('textures/suzuka_grass.png');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.95, metalness: 0 });
    this.disposables.push(mat);
    const c = new THREE.Color();
    const rgb: [number, number, number] = [0, 0, 0];
    const nrm: [number, number, number] = [0, 1, 0];
    const TILE_M = 10;
    for (const ch of gridChunks(g, 64)) {
      const w = ch.i1 - ch.i0 + 1;
      const h = ch.j1 - ch.j0 + 1;
      const pos = new Float32Array(w * h * 3);
      const nor = new Float32Array(w * h * 3);
      const col = new Float32Array(w * h * 3);
      const uv = new Float32Array(w * h * 2);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const gi = ch.i0 + i;
          const gj = ch.j0 + j;
          const x = g.x0 + gi * g.cell;
          const z = g.z0 + gj * g.cell;
          const k = j * w + i;
          pos.set([x, g.heights[gj * g.nx + gi], z], k * 3);
          gridNormal(g, gi, gj, nrm);
          nor.set(nrm, k * 3);
          const [na, nb] = groundNoise(x, z);
          suzukaTerrainColor(
            {
              forest: field.channelAt(x, z, 0),
              paddy: field.channelAt(x, z, 1),
              built: field.channelAt(x, z, 2),
              water: 1 - field.channelAt(x, z, 3),
            },
            na,
            nb,
            rgb,
          );
          c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
          col.set([c.r, c.g, c.b], k * 3);
          uv.set([x / TILE_M, z / TILE_M], k * 2);
        }
      }
      const idx = new Uint32Array((w - 1) * (h - 1) * 6);
      let n = 0;
      for (let j = 0; j < h - 1; j++) {
        for (let i = 0; i < w - 1; i++) {
          const a = j * w + i;
          idx.set([a, a + w, a + 1, a + 1, a + w, a + w + 1], n);
          n += 6;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `terrain_${ch.i0}_${ch.j0}`;
      mesh.receiveShadow = true;
      out.add(mesh);
      this.disposables.push(geo);
    }
    // Under the whole world: nothing shows through beyond the heightmap's edge.
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(16000, 16000),
      new THREE.MeshBasicMaterial({ color: '#6E6A3E', fog: true }),
    );
    base.rotation.x = -Math.PI / 2;
    base.position.set(-300, TERRAIN_META.height.min - 6, 150);
    base.name = 'terrain_base';
    out.add(base);
    this.disposables.push(base.geometry, base.material as THREE.Material);
    return out;
  }

  // ------------------------------------------------------------------------------------------------ sky

  /** The physical sky (low west-south-west sun), drawn at the far plane around the camera. */
  private buildSky(): Sky {
    const sky = new Sky();
    clampSky(sky);
    sky.scale.setScalar(SKY_SCALE);
    sky.frustumCulled = false;
    sky.name = 'sky';
    const lighting = this.def.raw.lighting as {
      sky: { turbidity: number; rayleigh: number; mie: number; mieG: number };
    };
    const u = sky.material.uniforms;
    u.turbidity.value = lighting.sky.turbidity;
    u.rayleigh.value = lighting.sky.rayleigh;
    u.mieCoefficient.value = lighting.sky.mie;
    u.mieDirectionalG.value = lighting.sky.mieG;
    // The sun sits opposite to the direction its light travels (the same one the directional light uses).
    const dir = this.def.daylight?.sun.dir ?? [0, -1, 0];
    u.sunPosition.value.set(-dir[0], -dir[1], -dir[2]);
    this.scene.background = new THREE.Color(this.def.daylight?.fog.color ?? '#D9BFA0');
    this.group.add(sky);
    this.disposables.push(sky.geometry, sky.material);
    return sky;
  }

  /** The sky as an environment map: the soft ambient and sheen the low sun alone does not give. */
  private buildEnvironment(): void {
    const renderer = this.opts.renderer;
    if (!renderer) return;
    const pm = new THREE.PMREMGenerator(renderer);
    const env = new THREE.Scene();
    const copy = new Sky();
    clampSky(copy);
    copy.scale.setScalar(SKY_SCALE);
    for (const k of Object.keys(this.sky.material.uniforms)) {
      const src = this.sky.material.uniforms[k].value as { copy?: (v: unknown) => void } | number;
      const dst = copy.material.uniforms[k];
      if (typeof src === 'object' && src && 'copy' in src && typeof dst.value?.copy === 'function') dst.value.copy(src);
      else dst.value = src;
    }
    env.add(copy);
    const rt = pm.fromScene(env);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = ENV_INTENSITY;
    this.disposables.push(rt, pm, copy.geometry, copy.material);
  }

  /** The Suzuka range as a panorama band at the horizon, following the camera (the view distance is 1.5 km). */
  private buildMountains(): THREE.Mesh {
    const tex = this.assets.texture('textures/suzuka_mountains.png');
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(2, 1);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const geo = new THREE.CylinderGeometry(MOUNTAIN_RADIUS_M, MOUNTAIN_RADIUS_M, 180, 96, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      color: '#E0CDB8',
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'mountains';
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
    return mesh;
  }

  // ------------------------------------------------------------------------------------------------ road paint

  /** A triangle-strip mesh over the path samples: lateral range `range(i, t)` (+ = left), `lift` above the road. */
  private strip(range: (i: number, t: number) => [number, number] | null, lift: number): THREE.BufferGeometry {
    const { path } = this;
    const n = path.count;
    const pos: number[] = [];
    const idx: number[] = [];
    let prev = -1;
    for (let r = 0; r <= n; r++) {
      const i = r % n;
      const lat = range(i, i / n);
      if (!lat) {
        prev = -1;
        continue;
      }
      const lx = path.tz[i];
      const lz = -path.tx[i];
      const y = path.py[i] + RACE.track.roadY + lift;
      const k = pos.length / 6;
      pos.push(
        path.px[i] + lx * lat[0],
        y,
        path.pz[i] + lz * lat[0],
        path.px[i] + lx * lat[1],
        y,
        path.pz[i] + lz * lat[1],
      );
      if (prev >= 0) idx.push(prev * 2, prev * 2 + 1, k * 2, prev * 2 + 1, k * 2 + 1, k * 2);
      prev = k;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /** White edge lines, the rubbered racing line, the chequered start band and the grid boxes. */
  private buildPaint(): void {
    const { edgeLine } = PAINT;
    const half = (t: number): number => roadWidthAt(this.def, t) / 2;
    const right = this.strip(
      (_i, t) => [half(t) - edgeLine.insetM - edgeLine.widthM, half(t) - edgeLine.insetM],
      0.012,
    );
    const left = this.strip(
      (_i, t) => [-(half(t) - edgeLine.insetM), -(half(t) - edgeLine.insetM - edgeLine.widthM)],
      0.012,
    );
    const white = new THREE.MeshStandardMaterial({
      color: '#EDEDE6',
      roughness: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const rubber = new THREE.MeshBasicMaterial({
      color: '#000000',
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      fog: true,
    });
    const line = this.strip((_i, t) => {
      const mid = racingLineOffset(this.path, t * this.path.lengthM);
      return [mid - 1.1, mid + 1.1];
    }, 0.008);
    for (const [geo, mat, name] of [
      [right, white, 'edge_right'],
      [left, white, 'edge_left'],
      [line, rubber, 'racing_line'],
    ] as const) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.disposables.push(geo);
    }
    this.disposables.push(white, rubber);

    // Markings atlas: grid box u 0.02-0.23, chequered band u 0.25-0.5 (v measured from the bottom).
    const atlas = this.assets.texture('textures/spa_markings.png');
    atlas.anisotropy = 8;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const quad = (
      t: number,
      lat: number,
      w: number,
      l: number,
      u0: number,
      v0: number,
      u1: number,
      v1: number,
    ): void => {
      const f = frameAt(this.path, ((t % 1) + 1) % 1);
      const cx = f.x + f.lx * lat;
      const cz = f.z + f.lz * lat;
      const y = f.y + RACE.track.roadY + 0.02;
      const k = pos.length / 3;
      for (const [sl, sf, u, v] of [
        [-1, -1, u0, v0],
        [1, -1, u1, v0],
        [1, 1, u1, v1],
        [-1, 1, u0, v1],
      ] as const) {
        pos.push(cx + f.lx * sl * (w / 2) + f.tx * sf * (l / 2), y, cz + f.lz * sl * (w / 2) + f.tz * sf * (l / 2));
        uv.push(u, v);
      }
      idx.push(k, k + 2, k + 1, k, k + 3, k + 2);
    };
    const len = this.path.lengthM;
    const t0 = this.startT();
    quad(t0, 0, roadWidthAt(this.def, t0), PAINT.chequerM, 0.25, 0.25, 0.5, 0.75);
    for (const [lat, behind] of this.def.startLine.grid) {
      // Grid entries are `[lateral (+ = the car's left), metres behind the line (negative)]`.
      quad(t0 + behind / len, lat, PAINT.gridBoxes.widthM, PAINT.gridBoxes.lengthM, 0.02, 0.25, 0.23, 0.75);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: atlas,
      transparent: true,
      roughness: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'start_markings';
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  /** The red-white kerbs from the track JSON (`road.kerbs.segments`: `t` of each 4 m piece, `side` +1 = right of travel). */
  private buildKerbs(): void {
    const kerbs = (this.def.raw.road as { kerbs?: { widthM: number; segments: { t: number; side: number }[] } }).kerbs;
    if (!kerbs || kerbs.segments.length === 0) return;
    const len = this.path.lengthM;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const halfT = 2.1 / len;
    for (const seg of kerbs.segments) {
      const t0 = seg.t - halfT;
      const t1 = seg.t + halfT;
      const f0 = frameAt(this.path, ((t0 % 1) + 1) % 1);
      const f1 = frameAt(this.path, ((t1 % 1) + 1) % 1);
      const w0 = roadWidthAt(this.def, t0) / 2;
      const w1 = roadWidthAt(this.def, t1) / 2;
      // +1 = right of travel = negative lateral in the game's left-positive frame.
      const s = seg.side >= 0 ? -1 : 1;
      const k = pos.length / 3;
      const corner = (f: ReturnType<typeof frameAt>, lat: number): void => {
        pos.push(f.x + f.lx * lat * s, f.y + RACE.track.roadY + 0.04, f.z + f.lz * lat * s);
      };
      corner(f0, w0);
      corner(f0, w0 + kerbs.widthM);
      corner(f1, w1);
      corner(f1, w1 + kerbs.widthM);
      uv.push(0, 0, 1, 0, 0, 1, 1, 1);
      if (s < 0) idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      else idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const tex = this.assets.texture('textures/spa_kerb.png');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'kerbs';
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  // ------------------------------------------------------------------------------------------------ placed props

  private buildPlaced(placements: SuzukaPlacements): void {
    const field = this.ground.height;
    // The placements list design `t`s; the spline was rotated to the start line by `startShiftT`. The design's gantry
    // is the game's `StartGantry`, drawn separately.
    const shift = (this.def.raw.startShiftT as number | undefined) ?? 0;
    const byModel = planPlacements(
      placements,
      (x, z) => field.heightAt(x, z),
      (t) => frameAt(this.path, t - shift).y,
    );
    byModel.delete(GANTRY);
    const detail = DETAIL[this.opts.quality];
    for (const [model, items] of byModel) {
      const base = windowFor(model);
      const cfg: WindowCfg = {
        ...base,
        radiusM: Math.max(120, base.radiusM * (base.cap > 20 ? detail : 1)),
        cap: Math.max(1, Math.min(items.length, Math.ceil(base.cap * (base.cap > 20 ? detail : 1)))),
      };
      const pool = new InstancePool(this.group, this.assets, model, cfg.cap, false);
      for (const m of pool.meshes) m.visible = false;
      this.windows.push({ grid: new ItemGrid(items), cfg, pool });
    }
  }

  /** Re-picks the drawn instances when the camera has moved or turned enough. Call every frame. */
  update(): void {
    const cam = this.opts.camera;
    // The sky and the mountain band stay centred on the camera.
    this.sky.position.copy(cam.position);
    this.mountains.position.set(cam.position.x, cam.position.y + 40, cam.position.z);
    cam.getWorldDirection(this.dir);
    const h = Math.hypot(this.dir.x, this.dir.z) || 1;
    const yaw = Math.atan2(this.dir.x, this.dir.z);
    const last = this.lastView;
    if (last) {
      const moved = Math.hypot(cam.position.x - last.x, cam.position.z - last.z);
      const turned = Math.abs(Math.atan2(Math.sin(yaw - last.yaw), Math.cos(yaw - last.yaw)));
      if (moved < MOVE_M && turned < TURN_RAD) return;
    }
    this.lastView = { x: cam.position.x, z: cam.position.z, yaw };
    const view: View = { x: cam.position.x, z: cam.position.z, fx: this.dir.x / h, fz: this.dir.z / h };
    for (const w of this.windows) {
      const picked: Item[] = selectWindow(w.grid, view, w.cfg, this.scratch);
      w.pool.fill(picked);
      const show = picked.length > 0;
      for (const m of w.pool.meshes) m.visible = show;
    }
  }

  dispose(): void {
    for (const w of this.windows) w.pool.dispose();
    this.windows.length = 0;
    this.surroundings?.dispose();
    this.surroundings = null;
    this.scene.environment = null;
    this.scene.environmentIntensity = 1;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.removeFromParent();
  }
}
