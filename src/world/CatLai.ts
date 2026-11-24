import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/Assets';
import { HANDLING, RACE, roadWidthAt, type TrackDef } from '../core/Data';
import osmJson from '../../data/tracks/cat_lai_osm.json';
import placementsJson from '../../data/tracks/cat_lai_placements.json';
import { mergeCarMaterials, mergePropMaterials } from '../vehicle/MergeMaterials';
import { seededRng } from './CongHoaDressing';
import { RoadIndex } from './monteCarloLayout';
import { protectSpecialMaterials, waterNormalTexture } from './MonteCarlo';
import { materialKey } from './Sponsors';
import { DistanceCull, windowInstancesInView } from './Windowed';
import {
  GROUND_Y,
  RoadGrid,
  clearBillboardLots,
  TIER_M,
  containerTint,
  dropOnRoad,
  ferryPose,
  inPolygon,
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
  roadClearance,
  shiftGate,
  type BillboardSite,
  type CatLaiPlacementData,
  type CatLaiQuay,
  type CatLaiRiver,
  type OsmData,
  type PlacedItem,
  type Stack,
} from './catLaiLayout';
import type { TrackPath } from './TrackPath';

type Rapier = typeof RAPIER;
type Quality = 'low' | 'med' | 'high';

const PLACEMENTS = placementsJson as unknown as CatLaiPlacementData;
const OSM = osmJson as unknown as OsmData;

const MODELS = 'models/props_catlai2/';
const TOWERS = ['a', 'b', 'c'].map((n) => `${MODELS}day_tower_${n}.glb`);
const FERRY_MODEL = `${MODELS}car_ferry.glb`;

/** Every GLB Map 1 loads, relative to /assets/ (the city bus and the billboards come with the other maps' sets). */
export const CAT_LAI_MODELS: string[] = [
  ...new Set([
    ...Object.values(PLACEMENTS.models).filter((m) => m.startsWith(MODELS)),
    ...Object.values(PLACEMENTS.containerModels),
    ...TOWERS,
    FERRY_MODEL,
  ]),
];

/** The bus is Map 3's; the billboards are Map 2's. Loaded with Map 1 so it does not depend on boot order. */
export const CAT_LAI_SHARED_MODELS: string[] = [
  ...Object.values(PLACEMENTS.models).filter((m) => !m.startsWith(MODELS)),
  ...['capturemann', 'craftmann', 'emesoft', 'voltline'].map((n) => `models/props_xalo/billboard_${n}.glb`),
];

/** Standalone textures; the props' own are embedded in their GLBs. */
export const CAT_LAI_TEXTURES: string[] = [
  'textures/catlai2_road.png',
  'textures/catlai2_concrete.png',
  'textures/catlai2_lane_paint.png',
  'textures/catlai2_river.png',
  'textures/catlai2_farbank.png',
];

/** Per quality preset: draw windows (m) for the container yard, trees, houses and everything else baked. */
const QUALITY = {
  low: { farM: 500, nearM: 170, treeM: 90, houseM: 260, furnM: 70, detailM: 50, yardM: 240, bigM: 800, craneM: 550 },
  med: { farM: 700, nearM: 210, treeM: 130, houseM: 340, furnM: 100, detailM: 65, yardM: 300, bigM: 900, craneM: 700 },
  high: {
    farM: 800,
    nearM: 250,
    treeM: 150,
    houseM: 360,
    furnM: 110,
    detailM: 75,
    yardM: 340,
    bigM: 1000,
    craneM: 800,
  },
} as const;

/** Cell sizes (m) of the baked classes. */
const CELL = { big: 300, crane: 300, yard: 160, street: 120, furniture: 60, detail: 40 } as const;
type PropClass = keyof typeof CELL;

const CLASS_OF = (key: string): PropClass => {
  if (/^sts/.test(key)) return 'crane';
  if (/^(ship|barge|tug|cfs|office|tank|gate|mast|landing|quay)/.test(key)) return 'big';
  if (/^(rtg|reefer|rs|tt_)/.test(key)) return 'yard';
  if (/^(truck|moto|bus|workers|street$)/.test(key)) return 'detail';
  if (/^(pole|tree_)/.test(key)) return 'furniture';
  return 'street';
};

const up = new THREE.Vector3(0, 1, 0);

/** The gradient dome: zenith -> mid -> horizon with a sun disc and glow (three's Sky.js washes out at this sun height). */
function skyMaterial(
  sky: { zenith: string; mid: string; horizon: string },
  sunDir: THREE.Vector3,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      sunDir: { value: sunDir },
      zen: { value: new THREE.Color(sky.zenith) },
      mid: { value: new THREE.Color(sky.mid) },
      hor: { value: new THREE.Color(sky.horizon) },
    },
    vertexShader:
      'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 sunDir; uniform vec3 zen; uniform vec3 mid; uniform vec3 hor; varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y, -0.2, 1.0);
        vec3 c = mix(hor, mid, smoothstep(0.0, 0.25, h));
        c = mix(c, zen, smoothstep(0.25, 0.9, h));
        if (h < 0.0) c = hor * 0.92;
        float sd = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        c += vec3(1.0, 0.92, 0.75) * (pow(sd, 400.0) * 6.0 + pow(sd, 12.0) * 0.25);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

/** Identity of a draw: textured parts by their texture alone (the 8 tube-house variants share one atlas), the rest as `materialKey`. */
function bakeKey(m: THREE.Material): string {
  const s = m as THREE.MeshStandardMaterial;
  const img = s.map?.image as { width?: number; height?: number } | null | undefined;
  if (!m.userData.shared && s.map?.name) return `tex:${s.map.name}:${img?.width}x${img?.height}|${s.color.getHex()}`;
  return materialKey(m);
}

interface Cell {
  cx: number;
  cz: number;
  sumX: number;
  sumZ: number;
  n: number;
  buckets: Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>;
}

/**
 * Bakes static props into one merged mesh per material per square cell of one class; each cell is drawn only while the
 * camera is within the class's window. Models are cloned once and shared by every cell.
 */
class BakeGrid {
  private readonly cells = new Map<string, Cell>();
  private readonly world = new THREE.Matrix4();

  constructor(
    private readonly protos: Map<string, THREE.Object3D>,
    private readonly assets: Assets,
    private readonly cellM: number,
  ) {}

  private cell(x: number, z: number): Cell {
    const cx = Math.floor(x / this.cellM);
    const cz = Math.floor(z / this.cellM);
    const k = `${cx},${cz}`;
    let c = this.cells.get(k);
    if (!c) {
      c = { cx, cz, sumX: 0, sumZ: 0, n: 0, buckets: new Map() };
      this.cells.set(k, c);
    }
    return c;
  }

  private bucket(c: Cell, key: string, material: THREE.Material): THREE.BufferGeometry[] {
    let b = c.buckets.get(key);
    if (!b) {
      b = { material, geos: [] };
      c.buckets.set(key, b);
    }
    return b.geos;
  }

  /** A plain two-sided part (awnings, flags) gets a flipped copy of its triangles and goes one-sided, so it can merge. */
  private static flipDouble(mesh: THREE.Mesh, mat: THREE.MeshStandardMaterial): void {
    const src = mesh.geometry;
    const n = src.getAttribute('position').count;
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

  /**
   * Baked props never change at runtime and it is daylight: lamps lose their glow (and the names that keep them out of
   * the merge) and two-sided plain parts are made one-sided, so a cell costs a handful of draws instead of dozens.
   */
  private static prepare(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      const m = o.material as THREE.MeshStandardMaterial;
      if (!m.map && m.emissiveIntensity > 0) {
        m.emissive.set(0x000000);
        m.emissiveIntensity = 0;
      }
      if (/^Light_|^Underglow$/.test(m.name)) m.name = `Static_${m.name}`;
      if (m.side === THREE.DoubleSide && !m.map && !m.transparent && m.alphaTest === 0) BakeGrid.flipDouble(o, m);
    });
  }

  proto(model: string): THREE.Object3D {
    let p = this.protos.get(model);
    if (!p) {
      p = this.assets.cloneModel(model);
      BakeGrid.prepare(p);
      protectSpecialMaterials(p);
      // One vertex-colour material for every plain part (no separate metal bucket): fewer draws per baked cell.
      mergeCarMaterials(p, () => true);
      p.updateMatrixWorld(true);
      this.protos.set(model, p);
    }
    return p;
  }

  add(model: string, at: THREE.Matrix4): void {
    const proto = this.proto(model);
    const x = at.elements[12];
    const z = at.elements[14];
    const c = this.cell(x, z);
    c.sumX += x;
    c.sumZ += z;
    c.n++;
    proto.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      this.world.multiplyMatrices(at, o.matrixWorld);
      this.bucket(c, bakeKey(o.material), o.material).push(o.geometry.clone().applyMatrix4(this.world));
    });
  }

  /** A hand-made geometry (the mapped buildings) in the cell of (x, z), under its own material. */
  addGeometry(x: number, z: number, key: string, material: THREE.Material, geo: THREE.BufferGeometry): void {
    const c = this.cell(x, z);
    c.sumX += x;
    c.sumZ += z;
    c.n++;
    this.bucket(c, key, material).push(geo);
  }

  /** Builds the meshes under `parent`, each cell behind a distance cull. Returns the meshes. */
  build(parent: THREE.Object3D, name: string, windowM: number, keepAlways = false): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const half = this.cellM / 2;
    for (const c of this.cells.values()) {
      const cull = new DistanceCull(
        new THREE.Vector3(c.sumX / c.n, GROUND_Y, c.sumZ / c.n),
        keepAlways ? 1e9 : windowM,
        half * Math.SQRT2,
      );
      for (const [key, b] of c.buckets) {
        const common = Object.keys(b.geos[0].attributes).filter((a) => b.geos.every((g) => g.getAttribute(a)));
        for (const g of b.geos)
          for (const a of Object.keys(g.attributes)) if (!common.includes(a)) g.deleteAttribute(a);
        const merged = mergeGeometries(b.geos, false);
        b.geos.forEach((g) => g.dispose());
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, b.material);
        mesh.name = `${name}_${c.cx}_${c.cz}:${key}`;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        cull.add(mesh);
        out.push(mesh);
      }
      parent.add(cull);
    }
    this.cells.clear();
    return out;
  }
}

/** One InstancedMesh per sub-mesh of `model` with optional per-instance colours, drawn only near the camera. */
function windowed(
  parent: THREE.Object3D,
  assets: Assets,
  model: string,
  mats: readonly THREE.Matrix4[],
  colours: readonly THREE.Color[] | null,
  windowM: number,
  name: string,
  nearM = 40,
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
    inst.name = `${name}:${o.name}`;
    for (let i = 0; i < mats.length; i++) {
      inst.setMatrixAt(i, tmp.multiplyMatrices(mats[i], o.matrixWorld));
      if (colours) inst.setColorAt(i, colours[i]);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = false;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    parent.add(inst);
    out.push(inst);
  });
  windowInstancesInView(out, windowM, { nearM });
  return out;
}

const pose = (x: number, y: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1): THREE.Matrix4 =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(up, yaw),
    new THREE.Vector3(sx, sy, sz),
  );

/**
 * Cat Lai Port v2 (Map 1, daylight): the sky dome, the river and the port slab, the OpenStreetMap surroundings, the
 * designed props (cranes, ships, gate, houses, queue), ~35,000 containers, the ferry and the colliders of the solid
 * things near the road. The road itself, its kerbs, walls, gates and the start gantry are `Track`'s.
 */
export class CatLai {
  readonly group = new THREE.Group();
  readonly index: RoadIndex;
  /** Items kept after the on-the-road filter, for tests and tooling. */
  readonly items: PlacedItem[];
  readonly stacks: Stack[];
  readonly boards: BillboardSite[];
  private readonly clearance: ReturnType<typeof roadClearance>;
  private readonly body: RAPIER.RigidBody;
  private readonly quality: (typeof QUALITY)[Quality];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly protos = new Map<string, THREE.Object3D>();
  private readonly sky: THREE.Mesh;
  private readonly water: THREE.Mesh;
  private readonly waterNormal: THREE.Texture;
  private readonly ferries: { object: THREE.Object3D; offset: number }[] = [];
  private readonly landings: [[number, number], [number, number]];
  private readonly cycleSec: number;
  private clock = 0;
  private envTarget: THREE.WebGLRenderTarget | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    R: Rapier,
    private readonly world: RAPIER.World,
    private readonly assets: Assets,
    private readonly def: TrackDef,
    private readonly path: TrackPath,
    private readonly opts: { camera: THREE.Camera; renderer: THREE.WebGLRenderer; quality: Quality },
  ) {
    this.group.name = 'cat_lai';
    this.quality = QUALITY[opts.quality];
    this.index = new RoadIndex(path, 2);
    this.clearance = roadClearance(this.index, def);
    const raw = def.raw as { river: CatLaiRiver; quay: CatLaiQuay };
    const river = raw.river;
    const quay = raw.quay;
    const port = portPolygon(quay);
    const inPort = (x: number, z: number): boolean => inPolygon(x, z, port);
    const shore = river.shoreline.map((p): [number, number] => [p[0], p[2]]);
    const land: [number, number][] = [...shore, [2100, -3200], [-2600, -3200], [-2600, shore[0][1]]];
    const far: [number, number][] = [
      ...river.farBank.map((p): [number, number] => [p[0], p[2]]),
      [2800, 3200],
      [-1200, 3200],
    ];
    const onLand = (x: number, z: number): boolean => inPolygon(x, z, land);
    this.landings = [
      [river.ferry.landingHCMC[0], river.ferry.landingHCMC[2]],
      [river.ferry.landingNhonTrach[0], river.ferry.landingNhonTrach[2]],
    ];
    this.cycleSec = river.ferry.crossingSec;

    // The designed props, minus the ones that landed on the carriageway.
    const tOf = (x: number, z: number): number => this.path.project(x, z);
    const startZone: [number, number][] = [[1 - 50 / path.lengthM, 1]];
    startZone.push([0, 8 / path.lengthM]);
    const len = path.lengthM;
    this.boards = planBillboards(
      path,
      def,
      [
        [70, 420],
        [len - 330, len - 60],
      ],
      62,
      9,
    );
    this.items = clearBillboardLots(
      dropOnRoad(shiftGate(planPlacements(PLACEMENTS)), this.clearance, { keepClearT: startZone, tOf }),
      this.boards,
    );
    const yard = planYard(PLACEMENTS.yardBlocks, this.clearance);
    this.stacks = yard.stacks;

    this.sky = this.buildSky();
    this.buildLand(land, far, port);
    this.water = this.buildRiver(shore);
    this.waterNormal = (this.water.material as THREE.MeshPhysicalMaterial).normalMap as THREE.Texture;
    this.buildFarBank(river);
    this.buildPaint();
    this.buildStatic(inPort, onLand);
    this.buildYard();
    this.buildFerries();
    this.body = this.buildColliders(R);
    scene.add(this.group);
  }

  // ------------------------------------------------------------------------------------------------ sky + light

  /** The dome, and an environment map baked from it so the cars' paint and glass pick up the sky. */
  private buildSky(): THREE.Mesh {
    const day = this.def.daylight;
    if (!day?.skyGradient) throw new Error('Cat Lai needs lighting.sky');
    const sunDir = new THREE.Vector3(-day.sun.dir[0], -day.sun.dir[1], -day.sun.dir[2]).normalize();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 16), skyMaterial(day.skyGradient, sunDir));
    dome.name = 'sky';
    dome.renderOrder = -1000;
    dome.frustumCulled = false;
    this.group.add(dome);
    this.disposables.push(dome.geometry, dome.material as THREE.Material);
    // Scene.background stays a flat colour under the dome (Lighting set the gradient texture: not needed here).
    this.scene.background = new THREE.Color(day.skyGradient.horizon);
    const pm = new THREE.PMREMGenerator(this.opts.renderer);
    const envScene = new THREE.Scene();
    const envDome = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMaterial(day.skyGradient, sunDir));
    envScene.add(envDome);
    this.envTarget = pm.fromScene(envScene);
    pm.dispose();
    envDome.geometry.dispose();
    (envDome.material as THREE.Material).dispose();
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.62;
    return dome;
  }

  // ------------------------------------------------------------------------------------------------ land, river, bank

  /** The concrete texture, tiled by UV (the geometry's UVs are metres / 32: the road ribbon shares the texture). */
  private concrete(): THREE.Texture {
    const t = this.assets.texture('textures/catlai2_concrete.png');
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }

  /** A flat polygon at `y` (shape space is (x, -z); a -90 degree turn about X lays it flat). */
  private flat(
    poly: readonly [number, number][],
    y: number,
    mat: THREE.Material,
    name: string,
    holes: [number, number][][] = [],
  ): THREE.Mesh {
    const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
    for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    // World-space UVs (one repeat per 32 m) so the slabs and every ribbon on top line up.
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 32, pos.getZ(i) / 32);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = y;
    mesh.name = name;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
    return mesh;
  }

  private buildLand(land: [number, number][], far: [number, number][], port: [number, number][]): void {
    // Ground layers at one height would z-fight (the depth buffer cannot split 3 cm at 700 m), so none of them writes
    // depth: they draw in order (river, land, far bank, port slab) and everything standing on them tests against the
    // river's depth 2 m below, which is always behind it.
    const layer = (m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial => {
      m.depthWrite = false;
      return m;
    };
    const urban = layer(new THREE.MeshStandardMaterial({ map: this.concrete(), color: '#96917F', roughness: 0.95 }));
    this.flat(land, GROUND_Y, urban, 'land').renderOrder = -2;
    const bank = layer(new THREE.MeshStandardMaterial({ color: '#5C7A3C', roughness: 1 }));
    this.flat(far, 1.4, bank, 'far_bank').renderOrder = -2;
    const slab = layer(new THREE.MeshStandardMaterial({ map: this.concrete(), color: '#BDBBB3', roughness: 0.9 }));
    this.flat(port, GROUND_Y, slab, 'port_slab').renderOrder = -1;
  }

  private buildRiver(shore: [number, number][]): THREE.Mesh {
    const m = (
      this.def.raw.river as {
        material: { color: string; roughness: number; clearcoat: number; normalMapTileM: number };
      }
    ).material;
    const map = this.assets.texture('textures/catlai2_river.png');
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(1 / 64, 1 / 64);
    map.needsUpdate = true;
    const normal = waterNormalTexture(128);
    normal.repeat.set(1 / m.normalMapTileM, 1 / m.normalMapTileM);
    const size = 6000;
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    const uv = geo.getAttribute('uv');
    const pos = geo.getAttribute('position');
    // World-space UVs: the textures' repeat is per metre.
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) + 700, pos.getZ(i));
    const low = this.opts.quality === 'low';
    const params = {
      color: m.color,
      map,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.3, 0.3),
      roughness: m.roughness,
      metalness: 0,
      envMapIntensity: 0.55,
    };
    const mat = low
      ? new THREE.MeshStandardMaterial(params)
      : new THREE.MeshPhysicalMaterial({ ...params, clearcoat: m.clearcoat, clearcoatRoughness: 0.2 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(700, 0, 0);
    mesh.name = 'river';
    mesh.renderOrder = -3;
    this.group.add(mesh);
    this.disposables.push(geo, mat, normal);
    // The vertical quay wall along the shoreline, from the quay top down under the water.
    const pts = shore;
    const wp: number[] = [];
    const wi: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      wp.push(pts[i][0], GROUND_Y, pts[i][1], pts[i][0], -3, pts[i][1]);
      if (i > 0) {
        const k = i * 2;
        wi.push(k - 2, k - 1, k, k - 1, k + 1, k);
      }
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
    wg.setIndex(wi);
    wg.computeVertexNormals();
    const wm = new THREE.MeshStandardMaterial({ color: '#8E8A80', roughness: 0.95, side: THREE.DoubleSide });
    const wall = new THREE.Mesh(wg, wm);
    wall.name = 'quay_wall';
    this.group.add(wall);
    this.disposables.push(wg, wm);
    return mesh;
  }

  /** The far bank's trees and houses as one tall alpha strip along the bank line. */
  private buildFarBank(river: CatLaiRiver): void {
    const pts = river.farBank.map((p): [number, number] => [p[0], p[2]]);
    const tex = this.assets.texture('textures/catlai2_farbank.png');
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    const H = 42;
    const REPEAT_M = 336;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let along = 0;
    pts.forEach(([x, z], i) => {
      if (i > 0) along += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      pos.push(x, 1.4 - 2, z, x, 1.4 + H, z);
      uv.push(along / REPEAT_M, 0, along / REPEAT_M, 1);
      if (i > 0) {
        const k = i * 2;
        idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, fog: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'far_bank_strip';
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  // ------------------------------------------------------------------------------------------------ road paint

  /**
   * The yellow lane paint over the port's concrete road (Gate B to the north road). The texture also carries a
   * "GIAM TOC / 15 km/h" legend and arrows: those show once, on the gate stretch; elsewhere only the dashed centre line
   * and the edge lines (the upper half of the tile) repeat, in whole dash periods per 12 samples.
   */
  private buildPaint(): void {
    const { path, def } = this;
    const n = path.count;
    const profile = def.widthProfile.find((p) => p.worldTileM);
    if (!profile) return;
    const sections = (def.raw.sections as { id: string; fromT: number; toT: number }[]).filter(
      (s) => s.id !== 'NTD' && s.id !== 'LINK',
    );
    const gate = sections.find((s) => s.id === 'GATE');
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const y = RACE.track.roadY + 0.02;
    const i0 = Math.floor(profile.fromT * n);
    const i1 = Math.floor(profile.toT * n);
    const GROUP = 12;
    for (let i = i0; i < i1; i++) {
      const t0 = i / n;
      const inGate = gate ? t0 >= gate.fromT && t0 <= gate.toT : false;
      const a = i;
      const b = (i + 1) % n;
      const base = pos.length / 3;
      for (const k of [a, b]) {
        const half = roadWidthAt(def, k / n) / 2;
        const lx = path.tz[k];
        const lz = -path.tx[k];
        pos.push(path.px[k] + lx * half, path.py[k] + y, path.pz[k] + lz * half);
        pos.push(path.px[k] - lx * half, path.py[k] + y, path.pz[k] - lz * half);
      }
      let v0: number;
      let v1: number;
      if (inGate) {
        v0 = (i * path.spacingM) / 46;
        v1 = ((i + 1) * path.spacingM) / 46;
      } else {
        const g = (i - i0) % GROUP;
        v0 = 0.5 + (0.5 * g) / GROUP;
        v1 = 0.5 + (0.5 * (g + 1)) / GROUP;
      }
      // Vertex order: left(a), right(a), left(b), right(b); u 0 = left edge.
      uv.push(0, v0, 1, v0, 0, v1, 1, v1);
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const tex = this.assets.texture('textures/catlai2_lane_paint.png');
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      roughness: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'lane_paint';
    mesh.renderOrder = 1;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  // ------------------------------------------------------------------------------------------------ static props

  private buildStatic(inPort: (x: number, z: number) => boolean, onLand: (x: number, z: number) => boolean): void {
    const q = this.quality;
    const grids: Record<PropClass, BakeGrid> = {
      big: new BakeGrid(this.protos, this.assets, CELL.big),
      crane: new BakeGrid(this.protos, this.assets, CELL.crane),
      yard: new BakeGrid(this.protos, this.assets, CELL.yard),
      street: new BakeGrid(this.protos, this.assets, CELL.street),
      furniture: new BakeGrid(this.protos, this.assets, CELL.furniture),
      detail: new BakeGrid(this.protos, this.assets, CELL.detail),
    };
    const m = new THREE.Matrix4();
    for (const it of this.items) {
      if (it.key === 'ferry') continue; // animated
      grids[CLASS_OF(it.key)].add(it.model, m.copy(pose(it.x, it.y, it.z, it.rotY, it.scale, it.scale, it.scale)));
    }

    // Rooftop billboards along Nguyen Thi Dinh, facing the traffic, brands alternating.
    const len = this.path.lengthM;
    const boards = planBillboards(
      this.path,
      this.def,
      [
        [70, 420],
        [len - 330, len - 60],
      ],
      62,
      9,
    );
    for (const b of boards) grids.street.add(b.model, pose(b.x, b.y + 15.8, b.z, b.rotY));

    // OSM surroundings within reach of the lap.
    const centres = lapCentres(this.path, 150);
    const roads = osmRoadsNear(OSM, centres, 520);
    const grid = new RoadGrid(25);
    for (const r of roads) grid.addPolyline(r.pts, r.w);
    for (let i = 0; i < this.path.count; i += 3) {
      grid.add(this.path.px[i], this.path.pz[i], roadWidthAt(this.def, i / this.path.count) + 3);
    }
    const near = (x: number, z: number): boolean => this.index.distance(x, z) < 480;
    const frontage = planFrontage(roads, grid, { inPort, onLand, keep: near, variants: 8, seed: 78 });
    for (const f of frontage) {
      grids.street.add(PLACEMENTS.models[`house_${f.variant}`], pose(f.x, GROUND_Y, f.z, f.rotY));
    }
    this.buildMappedBuildings(grids.street, roads, grid, inPort, near);
    this.buildOsmRoads(roads, inPort);

    // Skyline: the Thu Duc towers to the north-west.
    const rng = seededRng(5);
    for (let k = 0; k < 26; k++) {
      const x = -1800 + rng() * 1700;
      const z = -(700 + rng() * 1600);
      const model = TOWERS[Math.floor(rng() * TOWERS.length)];
      const yaw = 0.6 + (rng() - 0.5) * 0.3;
      if (inPort(x, z) || this.index.distance(x, z) < 80) continue;
      grids.big.add(model, pose(x, GROUND_Y, z, yaw));
    }
    // Trees on open land.
    this.buildTrees(grid, inPort, onLand);

    const baked: [PropClass, number][] = [
      ['big', q.bigM],
      ['crane', q.craneM],
      ['yard', q.yardM],
      ['street', q.houseM],
      ['furniture', q.furnM],
      ['detail', q.detailM],
    ];
    const g = new THREE.Group();
    g.name = 'static';
    for (const [cls, w] of baked) grids[cls].build(g, `static_${cls}`, w);
    this.group.add(g);
  }

  /** The OSM building points as plain boxes (the file carries no footprints), vertex-coloured, baked per cell. */
  private buildMappedBuildings(
    cells: BakeGrid,
    roads: Parameters<typeof planMappedBuildings>[2],
    grid: RoadGrid,
    inPort: (x: number, z: number) => boolean,
    keep: (x: number, z: number) => boolean,
  ): void {
    const boxes = planMappedBuildings(OSM, grid, roads, inPort, keep, 77);
    const palette = ['#E6E0D4', '#D9D2C2', '#C9D3DA', '#E8D9C4', '#BFC8CF', '#D4C4B0'].map((c) => new THREE.Color(c));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    mat.userData.shared = false;
    this.disposables.push(mat);
    const rng = seededRng(79);
    const c = new THREE.Color();
    for (const b of boxes) {
      const geo = new THREE.BoxGeometry(b.w, b.h, b.d);
      geo.translate(0, b.h / 2, 0);
      geo.deleteAttribute('uv');
      const colour = palette[Math.floor(rng() * palette.length)];
      const roof = new THREE.Color('#8A5E4E');
      const n = geo.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      const nrm = geo.getAttribute('normal');
      for (let i = 0; i < n; i++) {
        c.copy(nrm.getY(i) > 0.5 ? roof : colour);
        col.set([c.r, c.g, c.b], i * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.applyMatrix4(pose(b.x, GROUND_Y, b.z, b.rotY));
      cells.addGeometry(b.x, b.z, 'mapped_building', mat, geo);
    }
  }

  private buildOsmRoads(
    roads: Parameters<typeof planMappedBuildings>[2],
    inPort: (x: number, z: number) => boolean,
  ): void {
    const strips = osmRoadStrips(roads, this.clearance, inPort, GROUND_Y + 0.03);
    if (strips.indices.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(strips.positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(strips.uvs, 2));
    geo.setIndex(strips.indices);
    geo.computeVertexNormals();
    const tex = this.assets.texture('textures/catlai2_road.png');
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    // Only the plain asphalt is wanted: crop to the texture's lane-less upper area by tinting; the lane lines are faint.
    const mat = new THREE.MeshStandardMaterial({ map: tex, color: '#9A9A9A', roughness: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'osm_roads';
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  private buildTrees(
    grid: RoadGrid,
    inPort: (x: number, z: number) => boolean,
    onLand: (x: number, z: number) => boolean,
  ): void {
    const bounds = { x0: -1100, x1: 2300, z0: -1300, z1: 700 };
    const sites = planTrees(
      bounds,
      26,
      grid,
      (x, z) => onLand(x, z) && !inPort(x, z) && this.index.distance(x, z) < 330,
      79,
    );
    const model = [PLACEMENTS.models.tree_a, PLACEMENTS.models.tree_b];
    for (const variant of [0, 1]) {
      const list = sites.filter((s) => s.variant === variant);
      const mats = list.map((s) => pose(s.x, GROUND_Y, s.z, (s.x * 7.3 + s.z * 3.1) % 6.28, s.scale, s.scale, s.scale));
      const cols = list.map((s) => new THREE.Color().setHSL(s.hue, s.sat, s.light));
      windowed(this.group, this.assets, model[variant], mats, cols, this.quality.treeM, `trees_${variant}`);
    }
  }

  // ------------------------------------------------------------------------------------------------ containers

  /**
   * ~35,000 boxes. Near the camera every tier is its own instance; farther out a stack is ONE box scaled to its
   * height (a fifth of the triangles), tucked 1.5 % inside the near boxes so the two never flicker where they overlap.
   * One InstancedMesh per size per range, each windowed by distance.
   */
  private buildYard(): void {
    const palette = PLACEMENTS.containerColours.map((c) => new THREE.Color(c));
    const sizes: [number, string][] = [
      [12.19, PLACEMENTS.containerModels['12.19']],
      [6.06, PLACEMENTS.containerModels['6.06']],
    ];
    const q = this.quality;
    for (const [len, model] of sizes) {
      const mine = this.stacks.filter((s) => s.len === len);
      const nearMats: THREE.Matrix4[] = [];
      const nearCols: THREE.Color[] = [];
      const farMats: THREE.Matrix4[] = [];
      const farCols: THREE.Color[] = [];
      let seed = len === 12.19 ? 1 : 100003;
      for (const s of mine) {
        const stackTint = containerTint(seed++, palette.length);
        farMats.push(pose(s.x, GROUND_Y, s.z, s.rotY, 0.985, s.h, 0.985));
        farCols.push(palette[stackTint.index].clone().multiplyScalar(stackTint.mul));
        for (let t = 0; t < s.h; t++) {
          const tint = containerTint(seed++, palette.length);
          nearMats.push(pose(s.x, GROUND_Y + t * TIER_M, s.z, s.rotY));
          nearCols.push(palette[tint.index].clone().multiplyScalar(tint.mul));
        }
      }
      const g = new THREE.Group();
      g.name = `containers_${len}`;
      windowed(g, this.assets, model, nearMats, nearCols, q.nearM, `near_${len}`);
      windowed(g, this.assets, model, farMats, farCols, q.farM, `far_${len}`);
      this.group.add(g);
    }
  }

  // ------------------------------------------------------------------------------------------------ ferry

  private buildFerries(): void {
    // Two boats on the one crossing, half a cycle apart: one is always sailing each way.
    for (const offset of [0.2, 0.7]) {
      const object = this.assets.cloneModel(FERRY_MODEL);
      protectSpecialMaterials(object);
      mergePropMaterials(object);
      object.name = 'ferry';
      this.ferries.push({ object, offset });
      this.group.add(object);
    }
    this.placeFerries();
  }

  private placeFerries(): void {
    for (const f of this.ferries) {
      const p = ferryPose(this.landings[0], this.landings[1], this.clock, this.cycleSec, f.offset);
      f.object.position.set(p.x, 0, p.z);
      f.object.rotation.y = p.rotY;
    }
  }

  // ------------------------------------------------------------------------------------------------ colliders

  private buildColliders(R: Rapier): RAPIER.RigidBody {
    const boxes = planColliders(this.items, this.stacks, PLACEMENTS.yardBlocks, this.clearance);
    const body = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    for (const b of boxes) {
      this.world.createCollider(
        R.ColliderDesc.cuboid(b.hx, b.hy, b.hz)
          .setTranslation(b.x, b.y, b.z)
          .setRotation({ x: 0, y: Math.sin(b.rotY / 2), z: 0, w: Math.cos(b.rotY / 2) })
          .setFriction(HANDLING.world.groundFriction),
        body,
      );
    }
    return body;
  }

  // ------------------------------------------------------------------------------------------------ per frame

  update(dt: number): void {
    this.clock += dt;
    this.sky.position.copy(this.opts.camera.position);
    this.placeFerries();
    // Ripples drift slowly.
    this.waterNormal.offset.x += dt * 0.0008;
    this.waterNormal.offset.y += dt * 0.0005;
  }

  dispose(): void {
    this.world.removeRigidBody(this.body);
    this.scene.environment = null;
    this.scene.environmentIntensity = 1;
    this.envTarget?.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) o.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
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
    this.group.removeFromParent();
    this.scene.remove(this.group);
  }
}
