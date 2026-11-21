import { STEP } from '../core/Loop';
import type { Conn, Player, Room } from '../server/Room';
import {
  PROTOCOL_VERSION,
  encode,
  parseClientMessage,
  parseServerMessage,
  type ClientMsg,
  type ServerMsg,
  type SnapCar,
} from '../shared/protocol';
import { RaceSim } from '../sim/RaceSim';
import { snapOfEntry } from '../sim/snapshot';
import { dataHash } from '../shared/dataHash';
import { ClockSync } from './ClockSync';
import { Interpolator, PoseSmoother, type RemotePose } from './Interpolator';
import { NetPilot } from './NetPilot';
import { rapierBody } from './RapierBody';
import { Reconciler, type ReconcileResult } from './Reconciler';
import type { LinkConfig, VirtualNet } from './VirtualNet';

/** First guess for how many ticks the client runs ahead of the server; the controller corrects it. */
const INITIAL_LEAD_TICKS = 8;

export interface SimClientOpts {
  net: VirtualNet;
  room: Room;
  trackId: string;
  carId: string;
  name: string;
  up: LinkConfig;
  down: LinkConfig;
  /** Render delay behind the server clock (s). */
  interpDelaySec?: number;
  laps?: number;
}

export interface JumpRecord {
  id: string;
  /** Rendered displacement beyond what the car's own speed explains (m). */
  excessM: number;
  atMs: number;
}

/**
 * A whole headless client in virtual time: it joins a `Room` over lossy links, predicts its own car in a local sim with
 * the same inputs it sends, reconciles that prediction against snapshots, and interpolates everyone else. The input is
 * produced by the snapshot-driven `NetPilot` reading the *predicted* state, like a human watching their own screen.
 * Used by the network tests and (later) the load test.
 */
export class SimClient {
  readonly id: string;
  readonly player: Player;
  readonly clock = new ClockSync();
  readonly reconciler = new Reconciler();
  readonly remotes = new Map<string, Interpolator>();
  private readonly smoothers = new Map<string, PoseSmoother>();
  readonly reconcileLog: (ReconcileResult & { nearOther: boolean; tick: number; t: number; speed: number })[] = [];
  readonly jumps: JumpRecord[] = [];
  readonly lastSnap: { msg: Extract<ServerMsg, { t: 'snap' }> | null } = { msg: null };
  snaps = 0;
  results: unknown = null;
  private local: RaceSim | null = null;
  private pilot: NetPilot;
  /** Ticks the local sim runs ahead of the server; steered by the margin the server reports. */
  private advance = 0;
  private readonly margins: number[] = [];
  private lastLate = 0;
  /** Margin controller state, exposed for tests. */
  minMargin = Infinity;
  readonly ownRs = { v: -1 };
  private readonly sendUp: (deliver: () => void) => void;
  private readonly interpDelay: number;
  private readonly prevView = new Map<string, { p: [number, number, number]; rs: number }>();
  private readonly pose: RemotePose = {
    p: [0, 0, 0],
    q: [0, 0, 0, 1],
    v: [0, 0, 0],
    st: 0,
    fl: 0,
    hp: 0,
    rs: 0,
    extrapolating: false,
  };
  private gridSlot = 0;
  private readonly rsOf = new Map<string, number>();

  constructor(private readonly o: SimClientOpts) {
    const sendDown = o.net.link(o.down);
    this.sendUp = o.net.link(o.up);
    this.interpDelay = o.interpDelaySec ?? 0.1;
    const conn: Conn = {
      send: (text) => sendDown(() => this.onText(text)),
      close: () => undefined,
    };
    const joined = o.room.join(conn, {
      t: 'join',
      v: PROTOCOL_VERSION,
      hash: dataHash(),
      name: o.name,
      car: o.carId,
      room: o.room.code,
      track: o.trackId,
      laps: o.laps,
    });
    if (typeof joined === 'string') throw new Error(`join rejected: ${joined}`);
    this.player = joined;
    this.id = joined.id;
    this.pilot = new NetPilot(o.trackId, this.id, o.carId);
  }

  /** Send a message to the server (through the uplink, in order, validated like a real socket). */
  send(msg: ClientMsg): void {
    const text = encode(msg);
    this.sendUp(() => {
      const parsed = parseClientMessage(text);
      if (parsed.ok) this.o.room.handle(this.player, parsed.msg);
    });
  }

  private onText(text: string): void {
    const m = parseServerMessage(text);
    if (!m) return;
    const nowSec = this.o.net.now / 1000;
    if (m.t === 'state') {
      if (m.phase === 'results') this.results = m.results;
    } else if (m.t === 'snap') {
      this.snaps++;
      this.lastSnap.msg = m;
      this.clock.onSnapshot(m.time, nowSec);
      for (const c of m.cars) {
        this.rsOf.set(c.id, c.rs);
        if (c.id === this.id) {
          if (this.local) {
            const body = rapierBody(this.local.entries[0].car.physics.body);
            if (this.ownRs.v >= 0 && c.rs !== this.ownRs.v) {
              // The server teleported us (wreck respawn / reset): adopt its state, the old history is meaningless.
              body.set(this.reconciler.advanced(c, Math.max(0, this.local.tick - m.tick)));
              this.reconciler.reset();
              this.reconcileLog.push({
                kind: 'snap',
                errM: 0,
                errRad: 0,
                nearOther: false,
                tick: m.tick,
                t: c.t,
                speed: 0,
              });
            } else {
              const res = this.reconciler.onSnapshot(m.tick, c, body, this.local.tick);
              const near = m.cars.some((o) => o.id !== c.id && Math.hypot(o.p[0] - c.p[0], o.p[2] - c.p[2]) < 9);
              this.reconcileLog.push({
                ...res,
                nearOther: near,
                tick: m.tick,
                t: c.t,
                speed: Math.hypot(c.v[0], c.v[2]),
              });
            }
          }
          this.ownRs.v = c.rs;
        } else {
          let ip = this.remotes.get(c.id);
          if (!ip) this.remotes.set(c.id, (ip = new Interpolator()));
          ip.push(m.time, c);
        }
      }
      this.steerLead(m.ack - m.tick, m.late);
    }
  }

  /**
   * Keep our input frames arriving a couple of ticks before the server needs them: too close (or late) and the client
   * runs extra ticks to get further ahead; too far ahead and it holds a tick or two. Reviewed every 10 snapshots.
   */
  private steerLead(margin: number, late: number): void {
    if (!this.local) return;
    if (margin > -1000 && this.lastSnap.msg && this.lastSnap.msg.ack >= 0) this.margins.push(margin);
    const newLate = late > this.lastLate;
    this.lastLate = late;
    if (this.margins.length < 10) return;
    const min = Math.min(...this.margins);
    this.minMargin = min;
    this.margins.length = 0;
    const TARGET_MIN = 2;
    const TARGET_MAX = 8;
    if (min < TARGET_MIN || newLate) this.advance += Math.max(1, TARGET_MIN - min);
    else if (min > TARGET_MAX) this.advance -= min - TARGET_MAX + 2;
  }

  /** The local sim is created at the first snapshot, fast-forwarded to the server's clock so the countdowns line up. */
  private startLocal(first: Extract<ServerMsg, { t: 'snap' }>): void {
    const me = first.cars.findIndex((c) => c.id === this.id);
    // Same grid slot as on the server: humans fill from the back.
    const slot = 5 - Number(this.id.slice(1)) + 1;
    this.gridSlot = me >= 0 ? slot : 0;
    this.local = new RaceSim({
      trackId: this.o.trackId,
      laps: this.o.laps ?? 1,
      slots: [{ id: this.id, carId: this.o.carId, kind: 'human', gridSlot: this.gridSlot }],
      combat: false,
    });
    // Run ahead of the server from the start; the margin controller trims it from there.
    const target = first.tick + INITIAL_LEAD_TICKS;
    for (let i = 0; i < target; i++) {
      this.local.setTrafficTime(i * STEP);
      this.local.step();
    }
  }

  /** One client frame (60 Hz): read the screen, press the pedals, step the local sim, tell the server. */
  frame(): void {
    const snap = this.lastSnap.msg;
    if (!this.local) {
      if (!snap || snap.phase === 'lobby') return;
      this.startLocal(snap);
    }
    const local = this.local as RaceSim;
    const mine = local.entries[0];
    const nowSec = this.o.net.now / 1000;
    const serverNow = this.clock.serverTime(nowSec);
    // The pilot "sees" its predicted car and the interpolated others.
    const view: SnapCar[] = [snapOfEntry(mine, 1, 0, false)];
    const renderT = serverNow - this.interpDelay;
    for (const [id, ip] of this.remotes) {
      const p = ip.sample(renderT, this.pose);
      if (!p) continue;
      const last = snap?.cars.find((c) => c.id === id);
      view.push({
        id,
        p: [...p.p],
        q: [...p.q],
        v: [...p.v],
        w: [0, 0, 0],
        hp: p.hp,
        nb: 0,
        lap: 1,
        t: last?.t ?? 0,
        fl: p.fl,
        st: p.st,
        rs: 0,
      });
      let sm = this.smoothers.get(id);
      if (!sm) this.smoothers.set(id, (sm = new PoseSmoother()));
      const shown = sm.follow(p, STEP);
      this.trackJumps(id, p, shown, ip);
    }
    // Margin controller: >0 extra ticks to catch up, <0 hold.
    let steps = 1;
    if (this.advance >= 1) {
      steps = 1 + Math.min(3, Math.floor(this.advance));
      this.advance -= steps - 1;
    } else if (this.advance <= -1) {
      steps = 0;
      this.advance += 1;
    }
    for (let i = 0; i < steps; i++) {
      const tick = local.tick;
      const ctl = this.pilot.read(view, mine.race.controlsLocked);
      this.send({ t: 'input', tick, ...ctl });
      const body = rapierBody(mine.car.physics.body);
      this.reconciler.apply(body);
      local.setInput(this.id, ctl);
      local.setTrafficTime(tick * STEP);
      local.step();
      this.reconciler.record(local.tick, body);
    }
  }

  private trackJumps(id: string, p: RemotePose, shown: [number, number, number], ip: Interpolator): void {
    const rs = p.rs;
    const prev = this.prevView.get(id);
    if (prev && prev.rs === rs && ip.size > 2) {
      const d = Math.hypot(shown[0] - prev.p[0], shown[2] - prev.p[2]);
      const expected = Math.hypot(p.v[0], p.v[2]) * STEP;
      const excess = d - expected;
      if (excess > 1) this.jumps.push({ id, excessM: excess, atMs: this.o.net.now });
    }
    this.prevView.set(id, { p: [...shown], rs });
  }

  get predictedSpeed(): number {
    const e = this.local?.entries[0];
    return e ? e.car.physics.speedMps : 0;
  }

  get localSim(): RaceSim | null {
    return this.local;
  }
}
