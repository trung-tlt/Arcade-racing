import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/Assets';
import { HANDLING, RACE, type TrackDef } from '../core/Data';
import placementsJson from '../../data/tracks/ardennes_placements.json';
import terrainJson from '../../data/tracks/ardennes_terrain.json';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import {
  BAKE_CHUNK_M,
  ExclusionGrid,
  STAYS_INSTANCED,
  chunkCentre,
  chunkOf,
  GroundField,
  HeightField,
  PAINT,
  buildTerrainGrid,
  forestTrees,
  gridChunks,
  gridNormal,
  groundNoise,
  groundScatter,
  gridBoxSites,
  groupByModel,
  inViewWedge,
  placementClearances,
  planBarriers,
  planBridges,
  planPlacements,
  planSigns,
  planStands,
  racingLineOffset,
  terrainBand,
  terrainColor,
  yawTowardsRoad,
  type Pixels,
  type PlacementData,
  type Scatter,
  type TerrainGrid,
  type TerrainMeta,
  type Tree,
} from './ardennesLayout';
import { StartGantry, instance, pieceMatrices, protectSpecialMaterials } from './MonteCarlo';
import { materialKey } from './Sponsors';
import { DistanceCull } from './Windowed';
import { RoadIndex, frameAt, yawForX } from './monteCarloLayout';
import type { TrackPath } from './TrackPath';

type Rapier = typeof RAPIER;
type Quality = 'low' | 'med' | 'high';

const SPA = 'models/props_spa/';
const MC = 'models/props_monaco/';
const spa = (n: string): string => `${SPA}${n}.glb`;
const mc = (n: string): string => `${MC}${n}.glb`;

const PLACEMENTS = placementsJson as unknown as PlacementData;
const TERRAIN_META = terrainJson as unknown as TerrainMeta;

const ARMCO = mc('armco_4m');
const ARMCO_ADS = ['emesoft', 'capturemann', 'craftmann', 'voltline'].map((n) => mc(`armco_ad_${n}`));
const FENCE = mc('catch_fence_4m');
const TYRES = mc('tyre_wall_4m');
const TECPRO = spa('tecpro_4m');
const GRANDSTAND = mc('grandstand_40m');
const GANTRY = mc('start_gantry');
/**
 * Alpha-card spruces (300-440 tris) for every tree. The cone spruces (1,218 tris each) are 3x dearer, so they would
 * blow the 400k triangle budget in a dense stretch of forest; two card variants plus the per-instance tint and scale
 * keep the forest from looking copy-pasted.
 */
const SPRUCE_HQ = ['a', 'c'].map((n) => spa(`spruce_hq_${n}`));
const FOREST_CARD = spa('forest_card_40m');
const RIDGES = spa('ardennes_ridges');
const GRASS = [spa('grass_patch_a'), spa('grass_patch_b')];

/** Every GLB Map 6 loads, relative to /assets/ (the Map 5 Armco, fence, tyre wall, stand and gantry are shared). */
export const ARDENNES_MODELS: string[] = [
  ...new Set([
    ARMCO,
    ...ARMCO_ADS,
    FENCE,
    TYRES,
    TECPRO,
    GRANDSTAND,
    GANTRY,
    spa('pit_building_80m'),
    spa('hillside_stand_40m'),
    spa('footbridge_voltline'),
    spa('footbridge_craftmann'),
    ...['la_source', 'eau_rouge', 'les_combes', 'pouhon', 'stavelot', 'blanchimont'].map((n) =>
      spa(`corner_sign_${n}`),
    ),
    ...[100, 200, 300].map((n) => spa(`distance_board_${n}`)),
    ...SPRUCE_HQ,
    FOREST_CARD,
    RIDGES,
    ...GRASS,
    ...Object.values(PLACEMENTS.models),
  ]),
];

/** Standalone textures (everything else is embedded in the GLBs). */
export const ARDENNES_TEXTURES: string[] = [
  'textures/spa_road.png',
  'textures/spa_grass.png',
  'textures/spa_markings.png',
  'textures/spa_terrain_height.png',
  'textures/spa_terrain_splat.png',
  'textures/spa_forest_mask.png',
];

/** Distances (m) beyond which a windowed instanced set stops drawing. */
const WINDOW = { barrier: 180, props: 700 };

/** Per quality preset: how much forest and scatter is built around the camera. */
const QUALITY = {
  low: { hqM: 110, farM: 240, hqCell: 13, farCell: 26, scatterM: 100, scatterCell: 9, cards: true },
  med: { hqM: 160, farM: 340, hqCell: 11, farCell: 22, scatterM: 150, scatterCell: 5.5, cards: true },
  high: { hqM: 180, farM: 380, hqCell: 10, farCell: 20, scatterM: 170, scatterCell: 4.5, cards: true },
} as const;

/** The forest is rebuilt when the camera is this far (m) from where it was last centred. */
const RECENTRE_M = 150;
/** The scatter likewise. */
const SCATTER_RECENTRE_M = 50;
/** What the camera sees: trees outside this wedge (half-angle 60 degrees) and beyond 30 m are not submitted. */
const VIEW = { cosHalf: Math.cos((60 * Math.PI) / 180), nearM: 30, turnRad: (6 * Math.PI) / 180, moveM: 15 };

const up = new THREE.Vector3(0, 1, 0);

/** The pixels of a loaded texture (the heightmap, mask and splat are data, read once). */
function readPixels(tex: THREE.Texture): Pixels {
  const img = tex.image as CanvasImageSource & { width: number; height: number };
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: d.width, height: d.height };
}

/**
 * Bakes placements into one static mesh per material (vertex-colour parts into two shared materials). Plain
 * two-sided parts (flags, tent cloth, awnings) get a flipped copy of their triangles and go one-sided, so they merge
 * too instead of costing a draw call per colour.
 */
class StaticBake {
  private readonly buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();
  private readonly protos = new Map<string, THREE.Object3D>();

  constructor(private readonly assets: Assets) {}

  private static flipDouble(mesh: THREE.Mesh, mat: THREE.MeshStandardMaterial): void {
    const src = mesh.geometry;
    const pos = src.getAttribute('position');
    const n = pos.count;
    const geo = new THREE.BufferGeometry();
    for (const name of Object.keys(src.attributes)) {
      const a = src.getAttribute(name);
      const arr = new (a.array.constructor as new (n: number) => Float32Array)(a.array.length * 2);
      arr.set(a.array as ArrayLike<number>, 0);
      arr.set(a.array as ArrayLike<number>, a.array.length);
      if (name === 'normal') for (let i = a.array.length; i < arr.length; i++) arr[i] = -arr[i];
      geo.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
    }
    const idx = src.index;
    const count = idx ? idx.count : n;
    const out = new Uint32Array(count * 2);
    for (let i = 0; i < count; i += 3) {
      const [a, b, c] = idx ? [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)] : [i, i + 1, i + 2];
      out.set([a, b, c], i);
      out.set([a + n, c + n, b + n], count + i);
    }
    geo.setIndex(new THREE.BufferAttribute(out, 1));
    mesh.geometry = geo;
    mat.side = THREE.FrontSide;
  }

  add(model: string, at: THREE.Matrix4, panelsOnly = false): void {
    let proto = this.protos.get(model);
    if (!proto) {
      proto = this.assets.cloneModel(model);
      proto.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
        const m = o.material as THREE.MeshStandardMaterial;
        if (m.side === THREE.DoubleSide && !m.map && !m.transparent && m.alphaTest === 0) StaticBake.flipDouble(o, m);
      });
      protectSpecialMaterials(proto);
      mergePropMaterials(proto);
      proto.updateMatrixWorld(true);
      this.protos.set(model, proto);
    }
    const world = new THREE.Matrix4();
    proto.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      if (panelsOnly && !(o.material as THREE.MeshStandardMaterial).map) return;
      const key = materialKey(o.material);
      let b = this.buckets.get(key);
      if (!b) {
        b = { material: o.material, geos: [] };
        this.buckets.set(key, b);
      }
      world.multiplyMatrices(at, o.matrixWorld);
      b.geos.push(o.geometry.clone().applyMatrix4(world));
    });
  }

  addAt(model: string, x: number, y: number, z: number, yaw: number, scale = 1, panelsOnly = false): void {
    this.add(
      model,
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromAxisAngle(up, yaw),
        new THREE.Vector3(scale, scale, scale),
      ),
      panelsOnly,
    );
  }

  build(parent: THREE.Object3D, name: string): void {
    for (const [key, b] of this.buckets) {
      const common = Object.keys(b.geos[0].attributes).filter((a) => b.geos.every((g) => g.getAttribute(a)));
      for (const g of b.geos) for (const a of Object.keys(g.attributes)) if (!common.includes(a)) g.deleteAttribute(a);
      const merged = mergeGeometries(b.geos, false);
      b.geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.name = `${name}:${key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      parent.add(mesh);
    }
    this.buckets.clear();
  }

  dispose(): void {
    const freed = new Set<THREE.Material>();
    for (const p of this.protos.values()) {
      p.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
          if (mat.userData.shared || freed.has(mat)) continue;
          freed.add(mat);
          mat.dispose();
        }
      });
    }
    this.protos.clear();
  }
}

interface Placed {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  tint?: [number, number, number];
}

/**
 * A fixed-capacity InstancedMesh set (one per sub-mesh of a model) that is refilled as the camera moves: trees, grass
 * and forest cards. `fill` writes the matrices (and per-instance HSL tints) and sets the draw count.
 */
class InstancePool {
  readonly meshes: THREE.InstancedMesh[] = [];
  private readonly local: THREE.Matrix4[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly tmp = new THREE.Matrix4();

  constructor(
    parent: THREE.Object3D,
    assets: Assets,
    model: string,
    readonly capacity: number,
    tinted: boolean,
  ) {
    const proto = assets.cloneModel(model);
    protectSpecialMaterials(proto);
    mergePropMaterials(proto);
    proto.updateMatrixWorld(true);
    proto.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const inst = new THREE.InstancedMesh(o.geometry, o.material, capacity);
      inst.name = `${model.split('/').pop()}:${o.name}`;
      inst.count = 0;
      inst.frustumCulled = false;
      inst.castShadow = false;
      inst.receiveShadow = true;
      if (tinted) inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      this.meshes.push(inst);
      this.local.push(o.matrixWorld.clone());
      parent.add(inst);
    });
  }

  fill(items: readonly Placed[]): void {
    const n = Math.min(items.length, this.capacity);
    for (let k = 0; k < n; k++) {
      const it = items[k];
      this.p.set(it.x, it.y, it.z);
      this.q.setFromAxisAngle(up, it.yaw);
      this.s.set(it.scale, it.scale, it.scale);
      this.m.compose(this.p, this.q, this.s);
      for (let i = 0; i < this.meshes.length; i++) {
        this.meshes[i].setMatrixAt(k, this.tmp.multiplyMatrices(this.m, this.local[i]));
        if (it.tint && this.meshes[i].instanceColor) {
          this.meshes[i].setColorAt(k, this.c.setHSL(it.tint[0], it.tint[1], it.tint[2]));
        }
      }
    }
    for (const mesh of this.meshes) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mat.dispose();
      mesh.dispose();
    }
  }
}

/**
 * Ardennes Forest Circuit (Map 6): the heightmap terrain with its collider, the forest around the camera, the circuit
 * furniture (Armco, tecpro, tyre walls, kerbs, signs, bridges, stands, pits, gantry) and the placed detail.
 */
export class Ardennes {
  readonly group = new THREE.Group();
  readonly gantry: StartGantry;
  readonly ground: GroundField;
  readonly grid: TerrainGrid;
  private readonly index: RoadIndex;
  private readonly body: RAPIER.RigidBody;
  private readonly quality: (typeof QUALITY)[Quality];
  private readonly skip: ExclusionGrid;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly pools: InstancePool[] = [];
  private readonly baked: StaticBake[] = [];
  private ridges: THREE.Object3D | null = null;
  private barriers: { plan: ReturnType<typeof planBarriers>; adModels: string[] } | null = null;
  private readonly hq: InstancePool[];
  private readonly cardPool: InstancePool;
  private readonly tufts: InstancePool[];
  // Forest state: candidates around the last centre, and the wedge last submitted.
  private forestCentre: [number, number] | null = null;
  private hqTrees: Tree[] = [];
  private farTrees: Tree[] = [];
  private cards: Placed[] = [];
  private scatterCentre: [number, number] | null = null;
  private scatter: Scatter[] = [];
  private lastView: { x: number; z: number; yaw: number } | null = null;
  private readonly dir = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    R: Rapier,
    private readonly world: RAPIER.World,
    private readonly assets: Assets,
    private readonly def: TrackDef,
    private readonly path: TrackPath,
    private readonly opts: { camera: THREE.Camera; quality: Quality },
  ) {
    this.group.name = 'ardennes';
    this.quality = QUALITY[opts.quality];
    this.index = new RoadIndex(path, 4);
    const field = new HeightField(
      TERRAIN_META,
      readPixels(assets.texture('textures/spa_terrain_height.png')),
      readPixels(assets.texture('textures/spa_forest_mask.png')),
      readPixels(assets.texture('textures/spa_terrain_splat.png')),
    );
    this.ground = new GroundField(field, this.index);
    this.grid = buildTerrainGrid(this.ground, 16);
    this.group.add(this.buildTerrain());
    this.body = this.buildCollider(R);

    const items = planPlacements(PLACEMENTS, this.ground, (t) => frameAt(path, t).y);
    const stands = planStands(def, this.index, 22);
    const pits = (def.raw.pits as { building: { segments: { position: [number, number, number] }[] } }).building
      .segments;
    this.skip = new ExclusionGrid([
      ...placementClearances(items),
      ...stands.map((s) => ({ x: s.x, z: s.z, r: 30 })),
      ...pits.map((p) => ({ x: p.position[0], z: p.position[2], r: 30 })),
    ]);
    this.buildPaint();
    this.buildCircuit(items, stands);
    this.buildStatic(items, stands, pits);
    this.buildPlaced(items);

    const q = this.quality;
    // Every tree of both rings can share a pool (the view wedge keeps the submitted ones far below the total).
    const treeCap = Math.ceil(
      (((Math.PI * q.hqM ** 2) / q.hqCell ** 2 + (Math.PI * (q.farM ** 2 - q.hqM ** 2)) / q.farCell ** 2) * 0.8) /
        SPRUCE_HQ.length,
    );
    this.hq = SPRUCE_HQ.map((m) => this.pool(m, treeCap, true));
    this.cardPool = this.pool(FOREST_CARD, 900, false);
    this.tufts = GRASS.slice(0, 1).map((m) =>
      this.pool(m, Math.ceil(((Math.PI * q.scatterM ** 2) / q.scatterCell ** 2) * 0.5), false),
    );
    for (const t of this.tufts) {
      for (const m of t.meshes) (m.material as THREE.MeshStandardMaterial).color.set('#9DAE78');
    }
    this.buildBackdrop();
    this.gantry = new StartGantry(assets, path, this.group, 0, GANTRY);
    scene.add(this.group);
  }

  private pool(model: string, capacity: number, tinted: boolean): InstancePool {
    const p = new InstancePool(this.group, this.assets, model, capacity, tinted);
    this.pools.push(p);
    return p;
  }

  // ------------------------------------------------------------------------------------------------ terrain

  private buildTerrain(): THREE.Group {
    const out = new THREE.Group();
    out.name = 'terrain';
    const g = this.grid;
    const field = this.ground.height;
    const tex = this.assets.texture('textures/spa_grass.png');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.95, metalness: 0 });
    this.disposables.push(mat);
    const c = new THREE.Color();
    const rgb: [number, number, number] = [0, 0, 0];
    const nrm: [number, number, number] = [0, 1, 0];
    const TILE_M = 10;
    for (const ch of gridChunks(g, 86)) {
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
          terrainColor(field.forestAt(x, z), field.splatAt(x, z), na, nb, rgb);
          // The tiled grass is sRGB; the vertex tint multiplies it in linear space.
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
    // Under the whole world: no sky shows through between the terrain's edge and the ridges.
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(14000, 14000),
      new THREE.MeshBasicMaterial({ color: '#33432A', fog: true }),
    );
    base.rotation.x = -Math.PI / 2;
    base.position.set(1000, -12, 100);
    base.name = 'terrain_base';
    out.add(base);
    this.disposables.push(base.geometry, base.material as THREE.Material);
    return out;
  }

  /** The reachable land (a band along the road, ~36 m each side) as a fixed trimesh: cars that leave the road don't fall. */
  private buildCollider(R: Rapier): RAPIER.RigidBody {
    const band = terrainBand(this.grid, 36);
    const body = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    this.world.createCollider(
      R.ColliderDesc.trimesh(band.positions, band.indices).setFriction(HANDLING.world.groundFriction),
      body,
    );
    return body;
  }

  // ------------------------------------------------------------------------------------------------ road paint

  /** One triangle-strip mesh: for each path sample the lateral range from `range` (+ = left), `y` above the road. */
  private strip(range: (i: number, s: number) => [number, number] | null, lift: number): THREE.BufferGeometry {
    const { path } = this;
    const n = path.count;
    const pos: number[] = [];
    const idx: number[] = [];
    let prev = -1;
    for (let r = 0; r <= n; r++) {
      const i = r % n;
      const lat = range(i, i * path.spacingM);
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

  /** White edge lines, the rubbered racing line, the chequered start band and the 20 grid boxes. */
  private buildPaint(): void {
    const half = this.def.roadWidthM / 2;
    const { edgeLine } = PAINT;
    const lines = this.strip(() => [half - edgeLine.insetM - edgeLine.widthM, half - edgeLine.insetM], 0.012);
    const left = this.strip(() => [-(half - edgeLine.insetM), -(half - edgeLine.insetM - edgeLine.widthM)], 0.012);
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
    const line = this.strip((_i, s) => {
      const mid = racingLineOffset(this.path, s);
      return [mid - 1.1, mid + 1.1];
    }, 0.008);
    const edges = mergeGeometries([lines, left]);
    lines.dispose();
    left.dispose();
    for (const [geo, mat, name] of [
      [edges, white, 'edge_lines'],
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
      // Corners: (left, back), (right, back), (right, front), (left, front); the atlas's top edge faces forward.
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
    quad(0, 0, this.def.roadWidthM, PAINT.chequerM, 0.25, 0.25, 0.5, 0.75);
    for (const b of gridBoxSites()) {
      quad(
        1 - b.behindM / len,
        b.lateralM,
        PAINT.gridBoxes.widthM,
        PAINT.gridBoxes.lengthM,
        0.02,
        1 - 116 / 256,
        0.23,
        1 - 32 / 256,
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: atlas,
      transparent: true,
      opacity: 0.95,
      roughness: 0.6,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const marks = new THREE.Mesh(geo, mat);
    marks.name = 'markings';
    marks.renderOrder = 2;
    marks.receiveShadow = true;
    this.group.add(marks);
    this.disposables.push(geo, mat);
  }

  // ------------------------------------------------------------------------------------------------ circuit

  private buildCircuit(items: ReturnType<typeof planPlacements>, stands: ReturnType<typeof planStands>): void {
    const g = new THREE.Group();
    g.name = 'circuit';
    // The catch fence only stands where spectators do: the stands and the crowd groups.
    const fenceSites = [
      ...stands.map((s) => ({ x: s.x, z: s.z, r: 50 })),
      ...items.filter((i) => i.group === 'crowd').map((i) => ({ x: i.x, z: i.z, r: 30 })),
    ];
    const plan = planBarriers(this.path, this.def, fenceSites);
    const adModels = (this.def.raw.barriers as { armco: { adModels: string[] } }).armco.adModels;
    // Plain Armco at every piece, windowed. The sponsor panels (the ad models' only textured part), the catch fence,
    // the tecpro and the tyre walls are baked into the static chunks: they share textures, so a chunk costs one draw
    // for all four sponsors instead of one each.
    instance(g, this.assets, ARMCO, pieceMatrices(plan.armco), WINDOW.barrier);
    this.barriers = { plan, adModels };
    this.group.add(g);
  }

  /**
   * Everything that stands still (signs, bridges, stands, pits and all placement groups but the kerbs, grass and
   * crowds) is baked into one mesh per material per 500 m chunk: a few draw calls near the camera instead of one or two
   * per model, and a chunk far away is skipped whole.
   */
  private buildStatic(
    items: ReturnType<typeof planPlacements>,
    stands: ReturnType<typeof planStands>,
    pits: { position: [number, number, number] }[],
  ): void {
    const chunks = new Map<string, { bake: StaticBake; cx: number; cz: number; sumY: number; n: number }>();
    const add = (model: string, x: number, y: number, z: number, yaw: number, scale = 1, panelsOnly = false): void => {
      const [cx, cz] = chunkOf(x, z);
      const key = `${cx},${cz}`;
      let c = chunks.get(key);
      if (!c) {
        c = { bake: new StaticBake(this.assets), cx, cz, sumY: 0, n: 0 };
        chunks.set(key, c);
        this.baked.push(c.bake);
      }
      c.bake.addAt(model, x, y, z, yaw, scale, panelsOnly);
      c.sumY += y;
      c.n++;
    };
    for (const s of planSigns(this.path, this.def)) add(s.model, s.x, this.ground.heightAt(s.x, s.z), s.z, s.yaw);
    for (const b of planBridges(this.path, this.def)) add(b.model, b.x, b.y, b.z, b.yaw);
    for (const s of stands) add(s.model, s.x, this.ground.heightAt(s.x, s.z) - 0.3, s.z, s.yaw);
    const pitModel = (this.def.raw.pits as { building: { model: string } }).building.model;
    for (const p of pits) {
      const [x, , z] = p.position;
      add(pitModel, x, this.ground.heightAt(x, z) - 0.4, z, yawTowardsRoad(this.index, x, z));
    }
    for (const it of items) if (!STAYS_INSTANCED.test(it.model)) add(it.model, it.x, it.y, it.z, it.rotY, it.scale);
    const bar = this.barriers;
    if (bar) {
      const { plan, adModels } = bar;
      for (const p of plan.armco) if (p.ad >= 0) add(adModels[p.ad], p.x, p.y, p.z, p.yaw, 1, true);
      for (const [model, pieces] of [
        [FENCE, plan.fence],
        [TYRES, plan.tyres],
        [TECPRO, plan.tecpro],
      ] as const) {
        for (const p of pieces) add(model, p.x, p.y, p.z, p.yaw);
      }
    }
    const g = new THREE.Group();
    g.name = 'static';
    const half = BAKE_CHUNK_M / 2;
    for (const c of chunks.values()) {
      const [mx, mz] = chunkCentre(c.cx, c.cz);
      const centre = new THREE.Vector3(mx, c.sumY / c.n, mz);
      const cull = new DistanceCull(centre, WINDOW.props, half * Math.SQRT2);
      c.bake.build(cull, `static_${c.cx}_${c.cz}`);
      g.add(cull);
    }
    this.group.add(g);
  }

  /** The placement groups that stay instanced with a draw window: kerbs, grass tufts and crowds. */
  private buildPlaced(items: ReturnType<typeof planPlacements>): void {
    const g = new THREE.Group();
    g.name = 'placed';
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (const e of groupByModel(items.filter((i) => STAYS_INSTANCED.test(i.model)))) {
      const mats = e.items.map((it) =>
        new THREE.Matrix4().compose(p.set(it.x, it.y, it.z), q.setFromAxisAngle(up, it.rotY), s.setScalar(it.scale)),
      );
      instance(g, this.assets, e.model, mats, e.windowM);
    }
    this.group.add(g);
  }

  /**
   * The ring of ridges on the horizon (the JSON's cylinder, 2.4 km out). It follows the camera sideways so it always
   * stays on the horizon: pinned to the circuit's centre the western end of the lap would run into its wall.
   */
  private buildBackdrop(): void {
    const c = (this.def.raw.vegetation as { ridges: { centre: [number, number, number] } }).ridges.centre;
    const ridges = this.assets.cloneModel(RIDGES);
    ridges.name = 'ridges';
    ridges.position.set(c[0], c[1], c[2]);
    this.ridges = ridges;
    this.group.add(ridges);
  }

  // ------------------------------------------------------------------------------------------------ per frame

  /** Re-centre the forest and scatter as the camera travels, and submit only what the camera can see. */
  update(): void {
    const cam = this.opts.camera;
    const cx = cam.position.x;
    const cz = cam.position.z;
    this.ridges?.position.set(cx, this.ridges.position.y, cz);
    cam.getWorldDirection(this.dir);
    const h = Math.hypot(this.dir.x, this.dir.z) || 1;
    const dx = this.dir.x / h;
    const dz = this.dir.z / h;
    const yaw = Math.atan2(dx, dz);
    const q = this.quality;

    let dirty = false;
    if (!this.forestCentre || Math.hypot(cx - this.forestCentre[0], cz - this.forestCentre[1]) > RECENTRE_M) {
      this.forestCentre = [cx, cz];
      this.hqTrees = forestTrees(this.ground, this.skip, cx, cz, 0, q.hqM, {
        cellM: q.hqCell,
        roadClearM: 23,
        maskMin: 0.5,
        keep: 0.85,
        variants: SPRUCE_HQ.length,
        salt: 1,
      });
      this.farTrees = forestTrees(this.ground, this.skip, cx, cz, q.hqM, q.farM, {
        cellM: q.farCell,
        roadClearM: 23,
        maskMin: 0.5,
        keep: 0.85,
        variants: SPRUCE_HQ.length,
        salt: 2,
      });
      this.cards = q.cards ? this.planCards(cx, cz, q.farM) : [];
      dirty = true;
    }
    if (
      !this.scatterCentre ||
      Math.hypot(cx - this.scatterCentre[0], cz - this.scatterCentre[1]) > SCATTER_RECENTRE_M
    ) {
      this.scatterCentre = [cx, cz];
      this.scatter = groundScatter(this.ground, this.skip, cx, cz, q.scatterM + SCATTER_RECENTRE_M, q.scatterCell, 1e9);
      dirty = true;
    }
    const v = this.lastView;
    if (
      dirty ||
      !v ||
      Math.hypot(cx - v.x, cz - v.z) > VIEW.moveM ||
      Math.abs(Math.atan2(Math.sin(yaw - v.yaw), Math.cos(yaw - v.yaw))) > VIEW.turnRad
    ) {
      this.lastView = { x: cx, z: cz, yaw };
      this.submit(cx, cz, dx, dz);
    }
  }

  /** Forest cards: rings of 40 m cards beyond the trees, wherever the mask says forest. */
  private planCards(cx: number, cz: number, innerM: number): Placed[] {
    const out: Placed[] = [];
    const field = this.ground.height;
    for (const r of [innerM + 40, innerM + 140, innerM + 270, innerM + 430, innerM + 620]) {
      const n = Math.ceil((Math.PI * 2 * r) / 32);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        if (field.forestAt(x, z) < 0.5) continue;
        out.push({
          x,
          y: field.heightAt(x, z) - 1,
          z,
          yaw: yawForX(cx - x, cz - z),
          scale: 1 + ((k * 7919) % 100) / 200,
        });
      }
    }
    return out;
  }

  private submit(cx: number, cz: number, dx: number, dz: number): void {
    const see = (x: number, z: number): boolean => inViewWedge(x - cx, z - cz, dx, dz, VIEW.cosHalf, VIEW.nearM);
    const fillByVariant = (pools: InstancePool[], ...rings: (readonly Tree[])[]): void => {
      const lists: Placed[][] = pools.map(() => []);
      for (const trees of rings) for (const t of trees) if (see(t.x, t.z)) lists[t.variant].push(t);
      pools.forEach((p, i) => p.fill(lists[i]));
    };
    fillByVariant(this.hq, this.hqTrees, this.farTrees);
    this.cardPool.fill(this.cards.filter((c) => see(c.x, c.z)));
    const lists: Placed[][] = [[]];
    for (const s of this.scatter) {
      const d2 = (s.x - cx) * (s.x - cx) + (s.z - cz) * (s.z - cz);
      if (s.kind === 2 || d2 > this.quality.scatterM ** 2 || !see(s.x, s.z)) continue; // no rocks: a draw call each
      lists[0].push(s);
    }
    this.tufts.forEach((p, i) => p.fill(lists[i]));
  }

  dispose(): void {
    for (const p of this.pools) p.dispose();
    for (const b of this.baked) b.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) o.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.world.removeRigidBody(this.body);
    this.group.removeFromParent();
    this.scene.remove(this.group);
  }
}
