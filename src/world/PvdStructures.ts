import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { RACE, roadWidthAt, type TrackDef } from '../core/Data';
import { mergePropMaterials } from '../vehicle/MergeMaterials';
import type { TrackPath } from './TrackPath';
import { drawDistance, windowInstances } from './Windowed';

type Rapier = typeof RAPIER;

const P = 'models/props_pvd/';
const SEGMENT = `${P}bridge_branch_segment.glb`;
const PIER = `${P}bridge_branch_pier.glb`;
const ARCH = `${P}arch_rail_bridge.glb`;
const RAMP = `${P}ramp_span.glb`;
const OVERPASS = `${P}cross_overpass.glb`;
const FLYOVER_PIER = 'models/props_conghoa/flyover_pier.glb';

/** Every model this module loads (for the track's asset list). */
export const PVD_STRUCTURE_MODELS: string[] = [SEGMENT, PIER, ARCH, RAMP, OVERPASS, FLYOVER_PIER];

// Model facts read from the GLBs (metres, model space; +Z forward, deck top at y = 0).
/** ramp_span: bottom of the deck slab below its top. */
const RAMP_BELOW_DECK_M = 1.9;
/** flyover_pier (props_conghoa): height of the column. */
const FLYOVER_PIER_HEIGHT_M = 7.8;

/**
 * The road ribbon sits RACE.track.roadY above the spline. Decks go this far below the ribbon: a 40 m rigid segment on a
 * vertical curve rises above the curve at its ends (sagitta ≈ 0.1 m on the Binh Loi approaches), and must never poke
 * through the road surface.
 */
const DECK_BELOW_ROAD_M = 0.25;
/** A pier under a deck this low would only be a stump buried in the land. */
const PIER_MIN_ROAD_Y = 3;
/**
 * On the tight U-turn (radius ~15 m) a 30 m rigid span is a long chord whose parapets cut across the road: each
 * structural span is laid as short pieces, like the Track's own 3 m barriers, so they follow the curve.
 */
const RAMP_MAX_PIECE_M = 3;
/** A flyover column shorter than this is not worth drawing. */
const FLYOVER_PIER_MIN_M = 0.5;
const RIVER_WATER_Y = -1.5;
const CREEK_WATER_Y = -1;
/** Visible bank wall below the land plane, under the water line. */
const BANK_BELOW_WATER_M = 0.4;
/** The land plane is 6 km square (Environment): river and creek bands stop this far inside its edge. */
const LAND_HALF_M = 3000;
const LAND_EDGE_INSET_M = 10;
const WATER_OVERLAP_M = 2;
const TRENCH_Y = -0.3;
const TRENCH_PAD_M = 12;
/** The cut is this much wider than the road on each side; a shelf at road level fills the strip. */
const TRENCH_MARGIN_M = 3;
/** How far either side of the flood zone (as a fraction of the lap) the trench search looks. */
const TRENCH_SEARCH_T = 0.03;
const BANK_COLOR = '#4B525A';

interface BranchJson {
  side: string;
  centreX: number;
}
interface BridgeJson {
  binhLoi: { fromN: number; toN: number; segmentLengthM: number; branches: BranchJson[] };
  railArch: { position: [number, number, number]; headingDeg: number };
  goDua: { fromN: number; toN: number };
}
interface BandJson {
  fromN: number;
  toN: number;
  color: string;
}
interface OverpassJson {
  position: [number, number, number];
}
interface FlyoverJson {
  fromT: number;
  toT: number;
  spanM: number;
}
interface CrossPart {
  part: string;
  widthM: number;
}

const raw = <T>(track: TrackDef, key: string): T => {
  const v = track.raw[key];
  if (!v || typeof v !== 'object') throw new Error(`${track.id}: missing "${key}" block`);
  return v as T;
};

/** The creek is the middle third of the Go Dua crossing (n 1540-1580 inside 1500-1620). */
const CREEK_FRACTION = 1 / 3;
const creekRange = (b: BridgeJson): [number, number] => {
  const len = b.goDua.toN - b.goDua.fromN;
  return [b.goDua.fromN + len * CREEK_FRACTION, b.goDua.fromN + len * (1 - CREEK_FRACTION)];
};

/** Arc distance N (m from the start line, may be negative) → wrapped t. */
const tOfN = (path: TrackPath, n: number): number => (((n / path.lengthM) % 1) + 1) % 1;

type Poly = [number, number][];

/** Which side of the heading a lateral offset is measured to: + is the driver's left. */
const left = (fx: number, fz: number): { x: number; z: number } => {
  const h = Math.hypot(fx, fz) || 1;
  return { x: fz / h, z: -fx / h };
};

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
  /** Along-track position in metres from the start line (0 for pieces not on the track). */
  n: number;
  /** Optional stretch of the model along its forward / up axes (default 1). */
  sz?: number;
  sy?: number;
}

/** A pose at N (m), shifted `shiftLeft` metres to the left of the heading, with y = road height + dy. */
function placeAt(path: TrackPath, n: number, shiftLeft: number, dy: number): Placement {
  const t = tOfN(path, n);
  const p = path.pointAt(t);
  const f = path.tangentAt(t);
  const len = Math.hypot(f.x, f.y, f.z) || 1;
  const fx = f.x / len;
  const fz = f.z / len;
  const l = left(fx, fz);
  return { x: p.x + l.x * shiftLeft, y: p.y + dy, z: p.z + l.z * shiftLeft, fx, fy: f.y / len, fz, n };
}

/**
 * Arc position N (m from the start line) where the racing line passes world z. The data's N is "metres north"
 * (z = -N), so every outbound feature is located by z, not by arc length. The outbound leg heads -z, the return +z.
 */
function nAtZ(path: TrackPath, z: number, outbound: boolean): number {
  const first = outbound ? 0 : Math.floor(path.count / 2);
  const last = outbound ? Math.floor(path.count / 2) : path.count - 1;
  for (let i = first; i < last; i++) {
    const a = path.pz[i];
    const b = path.pz[i + 1];
    if (outbound ? a >= z && z > b : a <= z && z < b) return (i + (z - a) / (b - a)) * path.spacingM;
  }
  throw new Error(`${outbound ? 'outbound' : 'return'} leg never crosses z = ${z}`);
}

export const outboundNAtZ = (path: TrackPath, z: number): number => nAtZ(path, z, true);
export const returnNAtZ = (path: TrackPath, z: number): number => nAtZ(path, z, false);

/** Offset of the outbound racing line from the boulevard axis: half the median plus half the car lanes. */
function racingOffsetFromAxis(track: TrackDef): number {
  const cross = (track.raw.roadLayout as { crossSectionFromCentre?: CrossPart[] } | undefined)?.crossSectionFromCentre;
  const median = cross?.find((x) => /median/i.test(x.part));
  const cars = cross?.find((x) => /car lanes/i.test(x.part));
  if (!median || !cars) throw new Error(`${track.id}: road cross-section lacks a median or car lanes`);
  return median.widthM / 2 + cars.widthM / 2;
}

export interface BranchCrossing {
  /** Deck segments (centre poses). */
  decks: Placement[];
  /** Pier poses on the joints that stand high enough to show a pier. */
  piers: Placement[];
}

/**
 * One two-branch crossing (Binh Loi or Go Dua). The outbound branch is centred `centreX` to the right of the boulevard
 * axis, the inbound one to its left; both are found on the racing line (outbound by N, inbound where the return leg
 * passes the same z) and shifted sideways to their branch centre.
 */
export function planCrossing(
  track: TrackDef,
  path: TrackPath,
  fromN: number,
  toN: number,
  segmentM: number,
  branches: BranchJson[],
): BranchCrossing {
  const deckDy = RACE.track.roadY - DECK_BELOW_ROAD_M;
  const offset = racingOffsetFromAxis(track);
  const out = branches.find((b) => b.side === 'outbound');
  const inn = branches.find((b) => b.side === 'inbound');
  if (!out || !inn) throw new Error(`${track.id}: bridge needs an outbound and an inbound branch`);
  // Outbound: the same z range as the data's N range (z = -N), tiled in whole segments.
  const zFrom = -fromN;
  const zTo = -toN;
  const oA = outboundNAtZ(path, zFrom);
  const oB = outboundNAtZ(path, zTo);
  const count = Math.max(1, Math.round((oB - oA) / segmentM));
  const pitch = (oB - oA) / count;
  const decks: Placement[] = [];
  const joints: { n: number; shift: number }[] = [];
  // The branch centre is `centreX - offset` to the right of the racing line.
  const outShift = -(out.centreX - offset);
  for (let k = 0; k < count; k++) decks.push(placeAt(path, oA + (k + 0.5) * pitch, outShift, deckDy));
  for (let k = 0; k <= count; k++) joints.push({ n: oA + k * pitch, shift: outShift });

  // Inbound: the same z range on the return leg. Shift so its centre is `|centreX|` left of the axis.
  const mid = placeAt(path, (oA + oB) / 2, 0, 0);
  const lo = left(mid.fx, mid.fz);
  const axis = { x: mid.x + lo.x * offset, z: mid.z + lo.z * offset };
  const centre = { x: axis.x - lo.x * inn.centreX, z: axis.z - lo.z * inn.centreX };
  const nA = returnNAtZ(path, zTo); // the return heads +z: the far end of the outbound range comes first
  const nB = returnNAtZ(path, zFrom);
  const inMid = placeAt(path, (nA + nB) / 2, 0, 0);
  const li = left(inMid.fx, inMid.fz);
  const inShift = (centre.x - inMid.x) * li.x + (centre.z - inMid.z) * li.z;
  const inCount = Math.max(1, Math.round((nB - nA) / segmentM));
  const inSeg = (nB - nA) / inCount;
  for (let k = 0; k < inCount; k++) decks.push(placeAt(path, nA + (k + 0.5) * inSeg, inShift, deckDy));
  for (let k = 0; k <= inCount; k++) joints.push({ n: nA + k * inSeg, shift: inShift });

  const piers: Placement[] = [];
  for (const j of joints) {
    if (path.yAt(tOfN(path, j.n)) < PIER_MIN_ROAD_Y) continue;
    piers.push(placeAt(path, j.n, j.shift, deckDy));
  }
  return { decks, piers };
}

export interface StructurePlan {
  binhLoi: BranchCrossing;
  goDua: BranchCrossing;
  /** Flyover ramp spans (stretched along their length to tile the stretch exactly). */
  ramps: Placement[];
  /** Flyover columns under the span joints (stretched in height to meet the deck). */
  flyoverPiers: Placement[];
  overpass: Placement;
  railArch: Placement;
}

const yawPlacement = (x: number, y: number, z: number, yawRad: number): Placement => ({
  x,
  y,
  z,
  fx: Math.sin(yawRad),
  fy: 0,
  fz: Math.cos(yawRad),
  n: 0,
});

/** Everything PvdStructures instantiates, as plain numbers (no three.js scene needed). */
export function planPvdStructures(track: TrackDef, path: TrackPath): StructurePlan {
  const bridge = raw<BridgeJson>(track, 'bridge');
  const fly = raw<FlyoverJson>(track, 'uTurnFlyover');
  const deckDy = RACE.track.roadY - DECK_BELOW_ROAD_M;
  const seg = bridge.binhLoi.segmentLengthM;

  const binhLoi = planCrossing(track, path, bridge.binhLoi.fromN, bridge.binhLoi.toN, seg, bridge.binhLoi.branches);
  // The Go Dua creek bridge reuses the same branch model, one 40 m segment after another.
  const goDua = planCrossing(track, path, bridge.goDua.fromN, bridge.goDua.toN, seg, bridge.binhLoi.branches);

  const flyFromN = fly.fromT * path.lengthM;
  const flyLenM = (fly.toT - fly.fromT) * path.lengthM;
  const spans = Math.max(1, Math.round(flyLenM / fly.spanM));
  const spanLenM = flyLenM / spans;
  const perSpan = Math.max(1, Math.ceil(spanLenM / RAMP_MAX_PIECE_M));
  const pieces = spans * perSpan;
  const pitch = flyLenM / pieces;
  const ramps: Placement[] = [];
  for (let k = 0; k < pieces; k++) {
    ramps.push({ ...placeAt(path, flyFromN + (k + 0.5) * pitch, 0, deckDy), sz: pitch / fly.spanM });
  }
  // Columns stand under the structural span joints only.
  const flyoverPiers: Placement[] = [];
  for (let k = 0; k <= spans; k++) {
    const base = placeAt(path, flyFromN + k * spanLenM, 0, 0);
    const deckBottom = base.y + deckDy - RAMP_BELOW_DECK_M;
    if (deckBottom < FLYOVER_PIER_MIN_M) continue;
    // Stands on the land (y = 0) and reaches up to the underside of the deck.
    flyoverPiers.push({ ...base, y: 0, sy: deckBottom / FLYOVER_PIER_HEIGHT_M });
  }

  const o = raw<OverpassJson>(track, 'crossOverpass').position;
  const a = bridge.railArch;
  return {
    binhLoi,
    goDua,
    ramps,
    flyoverPiers,
    overpass: yawPlacement(o[0], o[1], o[2], 0),
    railArch: yawPlacement(a.position[0], a.position[1], a.position[2], THREE.MathUtils.degToRad(a.headingDeg)),
  };
}

// ---------------------------------------------------------------------------------------------
// Pure geometry: terrain holes and the trench
// ---------------------------------------------------------------------------------------------

/**
 * World (x, z) quad of a water band across the whole land: N fromN..toN is metres north, so z = -N, running east-west
 * to `inset` metres short of the land plane's edge (so the cut stays inside the plane). `margin` lengthens it in z.
 */
function bandPolygon(fromN: number, toN: number, margin = 0, inset = LAND_EDGE_INSET_M): Poly {
  const lim = LAND_HALF_M - inset;
  const z0 = -fromN + margin;
  const z1 = -toN - margin;
  return [
    [-lim, z0],
    [lim, z0],
    [lim, z1],
    [-lim, z1],
  ];
}

export interface Trench {
  /** Spline sample indices along the sunken run (padded at both ends). */
  idx: number[];
  /** Half width of the cut at each sample (road half width + margin). */
  half: number[];
}

/**
 * The flooded dip as a run of path samples: the longest stretch around the flood zone where the road is below −0.3 m,
 * followed to where it comes back up and padded by 12 m so the land never ledges across the ramp.
 */
export function pvdTrench(track: TrackDef, path: TrackPath): Trench | null {
  const flood = track.weather?.flood;
  if (!flood) return null;
  const n = path.count;
  const first = Math.floor((flood.fromT - TRENCH_SEARCH_T) * n);
  const last = Math.ceil((flood.toT + TRENCH_SEARCH_T) * n);
  let best: number[] = [];
  let run: number[] = [];
  for (let i = first; i <= last; i++) {
    const idx = ((i % n) + n) % n;
    if (path.py[idx] < TRENCH_Y) {
      run.push(idx);
    } else {
      if (run.length > best.length) best = run;
      run = [];
    }
  }
  if (run.length > best.length) best = run;
  if (best.length < 2) return null;
  let a = best[0];
  let b = best[best.length - 1];
  const padM = Math.ceil(TRENCH_PAD_M / path.spacingM);
  for (let k = 0; k < padM; k++) {
    a = (a - 1 + n) % n;
    b = (b + 1) % n;
    best.unshift(a);
    best.push(b);
  }
  return { idx: best, half: best.map((i) => roadWidthAt(track, i / n) / 2 + TRENCH_MARGIN_M) };
}

/** The trench's two edges, left and right of the heading, as world (x, z) points. */
function trenchEdges(path: TrackPath, tr: Trench): { l: Poly; r: Poly } {
  const l: Poly = [];
  const r: Poly = [];
  tr.idx.forEach((i, k) => {
    const lx = path.tz[i];
    const lz = -path.tx[i];
    l.push([path.px[i] + lx * tr.half[k], path.pz[i] + lz * tr.half[k]]);
    r.push([path.px[i] - lx * tr.half[k], path.pz[i] - lz * tr.half[k]]);
  });
  return { l, r };
}

/**
 * Polygons cut out of the visible land plane, in world (x, z): the river band under Binh Loi bridge, the Go Dua creek
 * band and the flooded dip's trench (the whole stretch below −0.3 m plus a pad, widened to the road half width + 6 m).
 */
export function pvdTerrainHoles(track: TrackDef, path: TrackPath): [number, number][][] {
  const river = raw<BandJson>(track, 'river');
  const bridge = raw<BridgeJson>(track, 'bridge');
  const holes: [number, number][][] = [bandPolygon(river.fromN, river.toN)];
  holes.push(bandPolygon(...creekRange(bridge)));
  const tr = pvdTrench(track, path);
  if (tr) {
    const { l, r } = trenchEdges(path, tr);
    holes.push([...l, ...r.reverse()]);
  }
  return holes;
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

// Overcast river: slow swell plus rain rings (one ring per grid cell, expanding and fading) in place of a sky glint.
const WATER_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec3 vWorld;
  #include <fog_pars_fragment>
  float ring(vec2 p, float t) {
    vec2 g = floor(p);
    vec2 f = fract(p) - 0.5;
    float h = fract(sin(dot(g, vec2(127.1, 311.7))) * 43758.5453);
    float ph = fract(t * 0.8 + h);
    vec2 c = (vec2(fract(h * 7.3), fract(h * 3.7)) - 0.5) * 0.5;
    float d = length(f - c);
    return smoothstep(0.07, 0.0, abs(d - ph * 0.5)) * (1.0 - ph);
  }
  void main() {
    vec2 p = vWorld.xz;
    float w = sin(p.y * 0.2 + uTime * 0.7) + sin(p.x * 0.15 - uTime * 0.5) + sin((p.x + p.y) * 0.3 + uTime * 1.1);
    vec3 col = uColor * (0.85 + 0.07 * w);
    float rip = ring(p * 0.8, uTime) + ring(p * 1.3 + 17.0, uTime * 1.1);
    col += vec3(0.55, 0.62, 0.66) * rip * 0.3;
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
        // Stretch along the model's own forward / up axes (ramp spans tile exactly, flyover columns meet the deck).
        base
          .makeBasis(right, up.multiplyScalar(pl.sy ?? 1), fwd.multiplyScalar(pl.sz ?? 1))
          .setPosition(pl.x, pl.y, pl.z);
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

/** Flat vertical quad strip helper: pushes two triangles per (top, bottom) pair of consecutive points. */
function strip(out: number[], a: [number, number, number][], b: [number, number, number][]): void {
  for (let k = 0; k + 1 < a.length; k++) {
    const q = [a[k], b[k], b[k + 1], a[k], b[k + 1], a[k + 1]];
    for (const v of q) out.push(v[0], v[1], v[2]);
  }
}

/**
 * Visible edges of the cuts in the land plane, so nothing looks into the void: concrete bank walls from the land
 * (y = 0) down past the water line along the river and creek, and the flooded dip's side walls plus a shelf at road
 * level between the road and each wall. One merged mesh.
 */
function bankGeometry(track: TrackDef, path: TrackPath): THREE.BufferGeometry {
  const river = raw<BandJson>(track, 'river');
  const bridge = raw<BridgeJson>(track, 'bridge');
  const v: number[] = [];
  const bands: { quad: Poly; y: number }[] = [
    { quad: bandPolygon(river.fromN, river.toN), y: RIVER_WATER_Y },
    { quad: bandPolygon(...creekRange(bridge)), y: CREEK_WATER_Y },
  ];
  for (const { quad, y } of bands) {
    const bottom = y - BANK_BELOW_WATER_M;
    // The two edges across the road: quad[0]-quad[1] (near) and quad[3]-quad[2] (far).
    for (const [p, q] of [
      [quad[0], quad[1]],
      [quad[3], quad[2]],
    ] as [number[], number[]][]) {
      strip(
        v,
        [
          [p[0], 0, p[1]],
          [q[0], 0, q[1]],
        ],
        [
          [p[0], bottom, p[1]],
          [q[0], bottom, q[1]],
        ],
      );
    }
  }
  const tr = pvdTrench(track, path);
  if (tr) {
    const { l, r } = trenchEdges(path, tr);
    const floorY = tr.idx.map((i) => Math.min(0, path.py[i] + RACE.track.roadY));
    const top = (e: Poly): [number, number, number][] => e.map((p) => [p[0], 0, p[1]]);
    const bot = (e: Poly): [number, number, number][] => e.map((p, k) => [p[0], floorY[k], p[1]]);
    strip(v, top(l), bot(l));
    strip(v, top(r), bot(r));
    // Shelf: from the road edge (half - margin) out to the wall, at road level.
    const inner = (side: number): [number, number, number][] =>
      tr.idx.map((i, k) => {
        const e = (side > 0 ? l : r)[k];
        const c: [number, number] = [path.px[i], path.pz[i]];
        const f = (tr.half[k] - TRENCH_MARGIN_M) / tr.half[k];
        return [c[0] + (e[0] - c[0]) * f, floorY[k], c[1] + (e[1] - c[1]) * f];
      });
    strip(v, inner(1), bot(l));
    strip(v, inner(-1), bot(r));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Water quads for the river and the creek in one mesh (y differs per band). */
function waterGeometry(track: TrackDef): THREE.BufferGeometry {
  const river = raw<BandJson>(track, 'river');
  const bridge = raw<BridgeJson>(track, 'bridge');
  const pos: number[] = [];
  const idx: number[] = [];
  const bands: { quad: Poly; y: number }[] = [
    { quad: bandPolygon(river.fromN, river.toN, WATER_OVERLAP_M, 0), y: RIVER_WATER_Y },
    { quad: bandPolygon(...creekRange(bridge), WATER_OVERLAP_M, 0), y: CREEK_WATER_Y },
  ];
  for (const { quad, y } of bands) {
    const o = pos.length / 3;
    for (const [x, z] of quad) pos.push(x, y, z);
    // Wound counter-clockwise seen from above (+Y) whichever way the road heads.
    const [a, b, c] = quad;
    const ccw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0;
    idx.push(...(ccw ? [o, o + 1, o + 2, o, o + 2, o + 3] : [o, o + 2, o + 1, o, o + 3, o + 2]));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Map 4's big structures: the Binh Loi and Go Dua bridges (two branches each, with piers), the river and creek, the
 * railway arch backdrop, the U-turn flyover, the ring-road overpass, and the bank walls that close the cuts in the land.
 * Visual only: the road ribbon is the drivable surface and nothing here carries a collider (the overpass piers stand
 * against the road edge walls and could only ever be reached through them).
 */
export class PvdStructures {
  readonly group = new THREE.Group();
  readonly plan: StructurePlan;
  private readonly sets: StaticInstances[] = [];
  private readonly water: THREE.Mesh;
  private readonly banks: THREE.Mesh;

  constructor(
    private readonly scene: THREE.Scene,
    _R: Rapier,
    _world: RAPIER.World,
    assets: Assets,
    track: TrackDef,
    path: TrackPath,
  ) {
    this.group.name = 'pvd-structures';
    this.plan = planPvdStructures(track, path);
    const plan = this.plan;

    const repeated = [
      new StaticInstances(this.group, assets, SEGMENT, [...plan.binhLoi.decks, ...plan.goDua.decks]),
      new StaticInstances(this.group, assets, PIER, [...plan.binhLoi.piers, ...plan.goDua.piers]),
      new StaticInstances(this.group, assets, RAMP, plan.ramps),
      new StaticInstances(this.group, assets, FLYOVER_PIER, plan.flyoverPiers),
    ];
    const single = [
      new StaticInstances(this.group, assets, OVERPASS, [plan.overpass]),
      new StaticInstances(this.group, assets, ARCH, [plan.railArch]),
    ];
    this.sets.push(...repeated, ...single);
    // Segments are 30–40 m long: draw only those the haze hasn't swallowed (the bridge alone is 560 m).
    const drawM = drawDistance(track.daylight, 40) * 0.72;
    for (const set of repeated) windowInstances(set.meshes, drawM);
    // The overpass (64 m) and the arch (121 m) are big enough to show through the haze from further off.
    for (const set of single) windowInstances(set.meshes, drawDistance(track.daylight, 80));

    const river = raw<BandJson>(track, 'river');
    const uniforms = { uColor: { value: new THREE.Color(river.color) }, uTime: { value: 0 } };
    this.water = new THREE.Mesh(
      waterGeometry(track),
      new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, uniforms]),
        vertexShader: WATER_VERT,
        fragmentShader: WATER_FRAG,
        fog: true,
      }),
    );
    this.water.name = 'pvd-river';
    this.water.frustumCulled = false;
    const mat = this.water.material as THREE.ShaderMaterial;
    this.water.onBeforeRender = (): void => {
      mat.uniforms.uTime.value = performance.now() / 1000;
    };
    this.group.add(this.water);

    this.banks = new THREE.Mesh(
      bankGeometry(track, path),
      new THREE.MeshStandardMaterial({ color: BANK_COLOR, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }),
    );
    this.banks.name = 'pvd-banks';
    this.banks.frustumCulled = false;
    this.banks.receiveShadow = true;
    this.group.add(this.banks);
    this.scene.add(this.group);
  }

  /** Nothing moves per frame: the water animates itself in onBeforeRender. Kept for the system interface. */
  update(dt: number): void {
    void dt; // static: nothing to advance
  }

  dispose(): void {
    for (const s of this.sets) s.dispose();
    this.sets.length = 0;
    for (const m of [this.water, this.banks]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this.group.remove(m);
    }
    this.scene.remove(this.group);
  }
}
