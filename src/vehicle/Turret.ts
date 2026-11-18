const TAU = Math.PI * 2;

/** Wraps an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  const w = ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return w === -Math.PI ? Math.PI : w;
}

/**
 * Yaw (radians, about +Y) of `aimDir` relative to `forward`, clamped to ±limitDeg.
 * Positive = towards the car's left (+X when facing +Z). Both vectors only need x/z; they need not be unit length.
 */
export function turretYaw(
  forward: { x: number; z: number },
  aimDir: { x: number; z: number },
  limitDeg: number,
): number {
  if ((aimDir.x === 0 && aimDir.z === 0) || (forward.x === 0 && forward.z === 0)) return 0;
  const d = wrapAngle(Math.atan2(aimDir.x, aimDir.z) - Math.atan2(forward.x, forward.z));
  const lim = (Math.min(limitDeg, 180) * Math.PI) / 180;
  return Math.max(-lim, Math.min(lim, d));
}

/** Moves `cur` toward `target` along the shortest arc by at most `maxStep` radians. */
export function approachAngle(cur: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - cur);
  if (Math.abs(d) <= maxStep) return wrapAngle(cur + d);
  return wrapAngle(cur + Math.sign(d) * maxStep);
}
