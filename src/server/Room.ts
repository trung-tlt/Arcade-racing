import { AI, CARS, TRACKS } from '../core/Data';
import { IDLE_CONTROLS } from '../vehicle/CarPhysics';
import {
  FLAG_AIRBORNE,
  FLAG_FINISHED,
  FLAG_INVULNERABLE,
  FLAG_WRECKED,
  PROTOCOL_VERSION,
  SIM_HZ,
  SNAPSHOT_EVERY_TICKS,
  encode,
  round,
  type ClientMsg,
  type RejectReason,
  type ResultRow,
  type RoomPhase,
  type RosterEntry,
  type ServerMsg,
  type SnapCar,
} from '../shared/protocol';
import { RaceSim, type SlotSpec } from '../sim/RaceSim';

/** One connected client, as the room sees it. `send` takes an already-encoded message. */
export interface Conn {
  send(text: string): void;
  close(): void;
}

export interface RoomOptions {
  code: string;
  trackId: string;
  laps: number;
  /** Data hash a joining client must match. */
  hash: string;
  maxPlayers?: number;
  /** Bots fill empty grid slots up to this many cars (default 6). */
  gridSize?: number;
  /** Monotonic milliseconds (injectable for tests). */
  now?: () => number;
  /** Seconds after the first human finishes before the race is closed for the rest (default 30). */
  finishGraceSec?: number;
  /** Input messages allowed per second per player (default 90, burst 30). */
  inputRatePerSec?: number;
}

export interface Player {
  readonly id: string;
  readonly conn: Conn;
  name: string;
  car: string;
  ready: boolean;
  host: boolean;
  connected: boolean;
  lastSeq: number;
  tokens: number;
  tokenStamp: number;
  dropped: number;
}

const MAX_DROPPED_INPUTS = 600;

/**
 * One online race room: lobby -> countdown -> racing -> results. The server owns everything; clients only send inputs.
 * `tick()` advances the sim by one 60 Hz step and sends snapshots every `SNAPSHOT_EVERY_TICKS`.
 */
export class Room {
  readonly code: string;
  readonly trackId: string;
  readonly laps: number;
  phase: RoomPhase = 'lobby';
  readonly players = new Map<string, Player>();
  sim: RaceSim | null = null;
  results: ResultRow[] | null = null;
  private nextId = 1;
  private readonly hash: string;
  private readonly maxPlayers: number;
  private readonly gridSize: number;
  private readonly now: () => number;
  private readonly finishGraceSec: number;
  private readonly inputRate: number;
  private firstFinishAt: number | null = null;
  private readonly slotOf = new Map<string, SlotSpec>();
  private readonly names = new Map<string, string>();

  constructor(o: RoomOptions) {
    this.code = o.code;
    this.trackId = o.trackId;
    this.laps = o.laps;
    this.hash = o.hash;
    this.gridSize = o.gridSize ?? 6;
    this.maxPlayers = Math.min(o.maxPlayers ?? 6, this.gridSize);
    this.now = o.now ?? (() => performance.now());
    this.finishGraceSec = o.finishGraceSec ?? 30;
    this.inputRate = o.inputRatePerSec ?? 90;
  }

  get humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  /** Validate a join and seat the player, or say why not. */
  join(conn: Conn, msg: Extract<ClientMsg, { t: 'join' }>): Player | RejectReason {
    if (msg.v !== PROTOCOL_VERSION) return 'version';
    if (msg.hash !== this.hash) return 'data';
    if (this.phase !== 'lobby') return 'race_started';
    if (this.players.size >= this.maxPlayers) return 'full';
    if (!CARS.some((c) => c.id === msg.car)) return 'unknown_car';
    const player: Player = {
      id: `p${this.nextId++}`,
      conn,
      name: msg.name,
      car: msg.car,
      ready: false,
      host: this.players.size === 0,
      connected: true,
      lastSeq: -1,
      tokens: 30,
      tokenStamp: this.now(),
      dropped: 0,
    };
    this.players.set(player.id, player);
    this.send(player, {
      t: 'welcome',
      id: player.id,
      room: this.code,
      tick: this.sim?.tick ?? 0,
      ms: Date.now(),
      track: this.trackId,
      laps: this.laps,
      hz: SIM_HZ,
    });
    this.broadcastState();
    return player;
  }

  leave(player: Player): void {
    if (!this.players.has(player.id)) return;
    player.connected = false;
    if (this.phase === 'lobby') {
      this.players.delete(player.id);
      if (player.host) {
        const next = [...this.players.values()][0];
        if (next) next.host = true;
      }
      this.broadcastState();
    } else {
      // Mid-race: the car coasts (handing it to the AI comes with prediction in Phase 3).
      this.sim?.setInput(player.id, { ...IDLE_CONTROLS });
    }
  }

  /** Handle one validated message from a seated player. Returns a reject reason for a protocol abuse (caller closes). */
  handle(player: Player, msg: ClientMsg): RejectReason | null {
    switch (msg.t) {
      case 'input':
        return this.onInput(player, msg);
      case 'ready':
        if (this.phase === 'lobby') {
          player.ready = msg.ready;
          this.broadcastState();
        }
        return null;
      case 'start':
        if (this.phase === 'lobby' && player.host) this.startRace();
        return null;
      case 'reset':
        this.sim?.requestReset(player.id);
        return null;
      case 'ping':
        this.send(player, { t: 'pong', c: msg.c, s: Date.now() });
        return null;
      case 'leave':
        this.leave(player);
        return null;
      case 'join':
        return 'bad_message'; // already seated
    }
  }

  private onInput(player: Player, msg: Extract<ClientMsg, { t: 'input' }>): RejectReason | null {
    const t = this.now();
    player.tokens = Math.min(30, player.tokens + ((t - player.tokenStamp) / 1000) * this.inputRate);
    player.tokenStamp = t;
    if (player.tokens < 1) {
      player.dropped++;
      return player.dropped > MAX_DROPPED_INPUTS ? 'rate' : null;
    }
    player.tokens -= 1;
    if (msg.seq <= player.lastSeq) return null; // duplicate or reordered
    player.lastSeq = msg.seq;
    this.sim?.setInput(player.id, {
      throttle: msg.throttle,
      brake: msg.brake,
      steer: msg.steer,
      drift: msg.drift,
      nitro: msg.nitro,
      fire: msg.fire,
      fireSecondary: msg.fireSecondary,
    });
    return null;
  }

  /** Host starts the race: humans take the first grid slots, bots fill the rest. */
  startRace(): void {
    if (this.phase !== 'lobby' || this.players.size === 0) return;
    const slots: SlotSpec[] = [];
    const taken = new Set<number>();
    // As in the single-player game the humans start at the back of the grid (player 1 last), bots fill the front.
    let i = 0;
    for (const p of this.players.values()) {
      const gridSlot = this.gridSize - 1 - i++;
      taken.add(gridSlot);
      const spec: SlotSpec = { id: p.id, carId: p.car, kind: 'human', gridSlot };
      slots.push(spec);
      this.slotOf.set(p.id, spec);
      this.names.set(p.id, p.name);
    }
    const free = Array.from({ length: this.gridSize }, (_, k) => k).filter((k) => !taken.has(k));
    free.forEach((gridSlot, k) => {
      const r = AI.rivals[k % AI.rivals.length];
      const id = `b${k + 1}`;
      slots.push({ id, carId: r.car, kind: 'ai', skill: r.skill, laneOffsetM: r.laneOffsetM, gridSlot });
      this.names.set(id, r.name);
    });
    this.sim = new RaceSim({ trackId: this.trackId, laps: this.laps, slots });
    this.phase = 'countdown';
    this.broadcastState();
  }

  /** One fixed 60 Hz step. */
  tick(): void {
    const sim = this.sim;
    if (!sim || this.phase === 'results') return;
    sim.step();
    const ref = sim.entries.find((e) => e.kind === 'human');
    if (this.phase === 'countdown' && ref && ref.race.phase !== 'countdown') {
      this.phase = 'racing';
      this.broadcastState();
    }
    if (sim.tick % SNAPSHOT_EVERY_TICKS === 0) this.sendSnapshots(sim);
    this.checkFinish(sim);
  }

  private checkFinish(sim: RaceSim): void {
    const humans = sim.entries.filter((e) => e.kind === 'human');
    const done = humans.filter((e) => e.race.phase === 'finished').length;
    if (done > 0 && this.firstFinishAt === null) this.firstFinishAt = sim.time;
    const allDone = done === humans.length;
    const timedOut = this.firstFinishAt !== null && sim.time - this.firstFinishAt > this.finishGraceSec;
    const nobodyLeft = this.humanCount === 0;
    if (allDone || timedOut || nobodyLeft) this.finish(sim);
  }

  private finish(sim: RaceSim): void {
    const order = sim.ranking();
    this.results = order.map((id, i) => {
      const e = sim.entry(id);
      return {
        id,
        name: this.names.get(id) ?? id,
        place: i + 1,
        timeSec: e?.race.finishTimeSec ?? null,
        bestLapSec: e ? (e.race.laps.lapTimes.length > 0 ? Math.min(...e.race.laps.lapTimes) : null) : null,
        bot: this.slotOf.get(id)?.kind !== 'human',
      };
    });
    this.phase = 'results';
    this.broadcastState();
    sim.dispose();
  }

  roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const p of this.players.values()) {
      out.push({ id: p.id, name: p.name, car: p.car, ready: p.ready, bot: false, host: p.host });
    }
    return out;
  }

  private broadcastState(): void {
    const msg: ServerMsg = {
      t: 'state',
      phase: this.phase,
      track: this.trackId,
      laps: this.laps,
      roster: this.roster(),
      ...(this.results ? { results: this.results } : {}),
    };
    const text = encode(msg);
    for (const p of this.players.values()) if (p.connected) p.conn.send(text);
  }

  private send(p: Player, msg: ServerMsg): void {
    if (p.connected) p.conn.send(encode(msg));
  }

  private sendSnapshots(sim: RaceSim): void {
    const cars: SnapCar[] = sim.entries.map((e) => {
      const ph = e.car.physics;
      const body = ph.body;
      const v = body.linvel();
      const w = body.angvel();
      const { p, q } = ph.curr;
      const view = sim.views.find((x) => x.id === e.id);
      return {
        id: e.id,
        p: [round(p.x, 2), round(p.y, 2), round(p.z, 2)],
        q: [round(q.x, 4), round(q.y, 4), round(q.z, 4), round(q.w, 4)],
        v: [round(v.x, 2), round(v.y, 2), round(v.z, 2)],
        w: [round(w.x, 3), round(w.y, 3), round(w.z, 3)],
        hp: Math.round(e.car.hull.hp),
        nb: round(ph.nitro.bars, 2),
        lap: view?.lap ?? 1,
        t: round(e.t, 4),
        fl:
          (e.car.hull.wrecked ? FLAG_WRECKED : 0) |
          (ph.airborne ? FLAG_AIRBORNE : 0) |
          (e.car.hull.invulnerable ? FLAG_INVULNERABLE : 0) |
          (e.race.phase === 'finished' ? FLAG_FINISHED : 0),
      };
    });
    const carsJson = JSON.stringify(cars);
    const head = `{"t":"snap","tick":${sim.tick},"time":${round(sim.time, 3)},"phase":"${this.phase}"`;
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      p.conn.send(`${head},"ack":${p.lastSeq},"cars":${carsJson}}`);
    }
  }

  /** Free the sim (room closing). */
  dispose(): void {
    if (this.sim && this.phase !== 'results') this.sim.dispose();
    this.sim = null;
    for (const p of this.players.values()) p.connected = false;
    this.players.clear();
  }
}

export const TRACK_IDS: readonly string[] = TRACKS.map((t) => t.id);
