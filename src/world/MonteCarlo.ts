import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import type { Assets } from '../core/Assets';
import { LIGHTING, RACE, type TrackDef } from '../core/Data';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import { seededRng } from './CongHoaDressing';
import {
  type Obstacle,
  type Piece,
  RoadIndex,
  SEA_FLOOR_Y,
  alongSide,
  frameAt,
  inRange,
  makeTerrain,
  planBarriers,
  planBelleEpoque,
  planGardens,
  planKerbs,
  planTowers,
  tunnelRange,
  clearStandSites,
  yawForX,
  yawForZ,
  type TerrainField,
} from './monteCarloLayout';
import { materialKey } from './Sponsors';
import type { TrackPath } from './TrackPath';
import { windowInstances } from './Windowed';

type Rapier = typeof RAPIER;

const P = 'models/props_monaco/';
const m = (n: string): string => `${P}${n}.glb`;
const ARMCO = m('armco_4m');
const ARMCO_ADS = ['emesoft', 'capturemann', 'craftmann', 'voltline'].map((n) => m(`armco_ad_${n}`));
const FENCE = m('catch_fence_4m');
const TYRES = m('tyre_wall_4m');
const KERB = m('kerb_4m');
const BELLE = ['a', 'b', 'c', 'd'].map((n) => m(`belle_epoque_${n}`));
const TOWERS = ['a', 'b'].map((n) => m(`modern_tower_${n}`));
const PALMS = [m('palm_a'), m('palm_b')];
const YACHTS = ['superyacht_white', 'superyacht_navy', 'superyacht_grey', 'sail_yacht_a', 'sail_yacht_b'].map(m);
const GRANDSTAND = m('grandstand_40m');
const PITS = m('pit_building_60m');
const MARSHAL = m('marshal_post');
const TUNNEL = m('tunnel_segment_20m');
const HOTEL = m('hotel_over_tunnel');
const CASINO = m('grand_casino');
const FOUNTAIN = m('fountain');
const FLOWERS = m('flower_bed');
const CYPRESS = m('cypress');
const POOL = m('swimming_pool');
const PONTOON = m('pontoon_40m');
const HARBOUR_LIGHT = m('harbour_light');
const ROCK = m('rock_headland');
const MOUNTAINS = m('mountain_backdrop');
const HELI = m('tv_helicopter');
const GANTRY = m('start_gantry');

/** Every GLB Map 5 loads, relative to /assets/. */
export const MONTE_CARLO_MODELS: string[] = [
  ...new Set([
    ARMCO,
    ...ARMCO_ADS,
    FENCE,
    TYRES,
    KERB,
    ...BELLE,
    ...TOWERS,
    ...PALMS,
    ...YACHTS,
    GRANDSTAND,
    PITS,
    MARSHAL,
    TUNNEL,
    HOTEL,
    CASINO,
    FOUNTAIN,
    FLOWERS,
    CYPRESS,
    POOL,
    PONTOON,
    HARBOUR_LIGHT,
    ROCK,
    MOUNTAINS,
    HELI,
    GANTRY,
  ]),
];

/** Standalone textures (everything else is embedded in the GLBs). */
export const MONTE_CARLO_TEXTURES: string[] = [
  'textures/mc_road.png',
  'textures/mc_sky_gradient.png',
  'textures/mc_sea.png',
];

/** Distances (m) beyond which a windowed instanced set stops drawing (the fog is thin on this map, so keep them long). */
const WINDOW = { barrier: 300, palms: 320, yachts: 300, yachtsFar: 170 };
/**
 * Which baked districts cast sun shadows. Every caster is drawn a second time in the shadow pass and a merged district
 * is never frustum-culled, so on this map only the cars and the instanced barriers' neighbours pay for shadows.
 */
const SHADOWS = { city: false, setpieces: false };
/** The helicopter's offset from the leader. */
const HELI_OFFSET = { upM: 60, behindM: 40, sideM: 30, rotorRevPerSec: 6 };
/** Exposure multiplier inside the tunnel: -1.5 EV. */
export const TUNNEL_EXPOSURE_MUL = Math.pow(2, -1.5);
const TUNNEL_FADE_SEC = 0.35;
/** Bloom strength added for a moment as the car leaves the tunnel, and how fast it fades. */
const EXIT_FLARE = { boost: 0.9, decayPerSec: 0.9 };

const up = new THREE.Vector3(0, 1, 0);
const one = new THREE.Vector3(1, 1, 1);
const wrap01 = (t: number): number => ((t % 1) + 1) % 1;

export interface MonteCarloHooks {
  /** Exposure multiplier on the renderer (tunnel). */
  setExposureMul(k: number): void;
  /** Extra bloom strength (tunnel exit flare). */
  setBloomBoost(v: number): void;
  /** Fill light inside the tunnel, as a hemisphere boost (0 = none). */
  setFill(boost: number): void;
}

export interface LeaderState {
  x: number;
  y: number;
  z: number;
  /** Heading (radians, atan2(x, z)). */
  yaw: number;
}

/** Instance matrices for a list of pieces (4 m Armco, fence, kerbs, tyre stacks). */
export function pieceMatrices(pieces: readonly Piece[], dy = 0): THREE.Matrix4[] {
  const q = new THREE.Quaternion();
  return pieces.map((p) =>
    new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y + dy, p.z), q.setFromAxisAngle(up, p.yaw), one),
  );
}

/** Materials the vertex-colour merge would break (two-sided leaves, alpha-cut or transparent parts) stay separate draws. */
export function protectSpecialMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      if (mat.side !== THREE.FrontSide || mat.transparent || mat.alphaTest > 0) mat.userData.keepSeparate = true;
    }
  });
}

/** One InstancedMesh per sub-mesh of `model`, windowed by distance. Returns them (already added to `parent`). */
export function instance(
  parent: THREE.Object3D,
  assets: Assets,
  model: string,
  mats: readonly THREE.Matrix4[],
  windowM: number,
  castShadow = false,
): THREE.InstancedMesh[] {
  if (mats.length === 0) return [];
  const proto = assets.cloneModel(model);
  protectSpecialMaterials(proto);
  mergePropMaterials(proto);
  proto.updateMatrixWorld(true);
  const out: THREE.InstancedMesh[] = [];
  const tmp = new THREE.Matrix4();
  proto.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const inst = new THREE.InstancedMesh(o.geometry, o.material, mats.length);
    inst.name = `${model.split('/').pop()}:${o.name}`;
    for (let i = 0; i < mats.length; i++) inst.setMatrixAt(i, tmp.multiplyMatrices(mats[i], o.matrixWorld));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = castShadow;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    parent.add(inst);
    out.push(inst);
  });
  windowInstances(out, windowM);
  return out;
}

/** Bakes every placement of every model into one static mesh per material (a handful of draw calls for a whole district). */
export class Bake {
  private readonly buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();
  private readonly protos = new Map<string, THREE.Object3D>();

  constructor(private readonly assets: Assets) {}

  add(model: string, at: THREE.Matrix4): void {
    let proto = this.protos.get(model);
    if (!proto) {
      proto = this.assets.cloneModel(model);
      protectSpecialMaterials(proto);
      mergePropMaterials(proto);
      proto.updateMatrixWorld(true);
      this.protos.set(model, proto);
    }
    const world = new THREE.Matrix4();
    proto.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
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

  addAt(model: string, x: number, y: number, z: number, yaw: number, scale = 1): void {
    this.add(
      model,
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromAxisAngle(up, yaw),
        new THREE.Vector3(scale, scale, scale),
      ),
    );
  }

  build(parent: THREE.Object3D, name: string, castShadow: boolean): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [key, b] of this.buckets) {
      const common = Object.keys(b.geos[0].attributes).filter((a) => b.geos.every((g) => g.getAttribute(a)));
      for (const g of b.geos) for (const a of Object.keys(g.attributes)) if (!common.includes(a)) g.deleteAttribute(a);
      const merged = mergeGeometries(b.geos, false);
      b.geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.name = `${name}:${key}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.buckets.clear();
    return meshes;
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

/** Seamless water ripples as a normal map: summed sines with whole-number frequencies, so it tiles. */
export function waterNormalTexture(size = 128): THREE.DataTexture {
  const h = new Float32Array(size * size);
  const waves: [number, number, number, number][] = [
    [3, 1, 0.5, 0.0],
    [1, 4, 0.35, 1.7],
    [5, 5, 0.22, 3.1],
    [7, 2, 0.15, 0.6],
    [2, 8, 0.12, 2.4],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const [fx, fy, a, ph] of waves) v += a * Math.sin(((fx * x + fy * y) / size) * Math.PI * 2 + ph);
      h[y * size + x] = v;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 1.3;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 1.3;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      data[o] = Math.round(((-dx / l) * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round(((-dy / l) * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(((1 / l) * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** The start gantry: five lamp pods whose red lenses are lit one by one (`setLamps`) and all go out for GO. */
export class StartGantry {
  readonly object: THREE.Object3D;
  private readonly lenses: THREE.MeshStandardMaterial[] = [];

  constructor(assets: Assets, path: TrackPath, parent: THREE.Object3D, t = 0, model = GANTRY) {
    this.object = assets.cloneModel(model);
    this.object.name = 'start_gantry';
    const f = frameAt(path, t);
    // The pods face back down the grid: local +Z runs the way the cars drive.
    this.object.position.set(f.x, f.y, f.z);
    this.object.rotation.y = yawForZ(f.tx, f.tz);
    parent.add(this.object);
    this.object.updateMatrixWorld(true);
    this.splitLenses();
    this.setLamps(0);
  }

  /** The lens material is one shared mesh: split its triangles per pod (nearest `start_light_k` empty) so each lights alone. */
  private splitLenses(): void {
    const empties = [1, 2, 3, 4, 5].map((k) => this.object.getObjectByName(`start_light_${k}`));
    const targets: THREE.Mesh[] = [];
    this.object.traverse((o) => {
      if (o instanceof THREE.Mesh && !Array.isArray(o.material) && o.material.name === 'Start_Light_Red')
        targets.push(o);
    });
    const inv = new THREE.Matrix4();
    for (const mesh of targets) {
      const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
      const pos = geo.getAttribute('position');
      const nrm = geo.getAttribute('normal');
      inv.copy(mesh.matrixWorld).invert();
      const centres = empties.map((e) => {
        if (!e) return new THREE.Vector3();
        return e.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      });
      const bins: number[][] = [[], [], [], [], []];
      const c = new THREE.Vector3();
      for (let i = 0; i + 2 < pos.count; i += 3) {
        c.set(0, 0, 0);
        for (let k = 0; k < 3; k++) c.add(new THREE.Vector3().fromBufferAttribute(pos, i + k));
        c.divideScalar(3);
        let best = 0;
        let bestD = Infinity;
        centres.forEach((q, k) => {
          const d = Math.abs(q.x - c.x);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        });
        bins[best].push(i, i + 1, i + 2);
      }
      bins.forEach((tri) => {
        const p = new Float32Array(tri.length * 3);
        const n = new Float32Array(tri.length * 3);
        tri.forEach((src, j) => {
          p.set([pos.getX(src), pos.getY(src), pos.getZ(src)], j * 3);
          n.set([nrm.getX(src), nrm.getY(src), nrm.getZ(src)], j * 3);
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(p, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        const lens = new THREE.Mesh(g, mat);
        lens.name = 'start_lens';
        mesh.parent?.add(lens);
        lens.position.copy(mesh.position);
        lens.quaternion.copy(mesh.quaternion);
        lens.scale.copy(mesh.scale);
        this.lenses.push(mat);
      });
      mesh.removeFromParent();
    }
  }

  /** Light pods 1..`lit` (0 = all dark). */
  setLamps(lit: number): void {
    this.lenses.forEach((mat, k) => {
      const pod = Math.floor(k);
      const on = pod < lit;
      mat.emissive.set(on ? '#FF1A22' : '#120405');
      mat.emissiveIntensity = on ? 4 : 0.2;
    });
  }

  /** All five out: GO. */
  lightsOut(): void {
    this.setLamps(0);
  }
}

/** Monte-Carlo Harbour (Map 5): terrain, circuit furniture, city, harbour, sky and the TV helicopter. */
export class MonteCarlo {
  readonly group = new THREE.Group();
  readonly terrain: TerrainField;
  readonly index: RoadIndex;
  readonly gantry: StartGantry;
  /** 0..1: how far inside the tunnel the player is (eased); audio reads it for the reverb. */
  tunnelAmount = 0;
  private readonly tunnel: ReturnType<typeof tunnelRange>;
  private readonly baked: Bake[] = [];
  private readonly sky: Sky;
  private env: THREE.Texture | null = null;
  private readonly water: THREE.Mesh;
  private waterUniform: { value: number } | null = null;
  private seaMap: THREE.Texture | null = null;
  private readonly heli: THREE.Object3D;
  private readonly rotors: THREE.Object3D[] = [];
  private heliPos = new THREE.Vector3();
  private heliYaw = 0;
  private heliInit = false;
  private time = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  /** The harbour basin (with margin): where the sea can be seen from. */
  private static readonly BASIN = new THREE.Box3(new THREE.Vector3(-480, -8, 200), new THREE.Vector3(1050, 12, 3000));
  private flare = 0;
  private wasInside = false;
  private readonly reflectHide: THREE.Object3D[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    _R: Rapier,
    _world: RAPIER.World,
    private readonly assets: Assets,
    private readonly def: TrackDef,
    private readonly path: TrackPath,
    private readonly opts: {
      renderer: THREE.WebGLRenderer;
      /** The chase camera: the sea (and its mirror pass) is only drawn while the harbour is in view. */
      camera: THREE.Camera;
      /** Planar water reflection (Medium and High); Low scrolls a plain texture instead. */
      reflections: boolean;
      hooks: MonteCarloHooks;
    },
  ) {
    this.group.name = 'monte_carlo';
    this.tunnel = tunnelRange(def);
    this.index = new RoadIndex(path, 8);
    this.terrain = makeTerrain(this.index);
    const rnd = seededRng(7);
    const raw = def.raw as Record<string, never> & {
      grandstands: { segments: { model: string; position: [number, number, number] }[] }[];
      marshals: { position: [number, number, number] }[];
      pits: { building: { segments: { position: [number, number, number] }[] } };
      buildings: {
        casino: {
          position: [number, number, number];
          yawDeg: number;
          gardens: { flowerBeds: number; fountain: [number, number, number]; palms: number };
        };
        towers: { count: number };
        palms: { models: string[] };
      };
      harbour: {
        pool: { position: [number, number, number]; yawDeg: number };
        yachts: { model: string; position: [number, number, number]; yawDeg: number }[];
        pontoons: { position: [number, number, number]; yawDeg: number }[];
        lights: { position: [number, number, number] }[];
      };
      backdrop: { rock: { position: [number, number, number] }; mountains: { position: [number, number, number] } };
      tunnel: { hotel: { position: [number, number, number] } };
      helicopter: { model: string };
    };

    // Footprints the other dressing keeps clear of.
    const standSites = clearStandSites(
      raw.grandstands.flatMap((g) => g.segments.map((s) => s.position)),
      new RoadIndex(path, 2),
      RACE.track.stand,
    );
    const stands: Obstacle[] = standSites.map((p) => ({ x: p[0], z: p[2], r: 26 }));
    const pitSites = raw.pits.building.segments.map((s) => s.position);
    const blocked: Obstacle[] = [
      ...stands,
      ...pitSites.map((p) => ({ x: p[0], z: p[2], r: 36 })),
      { x: raw.buildings.casino.position[0], z: raw.buildings.casino.position[2], r: 46 },
      { x: raw.tunnel.hotel.position[0], z: raw.tunnel.hotel.position[2], r: 80 },
    ];

    this.sky = this.buildSkyAndEnv();
    const land = this.buildTerrain();
    this.reflectHide.push(land);
    this.group.add(land, this.sky);
    this.buildCircuit(stands);
    this.buildCity(blocked, rnd);
    this.buildSetPieces(raw, standSites, pitSites);
    this.buildHarbour(raw);
    this.water = this.buildWater();
    this.group.add(this.water);
    this.heli = this.buildHelicopter();
    this.gantry = new StartGantry(assets, path, this.group);
    scene.add(this.group);
  }

  // ------------------------------------------------------------------------------------------------ terrain / sky

  private buildTerrain(): THREE.Group {
    const out = new THREE.Group();
    out.name = 'terrain';
    const x0 = -820;
    const x1 = 1400;
    const z0 = -980;
    const z1 = 760;
    const cell = 12;
    const nx = Math.ceil((x1 - x0) / cell);
    const nz = Math.ceil((z1 - z0) / cell);
    const field = this.terrain;
    const color = new THREE.Color();
    const hash = (x: number, z: number): number => {
      const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
      return s - Math.floor(s);
    };
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    this.disposables.push(mat);
    const CHUNKS_X = 3;
    const CHUNKS_Z = 2;
    for (let cx = 0; cx < CHUNKS_X; cx++) {
      for (let cz = 0; cz < CHUNKS_Z; cz++) {
        const ix0 = Math.floor((cx * nx) / CHUNKS_X);
        const ix1 = Math.floor(((cx + 1) * nx) / CHUNKS_X);
        const iz0 = Math.floor((cz * nz) / CHUNKS_Z);
        const iz1 = Math.floor(((cz + 1) * nz) / CHUNKS_Z);
        const w = ix1 - ix0 + 1;
        const h = iz1 - iz0 + 1;
        const pos = new Float32Array(w * h * 3);
        const col = new Float32Array(w * h * 3);
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            const x = x0 + (ix0 + i) * cell;
            const z = z0 + (iz0 + j) * cell;
            const sea = field.seaAt(x, z);
            const land = field.heightAt(x, z);
            const y = land * (1 - sea) + SEA_FLOOR_Y * sea;
            const k = (j * w + i) * 3;
            pos[k] = x;
            pos[k + 1] = y;
            pos[k + 2] = z;
            const dRoad = field.roadDistance(x, z);
            const n = hash(x, z);
            // Quay and pavement near the road, olive scrub on the hills, bare limestone high up.
            if (y < 4 && dRoad < 40) color.set('#B9B2A3');
            else if (y > 45) color.set('#A59E8E');
            else color.set('#7E8F66').lerp(new THREE.Color('#9D9A82'), Math.min(1, Math.max(0, (y - 8) / 45)));
            color.multiplyScalar(0.92 + n * 0.16);
            col[k] = color.r;
            col[k + 1] = color.g;
            col[k + 2] = color.b;
          }
        }
        const idx: number[] = [];
        for (let j = 0; j < h - 1; j++) {
          for (let i = 0; i < w - 1; i++) {
            const a = j * w + i;
            idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        mesh.name = `terrain_${cx}_${cz}`;
        out.add(mesh);
        this.disposables.push(geo);
      }
    }
    return out;
  }

  /** Physical sky (Sky.js), also baked into the environment map so metal and glass pick up its colours. */
  private buildSkyAndEnv(): Sky {
    const sky = new Sky();
    sky.name = 'sky';
    sky.scale.setScalar(10000);
    const light = (this.def.daylight?.sun.dir ?? [-0.45, -0.75, 0.48]) as [number, number, number];
    const sun = new THREE.Vector3(-light[0], -light[1], -light[2]).normalize();
    const u = sky.material.uniforms;
    // Sky.js outputs HDR luminance far above 1 (it expects a 0.5 exposure): scale it so bloom doesn't wash the screen.
    sky.material.fragmentShader = sky.material.fragmentShader.replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      `gl_FragColor = vec4( texColor * ${LIGHTING.monteCarlo.sky.gain.toFixed(4)}, 1.0 );`,
    );
    const look = LIGHTING.monteCarlo.sky;
    u['turbidity'].value = look.turbidity;
    u['rayleigh'].value = look.rayleigh;
    u['mieCoefficient'].value = look.mieCoefficient;
    u['mieDirectionalG'].value = look.mieDirectionalG;
    u['sunPosition'].value.copy(sun);
    this.scene.background = null;
    const pm = new THREE.PMREMGenerator(this.opts.renderer);
    const rt = pm.fromScene(sky as unknown as THREE.Scene);
    this.env = rt.texture;
    this.scene.environment = this.env;
    this.scene.environmentIntensity = LIGHTING.monteCarlo.envIntensity;
    pm.dispose();
    this.disposables.push(sky.material, sky.geometry, rt);
    return sky;
  }

  // ------------------------------------------------------------------------------------------------ circuit

  /** The tunnel segments have no floor: a plain strip as wide as their walls keeps the terrain and sea from showing. */
  private buildTunnelFloor(): void {
    const tn = this.tunnel;
    if (!tn) return;
    const len = this.path.lengthM;
    const from = tn.fromT * len;
    const to = tn.toT * len;
    const n = Math.max(2, Math.ceil((to - from) / 4));
    const half = 7.4;
    const pos = new Float32Array((n + 1) * 2 * 3);
    for (let i = 0; i <= n; i++) {
      const f = frameAt(this.path, wrap01((from + ((to - from) * i) / n) / len));
      for (let k = 0; k < 2; k++) {
        const s = k === 0 ? 1 : -1;
        const o = (i * 2 + k) * 3;
        pos[o] = f.x + f.lx * half * s;
        pos[o + 1] = f.y + 0.005;
        pos[o + 2] = f.z + f.lz * half * s;
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: '#30343B', roughness: 0.95 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'tunnel_floor';
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  private buildCircuit(stands: readonly Obstacle[]): void {
    this.buildTunnelFloor();
    const plan = planBarriers(this.path, this.def, stands);
    const g = new THREE.Group();
    g.name = 'circuit';
    instance(g, this.assets, ARMCO, pieceMatrices(plan.armco.filter((p) => p.ad < 0)), WINDOW.barrier);
    ARMCO_ADS.forEach((model, k) => {
      instance(g, this.assets, model, pieceMatrices(plan.armco.filter((p) => p.ad === k)), WINDOW.barrier);
    });
    instance(g, this.assets, FENCE, pieceMatrices(plan.fence), WINDOW.barrier);
    instance(g, this.assets, TYRES, pieceMatrices(plan.tyres), WINDOW.barrier);
    instance(g, this.assets, KERB, pieceMatrices(planKerbs(this.path, this.def), 0.02), WINDOW.barrier);
    this.reflectHide.push(g);
    this.group.add(g);
  }

  // ------------------------------------------------------------------------------------------------ city

  private buildCity(blocked: readonly Obstacle[], rnd: () => number): void {
    const bake = new Bake(this.assets);
    this.baked.push(bake);
    const rows = planBelleEpoque(this.path, this.def, this.index, blocked);
    for (const b of rows) {
      const y = Math.min(b.y, this.terrain.heightAt(b.x, b.z) + 0.3);
      bake.addAt(BELLE[b.model], b.x, y, b.z, b.yaw);
    }
    const buildingBlocked: Obstacle[] = [...blocked, ...rows.map((b) => ({ x: b.x, z: b.z, r: Math.max(b.hw, b.hd) }))];
    const raw = this.def.raw as { buildings: { towers: { count: number } } };
    for (const t of planTowers(raw.buildings.towers.count, this.terrain, buildingBlocked, rnd)) {
      bake.addAt(TOWERS[t.model], t.x, this.terrain.heightAt(t.x, t.z) - 0.5, t.z, t.yaw);
    }
    const city = new THREE.Group();
    city.name = 'city';
    bake.build(city, 'city', SHADOWS.city);
    this.reflectHide.push(city);
    this.group.add(city);
  }

  private buildSetPieces(
    raw: {
      grandstands: { segments: { model: string; position: [number, number, number] }[] }[];
      marshals: { position: [number, number, number] }[];
      buildings: {
        casino: {
          position: [number, number, number];
          yawDeg: number;
          gardens: { flowerBeds: number; fountain: [number, number, number]; palms: number };
        };
      };
      tunnel: { hotel: { position: [number, number, number] } };
      backdrop: { rock: { position: [number, number, number] }; mountains: { position: [number, number, number] } };
    },
    standSites: [number, number, number][],
    pitSites: [number, number, number][],
  ): void {
    const bake = new Bake(this.assets);
    this.baked.push(bake);
    const index = this.index;
    /** Yaw that points a model's local +X (its road side) at the nearest road sample. */
    const roadSide = (p: [number, number, number]): number => {
      const { i } = index.nearest(p[0], p[2], 300);
      return yawForX(index.xs[i] - p[0], index.zs[i] - p[2]);
    };
    const roadFront = (p: [number, number, number]): number => {
      const { i } = index.nearest(p[0], p[2], 300);
      return yawForZ(index.xs[i] - p[0], index.zs[i] - p[2]);
    };
    for (const s of standSites) bake.addAt(GRANDSTAND, s[0], s[1], s[2], roadSide(s));
    for (const s of pitSites) bake.addAt(PITS, s[0], s[1], s[2], roadSide(s));
    for (const s of raw.marshals)
      bake.addAt(MARSHAL, s.position[0], s.position[1], s.position[2], roadFront(s.position));

    // Tunnel: 20 m segments end to end, with the hotel on top.
    const tn = this.tunnel;
    if (tn) {
      const len = this.path.lengthM;
      for (let s = tn.fromT * len + 10; s < tn.toT * len; s += 20) {
        const f = frameAt(this.path, wrap01(s / len));
        bake.addAt(TUNNEL, f.x, f.y, f.z, yawForZ(f.tx, f.tz));
      }
    }
    const hp = raw.tunnel.hotel.position;
    bake.addAt(HOTEL, hp[0], hp[1], hp[2], 0);

    // Grand Casino, its fountain, flower beds and palms.
    const c = raw.buildings.casino;
    const cy = this.terrain.heightAt(c.position[0], c.position[2]);
    const face = ((): number => {
      const { i } = index.nearest(c.position[0], c.position[2], 300);
      return yawForZ(index.xs[i] - c.position[0], index.zs[i] - c.position[2]);
    })();
    bake.addAt(CASINO, c.position[0], Math.max(c.position[1], cy), c.position[2], face);
    const gdn = planGardens(c.gardens.fountain, c.gardens.palms, c.gardens.flowerBeds, seededRng(11));
    bake.addAt(FOUNTAIN, c.gardens.fountain[0], c.gardens.fountain[1], c.gardens.fountain[2], 0);
    for (const b of gdn.beds) bake.addAt(FLOWERS, b.x, b.y, b.z, 0);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      bake.addAt(
        CYPRESS,
        c.gardens.fountain[0] + Math.cos(a) * 34,
        c.gardens.fountain[1],
        c.gardens.fountain[2] + Math.sin(a) * 34,
        0,
      );
    }
    const mats: THREE.Matrix4[][] = [[], []];
    const q = new THREE.Quaternion();
    const addPalm = (p: { x: number; y: number; z: number; yaw: number; model: number }, dy = 0): void => {
      mats[p.model % 2].push(
        new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y + dy, p.z), q.setFromAxisAngle(up, p.yaw), one),
      );
    };
    gdn.palms.forEach((p) => addPalm(p));
    const rnd = seededRng(13);
    // Quay palms every 14 m; main-straight palms every 18 m behind the fence on the infield side.
    const palmBlock: Obstacle[] = [
      ...standSites.map((p) => ({ x: p[0], z: p[2], r: 26 })),
      ...pitSites.map((p) => ({ x: p[0], z: p[2], r: 36 })),
    ];
    for (const p of alongSide(this.path, 0.585, 0.865, 14, 1, 9.6, palmBlock, rnd, 2)) addPalm(p);
    for (const p of alongSide(this.path, 0.0, 0.09, 18, -1, 11, palmBlock, rnd, 2)) addPalm(p);

    // Backdrop: the headland across the harbour and the cliff wall behind the city.
    const rk = raw.backdrop.rock.position;
    bake.addAt(ROCK, rk[0], rk[1], rk[2], Math.PI);
    const mt = raw.backdrop.mountains.position;
    bake.addAt(MOUNTAINS, mt[0], mt[1], mt[2], 0);
    bake.build(this.group, 'setpieces', SHADOWS.setpieces);

    const palmGroup = new THREE.Group();
    palmGroup.name = 'palms';
    PALMS.forEach((model, k) => instance(palmGroup, this.assets, model, mats[k], WINDOW.palms));
    this.reflectHide.push(palmGroup);
    this.group.add(palmGroup);
  }

  // ------------------------------------------------------------------------------------------------ harbour

  private buildHarbour(raw: {
    harbour: {
      pool: { position: [number, number, number]; yawDeg: number };
      yachts: { model: string; position: [number, number, number]; yawDeg: number }[];
      pontoons: { position: [number, number, number]; yawDeg: number }[];
      lights: { position: [number, number, number] }[];
    };
  }): void {
    const h = raw.harbour;
    const bake = new Bake(this.assets);
    this.baked.push(bake);
    // The generator's yaw is measured 90 degrees off three's: long pieces then lie along the quay.
    const yaw = (deg: number): number => THREE.MathUtils.degToRad(deg - 90);
    bake.addAt(POOL, h.pool.position[0], h.pool.position[1], h.pool.position[2], yaw(h.pool.yawDeg));
    const poolFp = { x: h.pool.position[0], z: h.pool.position[2] };
    for (const p of h.pontoons) {
      // A pontoon the pool deck already covers would poke through it.
      if (Math.hypot(p.position[0] - poolFp.x, p.position[2] - poolFp.z) < 42) continue;
      bake.addAt(PONTOON, p.position[0], p.position[1], p.position[2], yaw(p.yawDeg));
    }
    for (const l of h.lights) bake.addAt(HARBOUR_LIGHT, l.position[0], l.position[1], l.position[2], 0);
    const quay = new THREE.Group();
    quay.name = 'harbour_quay';
    bake.build(quay, 'harbour', false);
    this.reflectHide.push(quay);
    this.group.add(quay);

    // Rows of yachts beyond the second mooring line are only worth drawing close up (and never in the sea's mirror).
    const rows = [new Map<string, THREE.Matrix4[]>(), new Map<string, THREE.Matrix4[]>()];
    const q = new THREE.Quaternion();
    for (const y of h.yachts) {
      const { i, d } = this.index.nearest(y.position[0], y.position[2], 400);
      const far = Math.abs(this.index.lateral(i, y.position[0], y.position[2])) > 90 || d > 90 ? 1 : 0;
      const list = rows[far].get(y.model) ?? [];
      list.push(
        new THREE.Matrix4().compose(new THREE.Vector3(...y.position), q.setFromAxisAngle(up, yaw(y.yawDeg)), one),
      );
      rows[far].set(y.model, list);
    }
    const near = new THREE.Group();
    near.name = 'yachts';
    const farRows = new THREE.Group();
    farRows.name = 'yachts_far';
    for (const [model, mats] of rows[0]) instance(near, this.assets, model, mats, WINDOW.yachts);
    for (const [model, mats] of rows[1]) instance(farRows, this.assets, model, mats, WINDOW.yachtsFar);
    this.reflectHide.push(near, farRows);
    this.group.add(near, farRows);
  }

  private buildWater(): THREE.Mesh {
    const size = 7000;
    const geo = new THREE.PlaneGeometry(size, size);
    const sunDir = new THREE.Vector3(
      ...((this.def.daylight?.sun.dir ?? [-0.45, -0.75, 0.48]) as [number, number, number]),
    )
      .multiplyScalar(-1)
      .normalize();
    const cx = 300;
    const cz = 300;
    if (this.opts.reflections) {
      const normals = waterNormalTexture();
      this.disposables.push(normals);
      const water = new Water(geo, {
        textureWidth: 512,
        textureHeight: 512,
        waterNormals: normals,
        sunDirection: sunDir,
        sunColor: 0xffffff,
        waterColor: 0x0c4a66,
        distortionScale: 1.6,
        fog: true,
        clipBias: 0.0,
      });
      water.material.uniforms['size'].value = 2.2;
      water.rotation.x = -Math.PI / 2;
      water.position.set(cx, 0, cz);
      water.name = 'water';
      const base = water.onBeforeRender.bind(water);
      // The reflection pass renders the scene again: leave out what cannot be seen in the sea.
      water.onBeforeRender = (renderer, scene, camera, geometry, material, group): void => {
        const hidden: THREE.Object3D[] = [];
        const hide = (o: THREE.Object3D): void => {
          if (o.visible) {
            o.visible = false;
            hidden.push(o);
          }
        };
        for (const o of this.reflectHide) hide(o);
        // Cars, pickups, particles and the rest of the scene are not worth a second draw in a 512 px mirror.
        for (const o of scene.children) if (o !== this.group && !(o as THREE.Light).isLight) hide(o);
        const auto = renderer.shadowMap.autoUpdate;
        renderer.shadowMap.autoUpdate = false;
        base(renderer, scene, camera, geometry, material, group);
        renderer.shadowMap.autoUpdate = auto;
        for (const o of hidden) o.visible = true;
      };
      this.waterUniform = water.material.uniforms['time'];
      this.disposables.push(water.material, geo);
      return water;
    }
    const tex = this.assets.texture('textures/mc_sea.png').clone();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(size / 80, size / 80);
    tex.needsUpdate = true;
    this.seaMap = tex;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.08, metalness: 0.1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, 0, cz);
    mesh.name = 'water';
    this.disposables.push(mat, geo, tex);
    return mesh;
  }

  // ------------------------------------------------------------------------------------------------ helicopter

  private buildHelicopter(): THREE.Object3D {
    const heli = this.assets.cloneModel(HELI);
    heli.name = 'tv_helicopter';
    heli.traverse((o) => {
      if (o instanceof THREE.Mesh && !Array.isArray(o.material) && o.material.name === 'Rotor') {
        this.rotors.push(o);
        o.material.transparent = true;
      }
    });
    heli.visible = false;
    this.group.add(heli);
    return heli;
  }

  // ------------------------------------------------------------------------------------------------ per frame

  /** `playerT` drives the tunnel exposure; `leader` (the race leader's car) the helicopter. */
  update(dt: number, playerT: number, leader: LeaderState | null, sharedSec?: number): void {
    this.time = sharedSec ?? this.time + dt; // online: the race's tick clock, the same for every player
    this.viewProj.multiplyMatrices(this.opts.camera.projectionMatrix, this.opts.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    this.water.visible = this.frustum.intersectsBox(MonteCarlo.BASIN);
    if (this.waterUniform) this.waterUniform.value += dt * 0.5;
    if (this.seaMap) this.seaMap.offset.set((this.time * 0.02) / 80, (this.time * 0.013) / 80);

    // Tunnel: -1.5 EV inside (eased), a bloom flare on the way out.
    const inside = inRange(this.tunnel, playerT) ? 1 : 0;
    const k = Math.min(1, dt / TUNNEL_FADE_SEC);
    this.tunnelAmount += (inside - this.tunnelAmount) * k;
    if (this.wasInside && !inside) this.flare = EXIT_FLARE.boost;
    this.wasInside = inside === 1;
    this.flare = Math.max(0, this.flare - EXIT_FLARE.decayPerSec * dt);
    this.opts.hooks.setExposureMul(1 + (TUNNEL_EXPOSURE_MUL - 1) * this.tunnelAmount);
    this.opts.hooks.setBloomBoost(this.flare);
    this.opts.hooks.setFill(LIGHTING.monteCarlo.tunnelFill * this.tunnelAmount);

    // TV helicopter: 60 m up, 40 m behind and 30 m towards the harbour (south) of the race leader.
    if (leader) {
      const fx = Math.sin(leader.yaw);
      const fz = Math.cos(leader.yaw);
      const tx = leader.x - fx * HELI_OFFSET.behindM;
      const tz = leader.z - fz * HELI_OFFSET.behindM + HELI_OFFSET.sideM;
      const ty = leader.y + HELI_OFFSET.upM;
      if (!this.heliInit) {
        this.heliPos.set(tx, ty, tz);
        this.heliInit = true;
      } else {
        const a = 1 - Math.exp(-dt * 1.2);
        this.heliPos.x += (tx - this.heliPos.x) * a;
        this.heliPos.y += (ty - this.heliPos.y) * a;
        this.heliPos.z += (tz - this.heliPos.z) * a;
      }
      this.heli.visible = true;
      this.heli.position.copy(this.heliPos);
      this.heliYaw =
        Math.atan2(leader.x - this.heliPos.x, leader.z - this.heliPos.z) + Math.sin(this.time * 0.7) * 0.08;
      this.heli.rotation.set(Math.sin(this.time * 0.9) * 0.03, this.heliYaw, Math.sin(this.time * 0.6) * 0.04);
    }
    for (const r of this.rotors) r.rotation.y += dt * Math.PI * 2 * HELI_OFFSET.rotorRevPerSec;
  }

  /** The helicopter's world position (audio follows it). */
  get helicopterPosition(): THREE.Vector3 {
    return this.heliPos;
  }

  dispose(): void {
    this.opts.hooks.setExposureMul(1);
    this.opts.hooks.setBloomBoost(0);
    this.opts.hooks.setFill(0);
    for (const b of this.baked) b.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) o.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.env?.dispose();
    this.scene.environment = null;
    this.scene.environmentIntensity = 1;
    this.group.removeFromParent();
    void this.sky;
  }
}
