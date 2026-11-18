import * as THREE from 'three';

/** Circumradius (m) of the circle through three points in the XZ plane; Infinity for a straight run. */
export function circumradiusXZ(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const ab = Math.hypot(bx - ax, bz - az);
  const bc = Math.hypot(cx - bx, cz - bz);
  const ca = Math.hypot(ax - cx, az - cz);
  const cross = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
  return cross < 1e-9 ? Infinity : (ab * bc * ca) / (2 * cross);
}

/**
 * Hairpins drawn with a few control points can have a turn radius of 4 m on an 11 m road: the inner edge folds over
 * itself and no car fits. Resamples the closed spline every `stepM` and relaxes only the samples tighter than
 * `minRadiusM` until they are not. Returns the original points untouched when no bend is that tight.
 */
export function relaxTightBends(points: readonly (readonly number[])[], minRadiusM: number, stepM = 2): number[][] {
  const curve = new THREE.CatmullRomCurve3(
    points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    true,
    'catmullrom',
    0.5,
  );
  const n = Math.max(8, Math.ceil(curve.getLength() / stepM));
  const pts = curve.getSpacedPoints(n).slice(0, n);
  const radiusAt = (i: number): number => {
    const a = pts[(i + n - 1) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    return circumradiusXZ(a.x, a.z, b.x, b.z, c.x, c.z);
  };
  if (pts.every((_, i) => radiusAt(i) >= minRadiusM)) return points.map((p) => [...p]);
  for (let iter = 0; iter < 600; iter++) {
    let moved = false;
    const next = pts.map((p) => p.clone());
    for (let i = 0; i < n; i++) {
      if (radiusAt(i) >= minRadiusM) continue;
      const a = pts[(i + n - 1) % n];
      const c = pts[(i + 1) % n];
      next[i].x = pts[i].x + ((a.x + c.x) / 2 - pts[i].x) * 0.5;
      next[i].z = pts[i].z + ((a.z + c.z) / 2 - pts[i].z) * 0.5;
      moved = true;
    }
    for (let i = 0; i < n; i++) pts[i].copy(next[i]);
    if (!moved) break;
  }
  return pts.map((p) => [p.x, p.y, p.z]);
}
