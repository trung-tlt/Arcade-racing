import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import type { TrackDef } from '../core/Data';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import type { TrackPath } from './TrackPath';
import { drawDistance, windowInstances } from './Windowed';

type Rapier = typeof RAPIER;

const P = 'models/props_xalo/';
const SEGMENT = `${P}river_bridge_segment.glb`;
const PIER = `${P}river_bridge_pier.glb`;
const UNDER_OPEN = `${P}underpass_open.glb`;
const UNDER_COVERED = `${P}underpass_covered.glb`;

/** Every model this module loads (for the track's asset list). */
export const XALO_STRUCTURE_MODELS: string[] = [SEGMENT, PIER, UNDER_OPEN, UNDER_COVERED];

/** Model facts read from the GLBs (metres). */
const DECK_WIDTH_M = 32;
/** The deck top sits this far below the road ribbon (the ribbon itself is 0.03 above the spline). */
const DECK_BELOW_ROAD_M = 0.05;
const RIBBON_LIFT_M = 0.03;
const WATER_Y = -1.5;
/** Deck centre sits this far west (left of the outbound heading) of the outbound centreline. */
const DECK_WEST_SHIFT_M = 10;
const RIVER_HALF_SPAN_M = 3000;
const RIVER_OVERLAP_M = 2;
const TRENCH_PAD_M = 12;
const TRENCH_Y = -0.3;
const TRENCH_MARGIN_M = 6;
const UNDERPASS_SEGMENT_FALLBACK_M = 20;
/** Return-leg road below this height needs no deck. */
const RETURN_MIN_ROAD_Y = 1;
const RETURN_FROM_T = 0.86;

interface BridgeJson {
  fromN: number;
  toN: number;
  segmentLengthM: number;
}
interface RiverJson {
  fromN: number;
  toN: number;
  color: string;
}
interface UnderpassJson {
  fromN: number;
  toN: number;
  coveredFromN: number;
  coveredToN: number;
  segmentLengthM: number;
}

const raw = <T>(track: TrackDef, key: string): T => {
  const v = track.raw[key];
  if (!v || typeof v !== 'object') throw new Error(`${track.id}: missing "${key}" block`);
  return v as T;
};

/** Along-track distance N (m from the start line, may be negative) → wrapped t. */
const tOfN = (path: TrackPath, n: number): number => (((n / path.lengthM) % 1) + 1) % 1;

type Poly = [number, number][];

// ---------------------------------------------------------------------------------------------
// Pure geometry: terrain holes
// ---------------------------------------------------------------------------------------------

/** World (x, z) quad of the river band: N river.fromN..toN along the outbound leg, ±3 km across it. */
function riverPolygon(track: TrackDef, path: TrackPath, margin = 0): Poly {
  const river = raw<RiverJson>(track, 'river');
  const a = path.pointAt(tOfN(path, river.fromN));
  const b = path.pointAt(tOfN(path, river.toN));
  // Orient with the outbound heading at the middle of the band.
  const m = path.tangentAt(tOfN(path, (river.fromN + river.toN) / 2));
  const h = Math.hypot(m.x, m.z) || 1;
  const hx = m.x / h;
  const hz = m.z / h;
  const lx = hz; // left of heading
  const lz = -hx;
  const span = RIVER_HALF_SPAN_M;
  // Walk each edge along the heading so the band edges are perpendicular to the road.
  const along = (p: { x: number; z: number }, d: number): [number, number] => [p.x + hx * d, p.z + hz * d];
  const [ax, az] = along(a, -margin);
  const [bx, bz] = along(b, margin);
  return [
    [ax + lx * span, az + lz * span],
    [ax - lx * span, az - lz * span],
    [bx - lx * span, bz - lz * span],
    [bx + lx * span, bz + lz * span],
  ];
}

/**
 * Polygons cut out of the visible land plane, in world (x, z): the river band and the underpass trench.
 * The trench is the longest run of spline samples inside the underpass N range with road y below -0.3,
 * widened to the road half-width + 6 m on each side.
 */
export function xaLoTerrainHoles(track: TrackDef, path: TrackPath): [number, number][][] {
  const holes: [number, number][][] = [riverPolygon(track, path)];

  const u = raw<UnderpassJson>(track, 'underpass');
  const half = track.roadWidthM / 2 + TRENCH_MARGIN_M;
  const spacing = path.spacingM;
  const first = Math.ceil(u.fromN / spacing);
  const last = Math.floor(u.toN / spacing);
  let best: number[] = [];
  let run: number[] = [];
  for (let i = first; i <= last; i++) {
    const idx = ((i % path.count) + path.count) % path.count;
    if (path.py[idx] < TRENCH_Y) {
      run.push(idx);
    } else {
      if (run.length > best.length) best = run;
      run = [];
    }
  }
  if (run.length > best.length) best = run;
  if (best.length >= 2) {
    // The dip does not stop exactly at the data's N range: follow it to where the road is back above the trench
    // threshold, plus a short margin, so the land never covers (or ledges across) the ramp out of the trench.
    const n = path.count;
    const padM = Math.ceil(TRENCH_PAD_M / spacing);
    let a = best[0];
    let b = best[best.length - 1];
    while (path.py[(a - 1 + n) % n] < TRENCH_Y && best.length < n / 4) {
      a = (a - 1 + n) % n;
      best.unshift(a);
    }
    while (path.py[(b + 1) % n] < TRENCH_Y && best.length < n / 4) {
      b = (b + 1) % n;
      best.push(b);
    }
    for (let k = 0; k < padM; k++) {
      a = (a - 1 + n) % n;
      b = (b + 1) % n;
      best.unshift(a);
      best.push(b);
    }
    const left: Poly = [];
    const right: Poly = [];
    for (const i of best) {
      const lx = path.tz[i];
      const lz = -path.tx[i];
      left.push([path.px[i] + lx * half, path.pz[i] + lz * half]);
      right.push([path.px[i] - lx * half, path.pz[i] - lz * half]);
    }
    holes.push([...left, ...right.reverse()]);
  }
  return holes;
}

// ---------------------------------------------------------------------------------------------
// Placement (pure)
// ---------------------------------------------------------------------------------------------

export interface Placement {
  x: number;
  y: number;
  z: number;
  /** Unit forward direction (3D, follows the road slope). */
  fx: number;
  fy: number;
  fz: number;
  /** Along-track position in metres from the start line. */
  n: number;
}

/** A pose at N (m), shifted `shiftLeft` metres to the left of the heading, with y = road height + dy. */
function placeAt(path: TrackPath, n: number, shiftLeft: number, dy: number): Placement {
  const t = tOfN(path, n);
  const p = path.pointAt(t);
  const f = path.tangentAt(t);
  const len = Math.hypot(f.x, f.y, f.z) || 1;
  const fx = f.x / len;
  const fz = f.z / len;
  const h = Math.hypot(fx, fz) || 1;
  const lx = fz / h;
  const lz = -fx / h;
  return {
    x: p.x + lx * shiftLeft,
    y: p.y + dy,
    z: p.z + lz * shiftLeft,
    fx,
    fy: f.y / len,
    fz,
    n,
  };
}

export interface StructurePlan {
  decks: Placement[];
  returnDecks: Placement[];
  piers: Placement[];
  underOpen: Placement[];
  underCovered: Placement[];
}

/** Everything XaLoStructures instantiates, as plain numbers (no three.js scene needed). */
export function planXaLoStructures(track: TrackDef, path: TrackPath): StructurePlan {
  const bridge = raw<BridgeJson>(track, 'bridge');
  const river = raw<RiverJson>(track, 'river');
  const u = raw<UnderpassJson>(track, 'underpass');
  const seg = bridge.segmentLengthM;
  const deckDy = RIBBON_LIFT_M - DECK_BELOW_ROAD_M;

  // Outbound deck: segment centres tile fromN..toN (the last one may overhang by < 1 segment).
  const decks: Placement[] = [];
  const count = Math.ceil((bridge.toN - bridge.fromN) / seg);
  for (let k = 0; k < count; k++) {
    decks.push(placeAt(path, bridge.fromN + (k + 0.5) * seg, DECK_WEST_SHIFT_M, deckDy));
  }

  // Piers on the deck joints inside the river span.
  const piers: Placement[] = [];
  for (let n = river.fromN; n <= river.toN + 1e-6; n += seg) {
    piers.push(placeAt(path, n, DECK_WEST_SHIFT_M, deckDy));
  }

  // Return crossing: only deck what the outbound deck does not already carry (road raised, centre outside every deck).
  const covered = (p: Placement): boolean =>
    decks.some((d) => {
      const dx = p.x - d.x;
      const dz = p.z - d.z;
      const h = Math.hypot(d.fx, d.fz) || 1;
      const along = (dx * d.fx + dz * d.fz) / h;
      const across = (dx * d.fz - dz * d.fx) / h;
      return Math.abs(along) <= seg / 2 + 4 && Math.abs(across) <= DECK_WIDTH_M / 2 + 6;
    });
  const returnDecks: Placement[] = [];
  const from = RETURN_FROM_T * path.lengthM;
  for (let n = from; n < path.lengthM; n += seg) {
    const p = placeAt(path, n + seg / 2, 0, deckDy);
    if (path.yAt(tOfN(path, p.n)) < RETURN_MIN_ROAD_Y) continue;
    if (covered(p)) continue;
    returnDecks.push(p);
  }

  const useg = u.segmentLengthM || UNDERPASS_SEGMENT_FALLBACK_M;
  const underOpen: Placement[] = [];
  const underCovered: Placement[] = [];
  const ucount = Math.ceil((u.toN - u.fromN) / useg);
  for (let k = 0; k < ucount; k++) {
    const n = u.fromN + (k + 0.5) * useg;
    const p = placeAt(path, n, 0, 0);
    (n >= u.coveredFromN && n <= u.coveredToN ? underCovered : underOpen).push(p);
  }
  return { decks, returnDecks, piers, underOpen, underCovered };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const WATER_VERT = /* glsl */ `
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

// Slow summed-sine ripples with a soft sky-coloured glint; the fog colour does the dusk blending.
const WATER_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec3 vWorld;
  #include <fog_pars_fragment>
  void main() {
    vec2 p = vWorld.xz;
    float w = sin(p.y * 0.11 + uTime * 0.6) + sin(p.x * 0.08 - uTime * 0.45) + sin((p.x + p.y) * 0.19 + uTime * 0.9);
    vec3 col = uColor * (0.9 + 0.1 * w);
    float glint = pow(max(0.0, sin(p.y * 0.05 + w * 0.6 + 1.0)), 18.0);
    col += vec3(0.55, 0.35, 0.3) * glint * 0.35;
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

/** An InstancedMesh per sub-mesh of one GLB, with untextured materials merged; matrices are written once. */
class StaticInstances {
  readonly meshes: THREE.InstancedMesh[] = [];

  constructor(
    private readonly parent: THREE.Object3D,
    assets: Assets,
    path: string,
    placements: readonly Placement[],
  ) {
    if (placements.length === 0) return;
    const root = assets.cloneModel(path);
    mergePropMaterials(root);
    root.updateMatrixWorld(true);
    const base = new THREE.Matrix4();
    const m = new THREE.Matrix4();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const inst = new THREE.InstancedMesh(o.geometry, o.material, placements.length);
      inst.name = o.name;
      // Small sets spanning a few hundred metres: always drawn (fog hides the far end), no per-chunk culling.
      inst.frustumCulled = false;
      inst.castShadow = false;
      inst.receiveShadow = true;
      placements.forEach((pl, i) => {
        fwd.set(pl.fx, pl.fy, pl.fz).normalize();
        right.crossVectors(Y, fwd).normalize();
        up.crossVectors(fwd, right);
        base.makeBasis(right, up, fwd).setPosition(pl.x, pl.y, pl.z);
        inst.setMatrixAt(i, m.multiplyMatrices(base, o.matrixWorld));
      });
      inst.instanceMatrix.needsUpdate = true;
      parent.add(inst);
      this.meshes.push(inst);
    });
  }

  dispose(): void {
    for (const m of this.meshes) {
      this.parent.remove(m);
      m.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!mat.userData.shared) mat.dispose();
      }
    }
    this.meshes.length = 0;
  }
}

/**
 * Map 3's big structures: the river water, bridge decks + piers, and the Thu Duc underpass walls.
 * Visual only: the road ribbon is the drivable surface and nothing here carries a collider.
 */
export class XaLoStructures {
  readonly group = new THREE.Group();
  readonly plan: StructurePlan;
  private readonly sets: StaticInstances[] = [];
  private readonly water: THREE.Mesh;

  constructor(
    private readonly scene: THREE.Scene,
    _R: Rapier,
    _world: RAPIER.World,
    assets: Assets,
    track: TrackDef,
    path: TrackPath,
  ) {
    this.group.name = 'xalo-structures';
    this.plan = planXaLoStructures(track, path);
    const plan = this.plan;

    this.sets.push(
      new StaticInstances(this.group, assets, SEGMENT, [...plan.decks, ...plan.returnDecks]),
      new StaticInstances(this.group, assets, PIER, plan.piers),
      new StaticInstances(this.group, assets, UNDER_OPEN, plan.underOpen),
      new StaticInstances(this.group, assets, UNDER_COVERED, plan.underCovered),
    );
    // Segments are 20–40 m long: draw only those the haze hasn't swallowed (the bridge alone is 420 m).
    const drawM = drawDistance(track.daylight, 40) * 0.72;
    for (const set of this.sets) windowInstances(set.meshes, drawM);

    // River water: one quad covering the land hole (slightly longer so no sliver of land shows at the edges).
    const river = raw<RiverJson>(track, 'river');
    const quad = riverPolygon(track, path, RIVER_OVERLAP_M);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        quad.flatMap(([x, z]) => [x, WATER_Y, z]),
        3,
      ),
    );
    // Wound counter-clockwise seen from above (+Y) whichever way the road heads.
    const [a, b, c] = quad;
    const ccw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0;
    geo.setIndex(ccw ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
    const uniforms = { uColor: { value: new THREE.Color(river.color) }, uTime: { value: 0 } };
    this.water = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, uniforms]),
        vertexShader: WATER_VERT,
        fragmentShader: WATER_FRAG,
        fog: true,
      }),
    );
    this.water.name = 'xalo-river';
    this.water.frustumCulled = false;
    const mat = this.water.material as THREE.ShaderMaterial;
    this.water.onBeforeRender = (): void => {
      mat.uniforms.uTime.value = performance.now() / 1000;
    };
    this.group.add(this.water);
    this.scene.add(this.group);
  }

  /** Nothing moves per frame: the water animates itself in onBeforeRender. Kept for the system interface. */
  update(dt: number): void {
    void dt; // static: nothing to advance
  }

  dispose(): void {
    for (const s of this.sets) s.dispose();
    this.sets.length = 0;
    this.water.geometry.dispose();
    (this.water.material as THREE.Material).dispose();
    this.group.remove(this.water);
    this.scene.remove(this.group);
  }
}
