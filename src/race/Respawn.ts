interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface TrackSampler {
  pointAt(t: number): Vec3;
  tangentAt(t: number): Vec3;
}

export interface RespawnPose {
  x: number;
  y: number;
  z: number;
  /** Rotation about +Y; yaw 0 faces +Z. */
  yaw: number;
}

const wrap01 = (x: number): number => x - Math.floor(x);

/** Pose on the spline at `t`, facing the tangent, shifted `lateralM` towards the car's left. */
export function respawnPose(track: TrackSampler, t: number, lateralM: number): RespawnPose {
  const p = track.pointAt(t);
  const tan = track.tangentAt(t);
  const len = Math.hypot(tan.x, tan.z) || 1;
  // left = up × tangent (horizontal, normalised); +X is left for a car facing +Z.
  const lx = tan.z / len;
  const lz = -tan.x / len;
  return { x: p.x + lx * lateralM, y: p.y, z: p.z + lz * lateralM, yaw: Math.atan2(tan.x, tan.z) };
}

/** Grid slot `behindM` metres behind the start line (t = 0). */
export function gridPose(track: TrackSampler, slotLateralM: number, behindM: number, lapLengthM: number): RespawnPose {
  return respawnPose(track, wrap01(1 - behindM / lapLengthM), slotLateralM);
}
