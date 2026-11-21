import type { SnapCar } from '../shared/protocol';

export interface RemotePose {
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  /** Front-wheel steer angle, flags and hit points of the later sample (not interpolated). */
  st: number;
  fl: number;
  hp: number;
  /** Respawn counter of the sample the pose is on (changes when the car teleports). */
  rs: number;
  /** True while the pose is extrapolated past the newest snapshot. */
  extrapolating: boolean;
}

interface Sample {
  time: number;
  car: SnapCar;
}

/** Longest the newest snapshot may be extrapolated by velocity (seconds). */
export const MAX_EXTRAPOLATE_SEC = 0.15;

/**
 * Smooth motion for a remote car: the render clock runs ~100 ms behind the newest snapshot so there are almost always
 * two samples to blend. Position is blended linearly, rotation by normalised lerp. If the newest snapshot is older than
 * the render clock the car is extrapolated along its velocity for at most 150 ms, then held. A change of the respawn
 * counter `rs` (wreck respawn, reset) is a teleport: the car jumps, it is never blended across.
 */
export class Interpolator {
  private readonly buf: Sample[] = [];

  constructor(private readonly maxSamples = 40) {}

  push(timeSec: number, car: SnapCar): void {
    const last = this.buf[this.buf.length - 1];
    if (last && timeSec <= last.time) return; // duplicate or stale
    this.buf.push({ time: timeSec, car });
    if (this.buf.length > this.maxSamples) this.buf.shift();
  }

  get size(): number {
    return this.buf.length;
  }

  /** Pose at server time `t`, or null before the first snapshot. */
  sample(t: number, out?: RemotePose): RemotePose | null {
    const b = this.buf;
    if (b.length === 0) return null;
    const pose = out ?? {
      p: [0, 0, 0],
      q: [0, 0, 0, 1],
      v: [0, 0, 0],
      st: 0,
      fl: 0,
      hp: 0,
      rs: 0,
      extrapolating: false,
    };
    // Newest sample at or before t.
    let i = b.length - 1;
    while (i > 0 && b[i].time > t) i--;
    const a = b[i];
    const next = b[i + 1];
    if (!next) {
      const ahead = Math.min(MAX_EXTRAPOLATE_SEC, Math.max(0, t - a.time));
      set(pose, a.car, a.car);
      pose.p = [a.car.p[0] + a.car.v[0] * ahead, a.car.p[1] + a.car.v[1] * ahead, a.car.p[2] + a.car.v[2] * ahead];
      pose.extrapolating = t > a.time;
      return pose;
    }
    pose.extrapolating = false;
    if (t <= a.time) {
      set(pose, a.car, a.car);
      return pose;
    }
    if (a.car.rs !== next.car.rs) {
      // Teleport between the two: stay on the old side until the new snapshot's time, then jump.
      const c = t >= next.time ? next.car : a.car;
      set(pose, c, c);
      return pose;
    }
    const k = (t - a.time) / (next.time - a.time);
    set(pose, a.car, next.car);
    const pa = a.car.p;
    const pb = next.car.p;
    pose.p = [pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k, pa[2] + (pb[2] - pa[2]) * k];
    pose.v = [
      a.car.v[0] + (next.car.v[0] - a.car.v[0]) * k,
      a.car.v[1] + (next.car.v[1] - a.car.v[1]) * k,
      a.car.v[2] + (next.car.v[2] - a.car.v[2]) * k,
    ];
    pose.q = nlerp(a.car.q, next.car.q, k);
    return pose;
  }
}

function set(pose: RemotePose, a: SnapCar, b: SnapCar): void {
  pose.p = [a.p[0], a.p[1], a.p[2]];
  pose.q = [a.q[0], a.q[1], a.q[2], a.q[3]];
  pose.v = [a.v[0], a.v[1], a.v[2]];
  pose.st = b.st;
  pose.fl = b.fl;
  pose.hp = b.hp;
  pose.rs = b.rs;
}

/** Normalised lerp of two unit quaternions along the shorter arc. */
export function nlerp(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
  k: number,
): [number, number, number, number] {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  const x = a[0] + (s * b[0] - a[0]) * k;
  const y = a[1] + (s * b[1] - a[1]) * k;
  const z = a[2] + (s * b[2] - a[2]) * k;
  const w = a[3] + (s * b[3] - a[3]) * k;
  const len = Math.hypot(x, y, z, w) || 1;
  return [x / len, y / len, z / len, w / len];
}

/**
 * Rate-limited follower for a remote car's drawn position. After a network stall the interpolator's target can be metres
 * ahead of what was drawn; the smoother closes that gap at a bounded extra speed (half the car's speed plus a little)
 * instead of popping, so no frame moves a car more than ~0.6 m beyond its own motion. A teleport (respawn counter
 * changed) or a huge gap snaps.
 */
export class PoseSmoother {
  private shown: [number, number, number] | null = null;
  private rs = -1;

  constructor(
    private readonly snapM = 30,
    private readonly maxExtraSpeedMps = 3,
    private readonly extraSpeedFraction = 0.5,
  ) {}

  /** Smoothed drawn position for the interpolated `target` pose over `dtSec`. */
  follow(target: RemotePose, dtSec: number): [number, number, number] {
    const t = target.p;
    if (!this.shown || target.rs !== this.rs) {
      this.shown = [t[0], t[1], t[2]];
      this.rs = target.rs;
      return this.shown;
    }
    const s = this.shown;
    const mx = t[0] - s[0];
    const my = t[1] - s[1];
    const mz = t[2] - s[2];
    const gap = Math.hypot(mx, my, mz);
    if (gap > this.snapM) {
      this.shown = [t[0], t[1], t[2]];
      return this.shown;
    }
    // Chase the target at no more than the car's own speed plus a bounded extra: a stall's backlog is paid off over
    // several frames, and a held (frozen) target is simply reached, never overshot.
    const speed = Math.hypot(target.v[0], target.v[1], target.v[2]);
    const allowed = (speed * (1 + this.extraSpeedFraction) + this.maxExtraSpeedMps) * dtSec;
    const k = gap > allowed ? allowed / gap : 1;
    this.shown = [s[0] + mx * k, s[1] + my * k, s[2] + mz * k];
    return this.shown;
  }
}
