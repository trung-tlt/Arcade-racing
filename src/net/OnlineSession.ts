import type { NetEvent, ServerMsg, SnapCar, SnapRocket } from '../shared/protocol';
import { ClockSync } from './ClockSync';
import { Interpolator, PoseSmoother, type RemotePose } from './Interpolator';
import { Reconciler, type ReconcileBody, type ReconcileResult } from './Reconciler';

type Snap = Extract<ServerMsg, { t: 'snap' }>;

/** First guess for how many ticks the local sim runs ahead of the server; the margin controller corrects it. */
export const INITIAL_LEAD_TICKS = 8;
/** The margin (ticks between our newest input frame and the server's tick) the controller aims to stay within. */
const TARGET_MIN_MARGIN = 2;
const TARGET_MAX_MARGIN = 8;
/** Most the controller will ask for in one review: catching up a stalled tab, or holding back after a burst. */
const MAX_CATCHUP_TICKS = 600;
const MAX_HOLD_TICKS = 120;
/** When the server has acked nothing yet (we have been too far behind to send), assume this one-way delay (ticks). */
const FALLBACK_LATENCY_TICKS = 6;
/** Seconds the drawn remote cars lag behind the newest snapshot. */
export const INTERP_DELAY_SEC = 0.1;

export interface ReconcileLogEntry extends ReconcileResult {
  nearOther: boolean;
  tick: number;
}

/**
 * Everything a client does with the server's snapshots, independent of how it renders: tick-aligned prediction for the
 * own car (`Reconciler`), interpolation of everyone else, the clock, and the controller that keeps the client a few ticks
 * ahead of the server. `SimClient` (headless, tested) and `Game` (browser) both drive this same class.
 */
export class OnlineSession {
  readonly clock = new ClockSync();
  readonly reconciler = new Reconciler();
  readonly log: ReconcileLogEntry[] = [];
  snap: Snap | null = null;
  /** Ticks the sim should add (+) or skip (-), steered from the server's margin reports. */
  private advance = 0;
  private readonly margins: number[] = [];
  private lastLate = 0;
  private ownRs = -1;
  private readonly remotes = new Map<string, { ip: Interpolator; sm: PoseSmoother; pose: RemotePose }>();
  private body: ReconcileBody | null = null;
  /** Ticks still to add (+) or hold (-): diagnostics. */
  get pendingAdvance(): number {
    return this.advance;
  }

  /** Called with the events that arrived in a snapshot, in order (combat feedback, wrecks, pickups). */
  onEvents: ((events: NetEvent[], snap: Snap) => void) | null = null;
  /** Called when the server teleports our own car (wreck respawn, reset), before its state is adopted. */
  onOwnTeleport: ((c: SnapCar) => void) | null = null;
  /** Rockets in flight as of the newest snapshot, the local time it arrived, and the pickups currently taken. */
  rockets: SnapRocket[] = [];
  rocketsAtSec = 0;
  takenPickups: number[] = [];

  /** Lowest margin seen in the last review window (diagnostics). */
  minMargin = Infinity;
  /** The newest margin report: ticks our newest input frame was ahead of the server's tick (diagnostics). */
  lastMargin = 0;
  localTick = 0;

  constructor(
    readonly selfId: string,
    private readonly interpDelaySec = INTERP_DELAY_SEC,
  ) {}

  /** The reconciler's access to the own car's physics body. Set once the car exists. */
  setBody(body: ReconcileBody): void {
    this.body = body;
  }

  /** How many local ticks to run before going live, given the first snapshot (we run `INITIAL_LEAD_TICKS` ahead). */
  startTicks(first: Snap): number {
    return first.tick + INITIAL_LEAD_TICKS;
  }

  /** Feed a snapshot. `nowSec`: the local clock (any monotonic seconds) when it arrived. */
  onSnapshot(m: Snap, nowSec: number): void {
    this.snap = m;
    this.clock.onSnapshot(m.time, nowSec);
    for (const c of m.cars) {
      if (c.id === this.selfId) this.onOwn(m, c);
      else this.onRemote(m, c);
    }
    this.rockets = m.rk;
    this.rocketsAtSec = nowSec;
    this.takenPickups = m.pk;
    if (m.ev.length > 0) this.onEvents?.(m.ev, m);
    this.steerLead(m);
  }

  private onOwn(m: Snap, c: SnapCar): void {
    const body = this.body;
    if (!body) return;
    if (this.ownRs >= 0 && c.rs !== this.ownRs) {
      // The server teleported us (wreck respawn / reset): adopt its state; the old history is meaningless.
      this.onOwnTeleport?.(c);
      body.set(this.reconciler.advanced(c, Math.max(0, this.localTick - m.tick)));
      this.reconciler.reset();
      this.log.push({ kind: 'snap', errM: 0, errRad: 0, nearOther: false, tick: m.tick });
    } else {
      const res = this.reconciler.onSnapshot(m.tick, c, body, this.localTick);
      const near = m.cars.some((o) => o.id !== c.id && Math.hypot(o.p[0] - c.p[0], o.p[2] - c.p[2]) < 9);
      this.log.push({ ...res, nearOther: near, tick: m.tick });
    }
    this.ownRs = c.rs;
  }

  private onRemote(m: Snap, c: SnapCar): void {
    let r = this.remotes.get(c.id);
    if (!r) {
      r = {
        ip: new Interpolator(),
        sm: new PoseSmoother(),
        pose: { p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], st: 0, fl: 0, hp: 0, rs: 0, extrapolating: false },
      };
      this.remotes.set(c.id, r);
    }
    r.ip.push(m.time, c);
  }

  /**
   * Keep our input frames arriving a couple of ticks before the server needs them: too close (or late) and the client
   * runs extra ticks to get further ahead; too far ahead and it holds a tick or two. Reviewed every 10 snapshots, and
   * only once the previous correction has been fully played out (reviewing earlier would stack corrections on top of
   * ones that have not taken effect yet and wind the sim up).
   */
  private steerLead(m: Snap): void {
    // The server's view (how far ahead of its tick our newest frame arrived); until it has seen a frame from us, our own
    // lead over its tick less an assumed trip time stands in, so a client that starts far behind still finds its way.
    this.lastMargin = m.ack >= 0 ? m.ack - m.tick : this.localTick - m.tick - FALLBACK_LATENCY_TICKS;
    this.margins.push(this.lastMargin);
    const newLate = m.late > this.lastLate;
    this.lastLate = m.late;
    if (Math.abs(this.advance) >= 1) {
      this.margins.length = 0; // still correcting: these margins describe the old situation
      return;
    }
    if (this.margins.length < 10) return;
    const min = Math.min(...this.margins);
    this.minMargin = min;
    this.margins.length = 0;
    if (min < TARGET_MIN_MARGIN || newLate) {
      // A small shortfall is trimmed gently; a big one (a throttled tab, a long stall) is caught up in one go.
      this.advance = Math.min(MAX_CATCHUP_TICKS, Math.max(1, TARGET_MIN_MARGIN - min));
    } else if (min > TARGET_MAX_MARGIN) {
      this.advance = -Math.min(MAX_HOLD_TICKS, min - TARGET_MAX_MARGIN + 2);
    }
  }

  /** How many sim steps to run this frame: 0 holds a tick, 1 is normal, more catches up. */
  planSteps(): number {
    const n = this.plan();
    this.stepStats.frames++;
    if (n === 0) this.stepStats.holds++;
    else if (n > 1) this.stepStats.catchUps++;
    return n;
  }

  /** Frames the lead controller held (0 steps) or caught up (extra steps) since the counters were last read: visible hitches. */
  readonly stepStats = { frames: 0, holds: 0, catchUps: 0 };

  private plan(): number {
    if (this.advance >= 1) {
      // Small gaps close at +3 steps a frame; a large one (> 30 ticks) catches up in chunks of 16.
      const per = this.advance > 30 ? 16 : 3;
      const extra = Math.min(per, Math.floor(this.advance));
      this.advance -= extra;
      return 1 + extra;
    }
    if (this.advance <= -1) {
      this.advance += 1;
      return 0;
    }
    return 1;
  }

  /** Before each local step: blend a slice of any pending correction into the own car. */
  beforeStep(): void {
    if (this.body) this.reconciler.apply(this.body);
  }

  /** After each local step: remember the own car's state for this tick. */
  afterStep(localTick: number): void {
    this.localTick = localTick;
    if (this.body) this.reconciler.record(localTick, this.body);
  }

  get ready(): boolean {
    return this.snap !== null && this.clock.ready;
  }

  /** Server sim time (s) the remote cars should be drawn at. */
  renderTime(nowSec: number): number {
    return this.clock.serverTime(nowSec) - this.interpDelaySec;
  }

  /** The server time, in ticks, that the remote cars are being drawn at (sent with each input for lag compensation). */
  viewTick(nowSec: number): number | undefined {
    return this.clock.ready ? Math.max(0, this.renderTime(nowSec) * 60) : undefined;
  }

  /** The interpolated, smoothed pose of a remote car at `nowSec`, or null before its first snapshot. */
  remotePose(id: string, nowSec: number, dtSec: number): { pose: RemotePose; shown: [number, number, number] } | null {
    const r = this.remotes.get(id);
    if (!r) return null;
    const pose = r.ip.sample(this.renderTime(nowSec), r.pose);
    if (!pose) return null;
    return { pose, shown: r.sm.follow(pose, dtSec) };
  }

  remoteIds(): string[] {
    return [...this.remotes.keys()];
  }

  remoteSamples(id: string): number {
    return this.remotes.get(id)?.ip.size ?? 0;
  }
}
