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
import { dataHash } from '../shared/dataHash';
import { RaceSim } from '../sim/RaceSim';
import { snapOfEntry } from '../sim/snapshot';
import { NetPilot } from './NetPilot';
import { OnlineSession } from './OnlineSession';
import { rapierBody } from './RapierBody';
import type { LinkConfig, VirtualNet } from './VirtualNet';

export interface SimClientOpts {
  net: VirtualNet;
  room: Room;
  trackId: string;
  carId: string;
  name: string;
  up: LinkConfig;
  down: LinkConfig;
  laps?: number;
}

export interface JumpRecord {
  id: string;
  /** Rendered displacement beyond what the car's own speed explains (m). */
  excessM: number;
  atMs: number;
}

/**
 * A whole headless client in virtual time: it joins a `Room` over lossy links and plays through an `OnlineSession`
 * exactly like the browser does: predicts its own car in a local sim with the inputs it sends, reconciles against
 * snapshots and interpolates everyone else. The inputs come from the snapshot-driven `NetPilot` reading the *predicted*
 * state, like a human watching their own screen. Used by the network tests and (later) the load test.
 */
export class SimClient {
  readonly id: string;
  readonly player: Player;
  readonly session: OnlineSession;
  readonly jumps: JumpRecord[] = [];
  results: unknown = null;
  private local: RaceSim | null = null;
  private readonly pilot: NetPilot;
  private readonly sendUp: (deliver: () => void) => void;
  private readonly prevView = new Map<string, { p: [number, number, number]; rs: number }>();

  constructor(private readonly o: SimClientOpts) {
    const sendDown = o.net.link(o.down);
    this.sendUp = o.net.link(o.up);
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
    this.session = new OnlineSession(this.id);
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
    const m: ServerMsg | null = parseServerMessage(text);
    if (!m) return;
    if (m.t === 'state' && m.phase === 'results') this.results = m.results;
    // The grid is announced: "build the race" is instant here, so we are ready at once.
    if (m.t === 'state' && m.phase === 'loading') this.send({ t: 'ready', ready: true });
    if (m.t === 'snap') this.session.onSnapshot(m, this.o.net.now / 1000);
  }

  /** The local sim is created at the first snapshot and run ahead of the server's tick. */
  private startLocal(first: Extract<ServerMsg, { t: 'snap' }>): void {
    // Same grid slot as on the server: humans fill from the back.
    const slot = 6 - Number(this.id.slice(1));
    this.local = new RaceSim({
      trackId: this.o.trackId,
      laps: this.o.laps ?? 1,
      slots: [{ id: this.id, carId: this.o.carId, kind: 'human', gridSlot: slot }],
      combat: false,
    });
    this.session.setBody(rapierBody(this.local.entries[0].car.physics.body));
    const target = this.session.startTicks(first);
    for (let i = 0; i < target; i++) {
      this.local.setTrafficTime(i * STEP);
      this.local.step();
    }
    this.session.localTick = this.local.tick;
  }

  /** One client frame (60 Hz): read the screen, press the pedals, step the local sim, tell the server. */
  frame(): void {
    const snap = this.session.snap;
    if (!this.local) {
      if (!snap || snap.phase === 'lobby') return;
      this.startLocal(snap);
    }
    const local = this.local as RaceSim;
    const mine = local.entries[0];
    const nowSec = this.o.net.now / 1000;
    // The pilot "sees" its predicted car and the smoothed remote cars.
    const view: SnapCar[] = [snapOfEntry(mine, 1, 0, false)];
    for (const id of this.session.remoteIds()) {
      const r = this.session.remotePose(id, nowSec, STEP);
      if (!r) continue;
      const last = snap?.cars.find((c) => c.id === id);
      view.push({
        id,
        p: [...r.shown],
        q: [...r.pose.q],
        v: [...r.pose.v],
        w: [0, 0, 0],
        hp: r.pose.hp,
        nb: 0,
        lap: 1,
        t: last?.t ?? 0,
        fl: r.pose.fl,
        st: r.pose.st,
        rs: 0,
        am: 0,
        ht: 0,
      });
      this.trackJump(id, r.pose.rs, r.shown, r.pose.v, this.session.remoteSamples(id));
    }
    const steps = this.session.planSteps();
    for (let i = 0; i < steps; i++) {
      const tick = local.tick;
      const ctl = this.pilot.read(view, mine.race.controlsLocked);
      if (tick >= (this.session.snap?.tick ?? 0))
        this.send({ t: 'input', tick, vt: this.session.viewTick(nowSec), ...ctl });
      this.session.beforeStep();
      local.setInput(this.id, ctl);
      local.setTrafficTime(tick * STEP);
      local.step();
      this.session.afterStep(local.tick);
    }
  }

  private trackJump(
    id: string,
    rs: number,
    shown: [number, number, number],
    v: [number, number, number],
    samples: number,
  ): void {
    const prev = this.prevView.get(id);
    if (prev && prev.rs === rs && samples > 2) {
      const d = Math.hypot(shown[0] - prev.p[0], shown[2] - prev.p[2]);
      const excess = d - Math.hypot(v[0], v[2]) * STEP;
      if (excess > 1) this.jumps.push({ id, excessM: excess, atMs: this.o.net.now });
    }
    this.prevView.set(id, { p: [...shown], rs });
  }

  get localSim(): RaceSim | null {
    return this.local;
  }
}
