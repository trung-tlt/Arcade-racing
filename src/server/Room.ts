import { AI, CARS, TRACKS } from '../core/Data';
import {
  PROTOCOL_VERSION,
  REMATCH_SECONDS,
  SIM_HZ,
  SNAPSHOT_EVERY_TICKS,
  encode,
  round,
  type ClientMsg,
  type GridEntry,
  type NetEvent,
  type SnapRocket,
  type InputFrame,
  type RejectReason,
  type RematchState,
  type ResultRow,
  type RoomPhase,
  type RosterEntry,
  type ServerMsg,
  type SnapCar,
} from '../shared/protocol';
import type { CombatFx } from '../sim/CombatSim';
import { RaceSim, type SlotSpec } from '../sim/RaceSim';
import { snapOfEntry } from '../sim/snapshot';

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
  /** How long to wait for every client to finish loading before starting anyway (ms, default 20000). */
  loadTimeoutMs?: number;
  /** Input messages allowed per second per player (default 180, burst 120: 60 Hz plus catch-up). */
  inputRatePerSec?: number;
  /** Quick match may send people here (rooms opened by quick match; a "create room" room is private). */
  isPublic?: boolean;
  /** The host may start with at least this many humans (default 2; the lobby rule), and only once all are ready. */
  minPlayers?: number;
  needAllReady?: boolean;
  /** Seconds the rematch vote runs on the results screen (default 30). */
  rematchSec?: number;
}

export interface Player {
  readonly id: string;
  readonly conn: Conn;
  name: string;
  car: string;
  ready: boolean;
  /** Has finished building the race (sent `ready` during the loading phase). */
  loaded: boolean;
  host: boolean;
  connected: boolean;
  /** Round trip as the client last reported it (ms, -1 = not yet). */
  rtt: number;
  /** Results screen: 'yes' = wants a rematch, 'no' = asked for the lobby. */
  vote: 'yes' | 'no' | null;
  /** The lap the player was on when they left mid-race. */
  leftLap: number | null;
  /** Frames received for ticks not yet simulated, by tick. */
  frames: Map<number, InputFrame>;
  /** Newest frame tick received, frames that arrived after their tick, and ticks that reused the previous frame. */
  ackTick: number;
  late: number;
  repeats: number;
  tokens: number;
  tokenStamp: number;
  dropped: number;
  /** Budget for every message that is not an input frame (each of them can fan out to the whole room). */
  ctlTokens: number;
  ctlStamp: number;
  ctlDropped: number;
}

const MAX_DROPPED_INPUTS = 600;
/** Control messages (ready, car, settings, rematch, ping, start, reset): a human taps a few per second at most. */
const CONTROL_BURST = 30;
const CONTROL_PER_SEC = 10;
/** Control messages dropped for lack of budget before the player is disconnected as a flooder. */
const MAX_DROPPED_CONTROL = 200;
/** The lobby is re-sent this often (ticks) so the pings in it stay current. */
const LOBBY_REFRESH_TICKS = SIM_HZ * 2;
/** Token bucket for input frames: a short catch-up burst after a stall is legitimate, a sustained flood is not. */
const BURST_TOKENS = 120;
/** Frames for ticks further ahead than this are refused (a client cannot buffer the future without bound). */
const MAX_AHEAD_TICKS = 90;

/**
 * One online race room: lobby -> countdown -> racing -> results. The server owns everything; clients only send inputs.
 * `tick()` advances the sim by one 60 Hz step and sends snapshots every `SNAPSHOT_EVERY_TICKS`.
 */
export class Room {
  readonly code: string;
  trackId: string;
  laps: number;
  readonly isPublic: boolean;
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
  private readonly loadTimeoutMs: number;
  private readonly minPlayers: number;
  private readonly needAllReady: boolean;
  private readonly rematchSec: number;
  private resultsAt = 0;
  private lobbyTicks = 0;
  private readonly takedowns = new Map<string, number>();
  private loadStartedAt = 0;
  private grid: GridEntry[] = [];
  private firstFinishAt: number | null = null;
  private readonly slotOf = new Map<string, SlotSpec>();
  private readonly names = new Map<string, string>();
  private readonly resets = new Map<string, number>();
  /** Events since the last snapshot, sent with the next one. */
  private pending: NetEvent[] = [];

  constructor(o: RoomOptions) {
    this.code = o.code;
    this.trackId = o.trackId;
    this.laps = o.laps;
    this.hash = o.hash;
    this.gridSize = o.gridSize ?? 6;
    this.maxPlayers = Math.min(o.maxPlayers ?? 6, this.gridSize);
    this.now = o.now ?? (() => performance.now());
    this.finishGraceSec = o.finishGraceSec ?? 30;
    this.inputRate = o.inputRatePerSec ?? 180;
    this.loadTimeoutMs = o.loadTimeoutMs ?? 20_000;
    this.isPublic = o.isPublic ?? false;
    this.minPlayers = o.minPlayers ?? 2;
    this.needAllReady = o.needAllReady ?? true;
    this.rematchSec = o.rematchSec ?? REMATCH_SECONDS;
  }

  /** Quick match can send a newcomer here: waiting in the lobby with a free seat. */
  get open(): boolean {
    return this.isPublic && this.phase === 'lobby' && this.players.size < this.maxPlayers;
  }

  /** The host's START: enough humans, and every one of them ready. */
  canStart(): boolean {
    const humans = [...this.players.values()].filter((p) => p.connected);
    if (humans.length < this.minPlayers) return false;
    return !this.needAllReady || humans.every((p) => p.ready);
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
      loaded: false,
      host: this.players.size === 0,
      connected: true,
      rtt: -1,
      vote: null,
      leftLap: null,
      frames: new Map(),
      ackTick: -1,
      late: 0,
      repeats: 0,
      tokens: BURST_TOKENS,
      tokenStamp: this.now(),
      dropped: 0,
      ctlTokens: CONTROL_BURST,
      ctlStamp: this.now(),
      ctlDropped: 0,
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
      if (player.host) this.migrateHost();
      this.broadcastState();
    } else if (this.phase === 'results') {
      if (player.host) this.migrateHost();
      this.broadcastState();
      this.evalRematch();
    } else {
      // Mid-race: the car carries on under the AI (v1 rule; reconnect is v1.1).
      const i = this.sim?.entries.findIndex((e) => e.id === player.id) ?? -1;
      player.leftLap = i >= 0 && this.sim ? this.sim.views[i].lap : null;
      this.sim?.handToAI(player.id);
    }
  }

  /** The lowest-numbered connected player becomes host (the lobby rule). */
  private migrateHost(): void {
    for (const p of this.players.values()) if (!p.connected) p.host = false;
    const next = [...this.players.values()].find((p) => p.connected);
    if (next) next.host = true;
  }

  /** Handle one validated message from a seated player. Returns a reject reason for a protocol abuse (caller closes). */
  handle(player: Player, msg: ClientMsg): RejectReason | null {
    if (msg.t !== 'input' && msg.t !== 'leave') {
      const t = this.now();
      player.ctlTokens = Math.min(CONTROL_BURST, player.ctlTokens + ((t - player.ctlStamp) / 1000) * CONTROL_PER_SEC);
      player.ctlStamp = t;
      if (player.ctlTokens < 1) return ++player.ctlDropped > MAX_DROPPED_CONTROL ? 'rate' : null;
      player.ctlTokens -= 1;
    }
    switch (msg.t) {
      case 'input':
        return this.onInput(player, msg);
      case 'ready':
        if (this.phase === 'lobby') {
          player.ready = msg.ready;
          this.broadcastState();
        } else if (this.phase === 'loading') {
          player.loaded = msg.ready;
          this.broadcastState(); // the loading screens show who is still building the race
        }
        return null;
      case 'car':
        if (this.phase === 'lobby' && CARS.some((c) => c.id === msg.car)) {
          player.car = msg.car;
          this.broadcastState();
        }
        return null;
      case 'settings':
        if (this.phase === 'lobby' && player.host) {
          if (msg.track !== undefined && TRACKS.some((t) => t.id === msg.track)) this.trackId = msg.track;
          if (msg.laps !== undefined) this.laps = msg.laps;
          // Changing the race un-readies everyone: they agreed to a different one.
          for (const p of this.players.values()) p.ready = false;
          this.broadcastState();
        }
        return null;
      case 'start':
        if (this.phase === 'lobby' && player.host && this.canStart()) this.startRace();
        return null;
      case 'rematch':
        if (this.phase === 'results') {
          player.vote = msg.vote ? 'yes' : 'no';
          this.broadcastState();
          this.evalRematch();
        }
        return null;
      case 'reset':
        this.sim?.requestReset(player.id);
        return null;
      case 'ping':
        if (msg.rtt !== undefined) player.rtt = Math.round(msg.rtt);
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
    // The newest tick we have seen from this client (even if the frame is then dropped or late): the client steers its
    // lead from it, so it must never be held back by the rate limiter.
    // A tick far beyond the server's own is garbage: it must not stick as the ack (and it is refused below anyway).
    const ahead = (this.sim?.tick ?? 0) + MAX_AHEAD_TICKS;
    if (msg.tick > player.ackTick && msg.tick <= ahead) player.ackTick = msg.tick;
    const t = this.now();
    player.tokens = Math.min(BURST_TOKENS, player.tokens + ((t - player.tokenStamp) / 1000) * this.inputRate);
    player.tokenStamp = t;
    if (player.tokens < 1) {
      player.dropped++;
      return player.dropped > MAX_DROPPED_INPUTS ? 'rate' : null;
    }
    player.tokens -= 1;
    const now = this.sim?.tick ?? 0;
    if (msg.tick < now) {
      player.late++; // arrived after its tick was simulated
      return null;
    }
    if (msg.tick > now + MAX_AHEAD_TICKS) return null;
    if (player.frames.has(msg.tick)) return null; // duplicate
    player.frames.set(msg.tick, msg);
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
    this.sim = new RaceSim({ trackId: this.trackId, laps: this.laps, slots, fx: this.netFx() });
    const ev = this.sim.events;
    ev.on('carReset', (e) => this.resets.set(e.carId, (this.resets.get(e.carId) ?? 0) + 1));
    ev.on('gunOverheated', (e) => this.pending.push({ k: 'heat', c: e.carId }));
    ev.on('rocketLaunched', (e) => this.pending.push({ k: 'rkt', c: e.carId, p: v3(e.pos) }));
    ev.on('explosion', (e) => this.pending.push({ k: 'boom', p: v3(e.pos), r: e.radius }));
    ev.on('carHit', (e) => this.pending.push({ k: 'hit', c: e.carId, by: e.attackerId, d: Math.round(e.damage) }));
    ev.on('carWrecked', (e) => {
      this.pending.push({ k: 'wreck', c: e.carId, by: e.attackerId });
      if (e.attackerId && e.attackerId !== e.carId) {
        this.takedowns.set(e.attackerId, (this.takedowns.get(e.attackerId) ?? 0) + 1);
      }
    });
    ev.on('pickupTaken', (e) => this.pending.push({ k: 'pick', c: e.carId, kind: e.kind, p: v3(e.pos) }));
    ev.on('nitroBarEarned', (e) => this.pending.push({ k: 'nitro', c: e.carId, src: e.source }));
    this.grid = slots.map((sp) => ({
      id: sp.id,
      name: this.names.get(sp.id) ?? sp.id,
      car: sp.carId,
      bot: sp.kind !== 'human',
      slot: sp.gridSlot ?? 0,
    }));
    this.phase = 'loading';
    this.loadStartedAt = this.now();
    this.broadcastState();
  }

  /** One fixed 60 Hz step. */
  tick(): void {
    const sim = this.sim;
    if (this.phase === 'results') {
      if (this.now() - this.resultsAt > this.rematchSec * 1000) this.resetToLobby(false);
      return;
    }
    if (this.phase === 'lobby') {
      // Refresh the lobby every 2 s so the pings in the roster stay current.
      if (++this.lobbyTicks % LOBBY_REFRESH_TICKS === 0) this.broadcastState();
      return;
    }
    if (!sim) return;
    if (this.phase === 'loading') {
      // The sim waits (no ticks) until every human has built the race, or the timeout passes.
      const everyone = [...this.players.values()].every((p) => p.loaded || !p.connected);
      if (everyone || this.now() - this.loadStartedAt > this.loadTimeoutMs) {
        this.phase = 'countdown';
        this.broadcastState();
      }
      return;
    }
    this.consumeInputs(sim);
    sim.step();
    const ref = sim.entries.find((e) => e.kind === 'human');
    if (this.phase === 'countdown' && ref && ref.race.phase !== 'countdown') {
      this.phase = 'racing';
      this.broadcastState();
    }
    if (sim.tick % SNAPSHOT_EVERY_TICKS === 0) this.sendSnapshots(sim);
    this.checkFinish(sim);
  }

  /** The frame for this tick from each player; a missing one repeats the previous input (and is counted). */
  private consumeInputs(sim: RaceSim): void {
    const tick = sim.tick;
    for (const p of this.players.values()) {
      const frame = p.frames.get(tick);
      if (frame) {
        p.repeats = 0;
        sim.setInput(p.id, frame);
        sim.setViewTick(p.id, frame.vt);
      } else if (p.ackTick >= 0) {
        p.repeats++;
      }
      for (const k of p.frames.keys()) if (k <= tick) p.frames.delete(k);
    }
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
        car: this.grid.find((g) => g.id === id)?.car ?? '',
        takedowns: this.takedowns.get(id) ?? 0,
        leftLap: this.players.get(id)?.leftLap ?? null,
      };
    });
    this.phase = 'results';
    this.resultsAt = this.now();
    for (const p of this.players.values()) p.vote = null;
    this.broadcastState();
    sim.dispose();
  }

  roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const p of this.players.values()) {
      if (!p.connected) continue; // left mid-race or on the results screen: gone from the roster
      // While the race loads, `ready` means "has built the race" (the lobby's ready flags are all set by then).
      const ready = this.phase === 'loading' ? p.loaded : p.ready;
      out.push({ id: p.id, name: p.name, car: p.car, ready, bot: false, host: p.host, ping: p.rtt });
    }
    return out;
  }

  private rematchState(): RematchState {
    const ids = (v: 'yes' | 'no'): string[] =>
      [...this.players.values()].filter((p) => p.connected && p.vote === v).map((p) => p.id);
    const left = this.rematchSec - (this.now() - this.resultsAt) / 1000;
    return { yes: ids('yes'), no: ids('no'), secLeft: Math.max(0, Math.round(left)) };
  }

  /** Everyone still here voted yes: race again. Anyone asking for the lobby ends the vote: everybody goes back. */
  private evalRematch(): void {
    if (this.phase !== 'results') return;
    const here = [...this.players.values()].filter((p) => p.connected);
    if (here.length === 0) return;
    if (here.some((p) => p.vote === 'no')) this.resetToLobby(false);
    else if (here.every((p) => p.vote === 'yes')) this.resetToLobby(true);
  }

  /** Back to the lobby (or, for a rematch, straight into loading the same race with everyone ready). */
  private resetToLobby(rematch: boolean): void {
    this.sim = null;
    this.results = null;
    this.firstFinishAt = null;
    this.pending = [];
    this.resets.clear();
    this.slotOf.clear();
    this.names.clear();
    this.takedowns.clear();
    this.grid = [];
    for (const [id, p] of this.players) {
      if (!p.connected) {
        this.players.delete(id);
        continue;
      }
      p.ready = rematch;
      p.loaded = false;
      p.vote = null;
      p.leftLap = null;
      p.frames.clear();
      p.ackTick = -1;
      p.late = 0;
      p.repeats = 0;
    }
    this.phase = 'lobby';
    if (this.players.size > 0 && ![...this.players.values()].some((p) => p.host)) this.migrateHost();
    if (rematch && this.players.size > 0) this.startRace();
    else this.broadcastState();
  }

  private broadcastState(): void {
    const msg: ServerMsg = {
      t: 'state',
      phase: this.phase,
      track: this.trackId,
      laps: this.laps,
      roster: this.roster(),
      code: this.code,
      open: this.open,
      ...(this.phase === 'loading' ? { grid: this.grid } : {}),
      ...(this.results ? { results: this.results } : {}),
      ...(this.phase === 'results' ? { rematch: this.rematchState() } : {}),
    };
    const text = encode(msg);
    for (const p of this.players.values()) if (p.connected) p.conn.send(text);
  }

  private send(p: Player, msg: ServerMsg): void {
    if (p.connected) p.conn.send(encode(msg));
  }

  /** Combat visuals as events: only the tracer needs the server's help (its endpoint); the rest is derived by clients. */
  private netFx(): CombatFx {
    const none = (): void => undefined;
    return {
      tracer: (car, from, to, hit) =>
        this.pending.push({ k: 'gun', c: car.id, f: v3(from), to: v3(to), h: hit ? 1 : 0 }),
      muzzleFlash: none,
      sparks: none,
      explosion: none,
      carVisible: none,
      damageSmoke: none,
      show: none,
      pose: none,
      trail: none,
    };
  }

  private sendSnapshots(sim: RaceSim): void {
    const cars: SnapCar[] = sim.entries.map((e, i) => snapOfEntry(e, sim.views[i].lap, this.resets.get(e.id) ?? 0));
    const carsJson = JSON.stringify(cars);
    const rockets: SnapRocket[] = [];
    sim.combatSim?.forEachRocket((owner, pos, dir, slot) =>
      rockets.push({ i: slot, owner, p: v3(pos), d: [round(dir.x, 3), round(dir.y, 3), round(dir.z, 3)] }),
    );
    const taken = sim.combatSim?.takenPickups() ?? [];
    const events = this.pending;
    this.pending = [];
    const head = `{"t":"snap","tick":${sim.tick},"time":${round(sim.time, 3)},"phase":"${this.phase}"`;
    const rk = JSON.stringify(rockets);
    const pk = JSON.stringify(taken);
    const ev = JSON.stringify(events);
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      p.conn.send(`${head},"ack":${p.ackTick},"late":${p.late},"cars":${carsJson},"rk":${rk},"pk":${pk},"ev":${ev}}`);
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

/** A position rounded to 1 cm for the wire. */
function v3(p: { x: number; y: number; z: number }): [number, number, number] {
  return [round(p.x, 2), round(p.y, 2), round(p.z, 2)];
}

export const TRACK_IDS: readonly string[] = TRACKS.map((t) => t.id);
