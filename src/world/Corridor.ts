/**
 * Pure geometry for a boulevard where the lap runs out along one carriageway and back along the other.
 * The racing line is one closed loop, so "opposite" samples (the same road, other direction) are found by
 * proximity + anti-parallel heading; the median, overpasses and building rows are laid out from that.
 */
export interface CorridorPath {
  readonly count: number;
  readonly spacingM: number;
  readonly lengthM: number;
  readonly px: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
}

export interface CorridorOptions {
  /** Samples closer than this along the loop are never "opposite" (they are the same stretch of road). */
  minArcM: number;
  /** Max distance between the two carriageway centre lines. */
  maxDistM: number;
}

export const DEFAULT_CORRIDOR: CorridorOptions = { minArcM: 150, maxDistM: 24 };

/** For each sample, the index of the nearest sample driving the opposite way on the other carriageway, or -1. */
export function findOpposites(path: CorridorPath, opts: CorridorOptions = DEFAULT_CORRIDOR): Int32Array {
  const n = path.count;
  const out = new Int32Array(n).fill(-1);
  const minArcSamples = Math.ceil(opts.minArcM / path.spacingM);
  const max2 = opts.maxDistM * opts.maxDistM;
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestD = max2;
    for (let j = 0; j < n; j++) {
      const d = Math.abs(i - j);
      if (Math.min(d, n - d) < minArcSamples) continue;
      const dx = path.px[j] - path.px[i];
      const dz = path.pz[j] - path.pz[i];
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD) continue;
      if (path.tx[i] * path.tx[j] + path.tz[i] * path.tz[j] > -0.3) continue; // must head the other way
      bestD = d2;
      best = j;
    }
    out[i] = best;
  }
  return out;
}

export interface MedianSite {
  x: number;
  z: number;
  /** Rotation about +Y (0 faces +Z) of the road direction at this site. */
  yaw: number;
  /** Index of the sample on the first leg and of its opposite. */
  i: number;
  j: number;
  /** Distance between the two carriageway centre lines here. */
  gapM: number;
}

/** Sites for median tiles, one every `tileM` metres along the first leg of each paired stretch. */
export function medianSites(path: CorridorPath, opp: Int32Array, tileM: number): MedianSite[] {
  const sites: MedianSite[] = [];
  let acc = tileM; // place one immediately at the start of a stretch
  for (let i = 0; i < path.count; i++) {
    const j = opp[i];
    if (j < 0 || j < i) {
      acc = tileM;
      continue;
    }
    acc += path.spacingM;
    if (acc < tileM) continue;
    acc = 0;
    const x = (path.px[i] + path.px[j]) / 2;
    const z = (path.pz[i] + path.pz[j]) / 2;
    sites.push({
      x,
      z,
      yaw: Math.atan2(path.tx[i], path.tz[i]),
      i,
      j,
      gapM: Math.hypot(path.px[j] - path.px[i], path.pz[j] - path.pz[i]),
    });
  }
  return sites;
}

export interface CentrePoint {
  x: number;
  z: number;
  /** Unit direction of travel on the first leg. */
  tx: number;
  tz: number;
  /** Metres from the start of the corridor along the median. */
  n: number;
}

/** The median centre line of the longest paired stretch, sampled every `stepM`, with n = metres along it. */
export function corridorCentreline(path: CorridorPath, opp: Int32Array, stepM: number): CentrePoint[] {
  const pts: CentrePoint[] = [];
  let n = 0;
  let prev: { x: number; z: number } | null = null;
  let acc = stepM;
  for (let i = 0; i < path.count; i++) {
    const j = opp[i];
    if (j < 0 || j < i) {
      if (pts.length > 0) break; // first stretch only
      continue;
    }
    const x = (path.px[i] + path.px[j]) / 2;
    const z = (path.pz[i] + path.pz[j]) / 2;
    if (prev) {
      const d = Math.hypot(x - prev.x, z - prev.z);
      n += d;
      acc += d;
    }
    prev = { x, z };
    if (acc >= stepM) {
      acc = 0;
      pts.push({ x, z, tx: path.tx[i], tz: path.tz[i], n });
    }
  }
  return pts;
}

/** Left-pointing unit vector for a heading (+X is left for something facing +Z). */
export function leftOf(tx: number, tz: number): { x: number; z: number } {
  return { x: tz, z: -tx };
}

/** Index of the sample nearest to (x, z). */
export function nearestSample(path: CorridorPath, x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.count; i++) {
    const dx = path.px[i] - x;
    const dz = path.pz[i] - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Right-pointing unit vector for a heading (the opposite of `leftOf`; drive-on-the-right side). */
export function rightOf(tx: number, tz: number): { x: number; z: number } {
  return { x: -tz, z: tx };
}

/** Shortest distance from (x, z) to a polyline of [x, z] points (a single point counts as a degenerate segment). */
export function distToPolyline(pts: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[Math.min(i + 1, pts.length - 1)];
    const abx = b[0] - a[0];
    const abz = b[1] - a[1];
    const len2 = abx * abx + abz * abz;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * abx + (z - a[1]) * abz) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (a[0] + abx * u), z - (a[1] + abz * u)));
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Map 3 metro viaduct helpers (pure maths: span tiling, train timing, clearances against the racing path).
// ---------------------------------------------------------------------------------------------

/** One placed prop on a polyline: centre (x, y, z) and the yaw that points model +Z along the polyline. */
export interface PolyPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Total length of a polyline measured in the XZ plane. */
export function polylineLengthM(poly: readonly (readonly number[])[]): number {
  let len = 0;
  for (let i = 1; i < poly.length; i++) len += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][2] - poly[i - 1][2]);
  return len;
}

/** Point `s` metres along a polyline (clamped to its ends), written to `out`. Yaw = atan2(dx, dz) of the segment. */
export function polylinePoseAt(poly: readonly (readonly number[])[], s: number, out: PolyPose): PolyPose {
  let rest = Math.max(0, s);
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const seg = Math.hypot(dx, dz);
    if (rest <= seg || i === poly.length - 1) {
      const k = seg > 0 ? Math.min(rest, seg) / seg : 0;
      out.x = a[0] + dx * k;
      out.y = a[1] + (b[1] - a[1]) * k;
      out.z = a[2] + dz * k;
      out.yaw = Math.atan2(dx, dz);
      return out;
    }
    rest -= seg;
  }
  return out;
}

/** Centres of the whole spans of `spanM` that tile a polyline from its first point (a short remainder is left bare). */
export function spanPlacements(poly: readonly (readonly number[])[], spanM: number): PolyPose[] {
  const n = Math.floor(polylineLengthM(poly) / spanM + 1e-9);
  const out: PolyPose[] = [];
  for (let i = 0; i < n; i++) out.push(polylinePoseAt(poly, (i + 0.5) * spanM, { x: 0, y: 0, z: 0, yaw: 0 }));
  return out;
}

/** How many trains of one direction are needed so the headway holds while one lap of the line takes `loopM`. */
export function trainsPerDirection(loopM: number, speedMps: number, headwayS: number): number {
  return Math.max(1, Math.ceil(loopM / speedMps / headwayS));
}

/**
 * Distance (m) the head of train `k` has covered on its looped line at `timeS`: trains leave `headwayS` apart and
 * wrap every `loopM`. Values in [0, loopM).
 */
export function trainHeadM(timeS: number, speedMps: number, loopM: number, headwayS: number, k: number): number {
  const d = (timeS - k * headwayS) * speedMps;
  return ((d % loopM) + loopM) % loopM;
}

/** Shortest distance from (x, z) to the closed racing path (segments between its samples). */
export function distanceToPathM(path: CorridorPath, x: number, z: number): number {
  let best = Infinity;
  const n = path.count;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ax = path.px[i];
    const az = path.pz[i];
    const sx = path.px[j] - ax;
    const sz = path.pz[j] - az;
    const l2 = sx * sx + sz * sz;
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / l2)) : 0;
    const d = Math.hypot(x - (ax + sx * k), z - (az + sz * k));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Smallest distance to the racing path of a rectangle (model-space x/z ranges) placed at (px, pz) with `yaw`.
 * Sampled on a 5 × 3 grid (corners, edge midpoints, centre), which is dense enough for 2–8 m footprints.
 */
export function rectDistanceToPathM(
  path: CorridorPath,
  px: number,
  pz: number,
  yaw: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
): number {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const lx = x0 + ((x1 - x0) * i) / 4;
    for (let j = 0; j < 3; j++) {
      const lz = z0 + ((z1 - z0) * j) / 2;
      // Model +X maps to (cos yaw, -sin yaw) and +Z to (sin yaw, cos yaw): the same rotation THREE uses about +Y.
      const d = distanceToPathM(path, px + lx * c + lz * s, pz - lx * s + lz * c);
      if (d < best) best = d;
    }
  }
  return best;
}
