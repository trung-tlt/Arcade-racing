import type { TrackDef } from '../core/Data';
import type { TrackPath } from '../world/TrackPath';

// Cat Lai's yard traffic (reach stackers and yard trucks): plan and poses shared by the browser's quay scenery and the
// headless sim (no DOM / GL).

export interface RawCatLai {
  quay: { edgeX: number; fromN: number; toN: number; tileM: number };
  cranes: { sts: { positions: [number, number, number][] }; rtg: { positions: [number, number, number][] } };
  ships: { position: [number, number, number]; headingDeg: number }[];
  ferry: { landing: [number, number, number]; crossing: { to: [number, number, number]; durationSec: number } };
  yardTraffic: { reachStackers: { count: number }; trucks: number };
  shortcut: {
    fromT: number;
    toT: number;
    widthM: number;
    points: [number, number, number][];
    ramp: { position: [number, number, number]; heightM: number; lengthM: number };
  };
  roadLayout: { yardLanes: { widthM: number } };
}

export const catLaiRaw = (track: TrackDef): RawCatLai => track.raw as unknown as RawCatLai;

/** Reach stacker body (chassis) and truck footprint for kinematic colliders. */
export const STACKER_HALF: [number, number, number] = [2.4, 1.9, 5.5];
export const TRUCK_HALF: [number, number, number] = [1.25, 1.95, 8.2];

export const SHORTCUT_WALL_GAP_M = 3.8;
export const SHORTCUT_WALL_THICKNESS_M = 0.8;
/** One reach-stacker crossing: it shuttles A ↔ B across a lane, dwelling at each side. */
export interface Crossing {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  phaseSec: number;
}
export interface StackerPose {
  x: number;
  z: number;
  yaw: number;
}

export const STACKER_DWELL_SEC = 8;
export const STACKER_CROSS_SEC = 6;

/** Smooth 0→1 step. */
export const smooth = (k: number): number => {
  const c = Math.min(1, Math.max(0, k));
  return c * c * (3 - 2 * c);
};

/**
 * Pose along a crossing. The stacker waits parked PARALLEL to the lane, beside it (an 11 m machine parked across the
 * lane would block it), then swings square to the lane for the crossing and back again.
 */
export function stackerPose(c: Crossing, timeSec: number, out: StackerPose): StackerPose {
  const period = 2 * (STACKER_DWELL_SEC + STACKER_CROSS_SEC);
  const u = (((timeSec + c.phaseSec) % period) + period) % period;
  const toB = Math.atan2(c.bx - c.ax, c.bz - c.az);
  let k: number;
  let dir: number;
  if (u < STACKER_DWELL_SEC) {
    k = 0;
    dir = 0;
  } else if (u < STACKER_DWELL_SEC + STACKER_CROSS_SEC) {
    k = smooth((u - STACKER_DWELL_SEC) / STACKER_CROSS_SEC);
    dir = 0;
  } else if (u < 2 * STACKER_DWELL_SEC + STACKER_CROSS_SEC) {
    k = 1;
    dir = 1;
  } else {
    k = 1 - smooth((u - 2 * STACKER_DWELL_SEC - STACKER_CROSS_SEC) / STACKER_CROSS_SEC);
    dir = 1;
  }
  // 1 while square to the lane (mid-crossing), 0 when parked at either side.
  const square = smooth(k / 0.15) * (1 - smooth((k - 0.85) / 0.15));
  const base = toB + dir * Math.PI;
  out.yaw = base + (1 - square) * (dir === 0 ? Math.PI / 2 : -Math.PI / 2);
  out.x = c.ax + (c.bx - c.ax) * k;
  out.z = c.az + (c.bz - c.az) * k;
  return out;
}

/**
 * Where the stackers cross: two crossings of the Reefer lane (at 40 % and 75 % of its length, along Z) and one of
 * the yard lane at the shortcut's mouth (along the lane's normal). Each spans the road plus `margin` on both sides.
 */
export function stackerCrossings(track: TrackDef, _path: TrackPath, count: number): Crossing[] {
  const raw = catLaiRaw(track);
  const pts = raw.shortcut.points;
  const sx0 = pts[0][0];
  const sx1 = pts[pts.length - 1][0];
  const sz = pts[0][2];
  // Parked beside the side walls: wall outer face + half the machine's width + a little air.
  const half = SHORTCUT_WALL_GAP_M + SHORTCUT_WALL_THICKNESS_M + STACKER_HALF[0] + 0.3;
  // Never on the racing roads: the yard lane is 10 m wide between container stacks and the stacker is 11 m long.
  const out: Crossing[] = [];
  for (const f of [0.2, 0.6, 0.85]) {
    const x = sx0 + (sx1 - sx0) * f;
    out.push({ ax: x, az: sz - half, bx: x, bz: sz + half, phaseSec: 0 });
  }
  const n = Math.min(count, out.length);
  return out.slice(0, n).map((c, k) => ({ ...c, phaseSec: k * 7 }));
}

/** The straight stretch of the yard lane where the trucks shuttle (t window) — wrap inside it. */
export const YARD_TRUCK_FROM_T = 0.322;
export const YARD_TRUCK_TO_T = 0.39;
export const YARD_TRUCK_SPEED_MPS = 4;

/** Along-track t of yard truck `k` of `n` after `timeSec`: evenly spaced, wrapping inside the window. */
export function yardTruckT(k: number, n: number, timeSec: number, lengthM: number): number {
  const span = YARD_TRUCK_TO_T - YARD_TRUCK_FROM_T;
  const u = (((k / n + (timeSec * YARD_TRUCK_SPEED_MPS) / (span * lengthM)) % 1) + 1) % 1;
  return YARD_TRUCK_FROM_T + u * span;
}
