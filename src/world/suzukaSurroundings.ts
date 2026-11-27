import * as THREE from 'three';

/**
 * Map 7's OpenStreetMap surroundings (© OpenStreetMap contributors, ODbL): draped roads and farm tracks, car parks,
 * flat ponds and the larger buildings (small ones are already house models in the placements). Points are `[x, n]`
 * with `n` = north, so the world z is `-n`. Everything is merged into a handful of meshes (one draw call each).
 */
export interface Osm {
  roads: { type: string; w: number; p: [number, number][] }[];
  buildings: { type?: string; lv?: number | null; h?: number | null; p: [number, number][] }[];
  water: { p: [number, number][] }[];
  parking: { p: [number, number][] }[];
}

export interface SurroundingsEnv {
  /** Natural ground height (m) at world (x, z). */
  heightAt(x: number, z: number): number;
  /** Distance (m) from the circuit centre line, `Infinity` when far. */
  trackDistance(x: number, z: number): number;
  /** The heightmap's rectangle in world x and z; features wholly outside are skipped. */
  bounds: { xMin: number; xMax: number; zMin: number; zMax: number };
}

/** A road or footprint closer than this (m) to the circuit is left out: the circuit's own ribbon is the surface there. */
const TRACK_CLEAR_M = 20;
const ROAD_LIFT_M = 0.14;
const LOT_LIFT_M = 0.1;
/** Footprints under this area (m²) are skipped: they are the placed house models. */
const MIN_BUILDING_M2 = 260;
const DEFAULT_STOREY_M = 3.2;

const inside = (b: SurroundingsEnv['bounds'], x: number, z: number, margin = 0): boolean =>
  x >= b.xMin - margin && x <= b.xMax + margin && z >= b.zMin - margin && z <= b.zMax + margin;

const area2D = (p: readonly [number, number][]): number => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
};

/** A polygon's ring without the repeated closing point. */
const ring = (p: readonly [number, number][]): [number, number][] => {
  const r = p.map((q) => [q[0], -q[1]] as [number, number]); // world (x, z)
  const f = r[0];
  const l = r[r.length - 1];
  if (r.length > 1 && f[0] === l[0] && f[1] === l[1]) r.pop();
  return r;
};

class MeshBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  vertex(x: number, y: number, z: number, c: THREE.Color): number {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    return this.pos.length / 3 - 1;
  }

  /** A triangle (a, b, c) wound so that it faces up. */
  upTriangle(a: number, b: number, c: number): void {
    const p = this.pos;
    const cross =
      (p[b * 3] - p[a * 3]) * (p[c * 3 + 2] - p[a * 3 + 2]) - (p[b * 3 + 2] - p[a * 3 + 2]) * (p[c * 3] - p[a * 3]);
    if (cross > 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }

  /** A flat or draped polygon: its ring is triangulated in plan and each corner gets `y(x, z)`. */
  polygon(points: readonly [number, number][], y: (x: number, z: number) => number, c: THREE.Color): void {
    if (points.length < 3) return;
    const faces = THREE.ShapeUtils.triangulateShape(
      points.map(([x, z]) => new THREE.Vector2(x, z)),
      [],
    );
    const base = points.map(([x, z]) => this.vertex(x, y(x, z), z, c));
    for (const [a, b, d] of faces) this.upTriangle(base[a], base[b], base[d]);
  }

  geometry(): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

/** Asphalt by road class; farm tracks and service roads are narrower and darker. */
const ROAD_COLOR: Record<string, string> = {
  trunk: '#46484C',
  trunk_link: '#46484C',
  primary: '#4A4C50',
  secondary: '#4E5054',
  tertiary: '#55575B',
  tertiary_link: '#55575B',
  residential: '#5C5E62',
  unclassified: '#5C5E62',
  service: '#66686B',
};
const TRACK_COLOR = '#7A6A4C';

export interface Surroundings {
  group: THREE.Group;
  dispose(): void;
}

export function buildSurroundings(osm: Osm, env: SurroundingsEnv): Surroundings {
  const group = new THREE.Group();
  group.name = 'suzuka_surroundings';
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const add = (mb: MeshBuilder, mat: THREE.Material, name: string, shadow = false): void => {
    const g = mb.geometry();
    if (!g) return;
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.receiveShadow = shadow;
    group.add(m);
    geos.push(g);
    mats.push(mat);
  };
  const c = new THREE.Color();

  // ---- roads and farm tracks: draped ribbons -------------------------------------------------------------------
  const roads = new MeshBuilder();
  const tracks = new MeshBuilder();
  for (const r of osm.roads) {
    const pts = r.p.map(([x, n]) => [x, -n] as [number, number]);
    if (!pts.some(([x, z]) => inside(env.bounds, x, z, 60))) continue;
    const mb = r.type === 'track' ? tracks : roads;
    c.set(r.type === 'track' ? TRACK_COLOR : (ROAD_COLOR[r.type] ?? '#5C5E62'));
    const half = Math.max(1.2, r.w / 2);
    let prev: [number, number] | null = null;
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1];
      const [x1, z1] = pts[i];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.5 || !inside(env.bounds, x1, z1, 30)) {
        prev = null;
        continue;
      }
      if (env.trackDistance(x1, z1) < TRACK_CLEAR_M + half || env.trackDistance(x0, z0) < TRACK_CLEAR_M + half) {
        prev = null;
        continue;
      }
      const lx = (z1 - z0) / len;
      const lz = -(x1 - x0) / len;
      // Quad for this segment (corner-shared with the previous one so bends stay closed).
      const a = mb.vertex(
        x0 + lx * half,
        env.heightAt(x0 + lx * half, z0 + lz * half) + ROAD_LIFT_M,
        z0 + lz * half,
        c,
      );
      const b = mb.vertex(
        x0 - lx * half,
        env.heightAt(x0 - lx * half, z0 - lz * half) + ROAD_LIFT_M,
        z0 - lz * half,
        c,
      );
      const d = mb.vertex(
        x1 + lx * half,
        env.heightAt(x1 + lx * half, z1 + lz * half) + ROAD_LIFT_M,
        z1 + lz * half,
        c,
      );
      const e = mb.vertex(
        x1 - lx * half,
        env.heightAt(x1 - lx * half, z1 - lz * half) + ROAD_LIFT_M,
        z1 - lz * half,
        c,
      );
      mb.upTriangle(a, b, d);
      mb.upTriangle(b, e, d);
      prev = [x1, z1];
    }
    void prev;
  }
  const roadMat = (): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  add(roads, roadMat(), 'osm_roads', true);
  add(tracks, roadMat(), 'osm_tracks', true);

  // ---- car parks: draped polygons ------------------------------------------------------------------------------
  const lots = new MeshBuilder();
  c.set('#8E8E8A');
  for (const lot of osm.parking) {
    const r = ring(lot.p);
    if (r.length < 3 || !r.some(([x, z]) => inside(env.bounds, x, z))) continue;
    if (r.some(([x, z]) => env.trackDistance(x, z) < TRACK_CLEAR_M)) continue;
    lots.polygon(r, (x, z) => env.heightAt(x, z) + LOT_LIFT_M, c);
  }
  add(lots, roadMat(), 'osm_parking', true);

  // ---- ponds: flat water at the lowest bank height --------------------------------------------------------------
  const water = new MeshBuilder();
  c.set('#4E6470');
  for (const w of osm.water) {
    const r = ring(w.p);
    if (r.length < 3 || !r.some(([x, z]) => inside(env.bounds, x, z))) continue;
    let level = Infinity;
    for (const [x, z] of r) level = Math.min(level, env.heightAt(x, z));
    water.polygon(r, () => level - 0.05, c);
  }
  add(
    water,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.08,
      metalness: 0.1,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
    'osm_water',
  );

  // ---- larger buildings: extruded footprints --------------------------------------------------------------------
  const walls = new MeshBuilder();
  const roofs = new MeshBuilder();
  const wallC = new THREE.Color('#D6D1C6');
  const roofC = new THREE.Color('#8A949C');
  for (const b of osm.buildings) {
    const r = ring(b.p);
    if (r.length < 3 || !r.some(([x, z]) => inside(env.bounds, x, z))) continue;
    const areaM2 = Math.abs(area2D(r));
    const near = r.some(([x, z]) => env.trackDistance(x, z) < 160);
    if (areaM2 < MIN_BUILDING_M2 && !near) continue;
    if (r.some(([x, z]) => env.trackDistance(x, z) < 8)) continue;
    const height = b.h ?? (b.lv ? b.lv * DEFAULT_STOREY_M : areaM2 > 2500 ? 12 : 8);
    let base = Infinity;
    for (const [x, z] of r) base = Math.min(base, env.heightAt(x, z));
    const top = base + height;
    // Walls: one quad per edge, from below the lowest corner up to the roof.
    wallC.setHSL(0.1, 0.06, 0.74 + ((Math.abs(r[0][0] * 7 + r[0][1] * 13) % 10) / 10) * 0.1);
    for (let i = 0; i < r.length; i++) {
      const [x0, z0] = r[i];
      const [x1, z1] = r[(i + 1) % r.length];
      const lo0 = env.heightAt(x0, z0) - 1;
      const lo1 = env.heightAt(x1, z1) - 1;
      const a = walls.vertex(x0, lo0, z0, wallC);
      const bb = walls.vertex(x1, lo1, z1, wallC);
      const cc = walls.vertex(x1, top, z1, wallC);
      const dd = walls.vertex(x0, top, z0, wallC);
      // Outward-facing whichever way the footprint is wound.
      const flip = area2D(r) > 0;
      if (flip) walls.idx.push(a, bb, cc, a, cc, dd);
      else walls.idx.push(a, cc, bb, a, dd, cc);
    }
    roofs.polygon(r, () => top, roofC);
  }
  const wallMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  add(walls, wallMat, 'osm_walls');
  add(roofs, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 }), 'osm_roofs');

  return {
    group,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      group.removeFromParent();
    },
  };
}
