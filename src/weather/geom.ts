/** Rotate the vector (x, y, z) by the unit quaternion q into `out` (no allocation). */
export function rotateByQuat(
  q: { x: number; y: number; z: number; w: number },
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number },
): void {
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out.x = x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = z + q.w * tz + (q.x * ty - q.y * tx);
}

/** The spray sources behind a car: its rear wheels' mean position in body space, widened by half the track. */
export function rearAnchor(wheels: readonly { x: number; y: number; z: number; rear: boolean; radius: number }[]): {
  halfTrack: number;
  y: number;
  z: number;
} {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const w of wheels) {
    if (!w.rear) continue;
    n++;
    sx = Math.max(sx, Math.abs(w.x));
    sy += w.y - w.radius;
    sz += w.z;
  }
  if (n === 0) return { halfTrack: 0.8, y: 0, z: -1.5 };
  return { halfTrack: sx, y: sy / n, z: sz / n };
}
