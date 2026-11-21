import type { SnapCar } from '../shared/protocol';

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

/** A car body's kinematic state. */
export interface BodyState {
  p: V3;
  q: Q4;
  v: V3;
  w: V3;
}

/** What the reconciler needs from the local physics body. */
export interface ReconcileBody {
  read(out: BodyState): void;
  /** Move the body by `dp`, turn it by `dq` (applied as dq * q) and add `dv` to its velocity. */
  nudge(dp: V3, dq: Q4, dv: V3): void;
  /** Overwrite the body's state (hard snap). */
  set(state: BodyState): void;
}

export interface ReconcileConfig {
  /** Position errors under this (m) are ignored. */
  deadbandM: number;
  /** Position errors over this (m) hard-snap instead of blending. */
  snapM: number;
  /** Rotation errors under this (rad) are ignored. */
  deadbandRad: number;
  /** Time constant (s) over which an error is blended out. */
  tauSec: number;
  /** Fixed step (s). */
  dtSec: number;
}

export const DEFAULT_RECONCILE: ReconcileConfig = {
  deadbandM: 0.04,
  snapM: 3,
  deadbandRad: 0.02,
  tauSec: 0.12,
  dtSec: 1 / 60,
};

interface Hist {
  seq: number;
  p: V3;
  q: Q4;
  v: V3;
  /** Total position / velocity / rotation nudges applied before this entry was recorded. */
  ap: V3;
  av: V3;
  aq: Q4;
}

export type ReconcileKind = 'none' | 'smooth' | 'snap' | 'unknown';

export interface ReconcileResult {
  kind: ReconcileKind;
  /** Position error (m) found against the prediction at the acked input. */
  errM: number;
  errRad: number;
}

const qmul = (a: Q4, b: Q4): Q4 => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (a: Q4): Q4 => [-a[0], -a[1], -a[2], a[3]];
const qnorm = (a: Q4): Q4 => {
  const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l, a[3] / l];
};
/** Angle (rad) of a unit quaternion's rotation. */
const qangle = (a: Q4): number => 2 * Math.acos(Math.min(1, Math.abs(a[3])));
/** Fraction `k` of the rotation `a` (nlerp from identity, shorter arc). */
const qfrac = (a: Q4, k: number): Q4 => {
  const s = a[3] < 0 ? -1 : 1;
  return qnorm([a[0] * s * k, a[1] * s * k, a[2] * s * k, 1 + (a[3] * s - 1) * k]);
};
const IDENT: Q4 = [0, 0, 0, 1];

/**
 * Client-side prediction fix-up. The local car runs the same sim with the same inputs as the server, so it is almost
 * always right; when a snapshot disagrees (a bump on the server, a different traffic clock, drift) the difference is
 * blended out over ~100 ms instead of popping, and a gap over `snapM` is a hard snap. No re-simulation: the local world
 * holds other bodies too, so only the own car's state is nudged.
 */
export class Reconciler {
  private readonly hist: Hist[] = [];
  private readonly cfg: ReconcileConfig;
  private pendingP: V3 = [0, 0, 0];
  private pendingV: V3 = [0, 0, 0];
  private pendingQ: Q4 = IDENT;
  private appliedP: V3 = [0, 0, 0];
  private appliedV: V3 = [0, 0, 0];
  private appliedQ: Q4 = IDENT;
  private readonly scratch: BodyState = { p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0] };

  constructor(
    config: Partial<ReconcileConfig> = {},
    private readonly maxHistory = 180,
  ) {
    this.cfg = { ...DEFAULT_RECONCILE, ...config };
  }

  /** Call after each local step with the sim tick count reached (the same count the server's snapshots carry). */
  record(tick: number, body: ReconcileBody): void {
    body.read(this.scratch);
    const s = this.scratch;
    this.hist.push({
      seq: tick,
      p: [...s.p],
      q: [...s.q],
      v: [...s.v],
      ap: [...this.appliedP],
      av: [...this.appliedV],
      aq: [...this.appliedQ],
    });
    if (this.hist.length > this.maxHistory) this.hist.shift();
  }

  /**
   * The server's state for our car after `tick` sim ticks (a snapshot's `tick`). `localTick` is how far the local sim has
   * got: it runs a few ticks ahead of the server, so a hard snap puts the car where the server's car will be by then.
   */
  onSnapshot(tick: number, srv: SnapCar, body: ReconcileBody, localTick = tick): ReconcileResult {
    const h0 = this.hist[0];
    const h = h0 && tick >= h0.seq ? this.hist[tick - h0.seq] : undefined;
    if (!h || h.seq !== tick) return { kind: 'unknown', errM: 0, errRad: 0 };
    // Prediction at that tick, corrected for the nudges applied since it was recorded.
    const predP: V3 = [
      h.p[0] + (this.appliedP[0] - h.ap[0]),
      h.p[1] + (this.appliedP[1] - h.ap[1]),
      h.p[2] + (this.appliedP[2] - h.ap[2]),
    ];
    const predV: V3 = [
      h.v[0] + (this.appliedV[0] - h.av[0]),
      h.v[1] + (this.appliedV[1] - h.av[1]),
      h.v[2] + (this.appliedV[2] - h.av[2]),
    ];
    const sinceQ = qmul(this.appliedQ, qconj(h.aq));
    const predQ = qmul(sinceQ, h.q);
    const ep: V3 = [srv.p[0] - predP[0], srv.p[1] - predP[1], srv.p[2] - predP[2]];
    const errM = Math.hypot(ep[0], ep[1], ep[2]);
    const eq = qnorm(qmul(srv.q as Q4, qconj(predQ)));
    const errRad = qangle(eq);

    if (errM > this.cfg.snapM) {
      body.set(this.advanced(srv, Math.max(0, localTick - tick)));
      this.hist.length = 0;
      this.pendingP = [0, 0, 0];
      this.pendingV = [0, 0, 0];
      this.pendingQ = IDENT;
      return { kind: 'snap', errM, errRad };
    }
    const moveP = errM > this.cfg.deadbandM;
    const moveQ = errRad > this.cfg.deadbandRad;
    this.pendingP = moveP ? ep : [0, 0, 0];
    this.pendingV = moveP ? [srv.v[0] - predV[0], srv.v[1] - predV[1], srv.v[2] - predV[2]] : [0, 0, 0];
    this.pendingQ = moveQ ? eq : IDENT;
    return { kind: moveP || moveQ ? 'smooth' : 'none', errM, errRad };
  }

  /** The server's state moved forward by `ticks` along its velocity and yaw rate (dead reckoning). */
  advanced(srv: SnapCar, ticks: number): BodyState {
    const t = ticks * this.cfg.dtSec;
    let q: Q4 = [...srv.q];
    if (t > 0 && srv.w[1] !== 0) {
      const a = (srv.w[1] * t) / 2;
      q = qnorm(qmul([0, Math.sin(a), 0, Math.cos(a)], q));
    }
    return {
      p: [srv.p[0] + srv.v[0] * t, srv.p[1] + srv.v[1] * t, srv.p[2] + srv.v[2] * t],
      q,
      v: [...srv.v],
      w: [...srv.w],
    };
  }

  /** Call once per local step (before stepping the world): applies a slice of the pending correction. */
  apply(body: ReconcileBody): void {
    const k = 1 - Math.exp(-this.cfg.dtSec / this.cfg.tauSec);
    const dp: V3 = [this.pendingP[0] * k, this.pendingP[1] * k, this.pendingP[2] * k];
    const dv: V3 = [this.pendingV[0] * k, this.pendingV[1] * k, this.pendingV[2] * k];
    const dq = qfrac(this.pendingQ, k);
    const any = dp[0] !== 0 || dp[1] !== 0 || dp[2] !== 0 || dv[0] !== 0 || dv[1] !== 0 || dv[2] !== 0 || dq[3] !== 1;
    if (!any) return;
    body.nudge(dp, dq, dv);
    for (let i = 0; i < 3; i++) {
      this.pendingP[i] -= dp[i];
      this.pendingV[i] -= dv[i];
      this.appliedP[i] += dp[i];
      this.appliedV[i] += dv[i];
    }
    this.pendingQ = qnorm(qmul(this.pendingQ, qconj(dq)));
    this.appliedQ = qnorm(qmul(dq, this.appliedQ));
  }

  /** Diagnostics: the first and last tick in the history (null when empty). */
  historyRange(): [number, number] | null {
    return this.hist.length > 0 ? [this.hist[0].seq, this.hist[this.hist.length - 1].seq] : null;
  }

  /** Forget everything (the car was respawned locally or the race restarted). */
  reset(): void {
    this.hist.length = 0;
    this.pendingP = [0, 0, 0];
    this.pendingV = [0, 0, 0];
    this.pendingQ = IDENT;
  }
}
