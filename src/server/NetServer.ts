import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { TRACKS } from '../core/Data';
import { dataHash } from '../shared/dataHash';
import { randomInt } from 'node:crypto';
import {
  MAX_MESSAGE_CHARS,
  PROTOCOL_VERSION,
  REMATCH_SECONDS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SIM_HZ,
  encode,
  parseClientMessage,
  type ClientMsg,
  type RejectReason,
} from '../shared/protocol';
import { initSim } from '../sim/RaceSim';
import { WindowLimiter, clientIp, guardedSend } from './limits';
import { Room, type Player } from './Room';
import { SampleWindow, levelEnabled, logLine, promText, type LogLevel, type PromSample } from './metrics';

export interface NetServerOptions {
  port: number;
  host?: string;
  maxRooms?: number;
  maxConnectionsPerIp?: number;
  /** Open connections across all IPs (default 200). */
  maxConnections?: number;
  /** Rooms one IP may have open at once (default 4) and may open per minute (default 20). */
  maxRoomsPerIp?: number;
  maxRoomCreatesPerMin?: number;
  /** Failed code joins one IP may make per minute before further joins are refused (room-code brute force; default 10). */
  maxFailedJoinsPerMin?: number;
  /** A client whose unsent buffer passes this many bytes is dropped (it is not reading; default 1 MiB). */
  maxBufferedBytes?: number;
  /** Trusted reverse-proxy hops in front of us (0 = none: X-Forwarded-For is ignored; Caddy = 1). */
  trustProxy?: number;
  /** Accept a `join` without a mode (join-or-create by name). Dev and tests only: set false in production. */
  legacyJoin?: boolean;
  /** Close a connection that sends nothing for this long (ms). */
  idleTimeoutMs?: number;
  /** A new connection must send `join` within this long (ms). */
  joinTimeoutMs?: number;
  defaultTrack?: string;
  defaultLaps?: number;
  /** Let the host start a race alone and without everyone being ready (dev and tests; the lobby rule is 2+ ready). */
  soloStart?: boolean;
  /** Seconds the rematch vote runs on the results screen (default 30). */
  rematchSec?: number;
  /** Receives one JSON line per event at or above `logLevel`. */
  log?: (line: string) => void;
  logLevel?: LogLevel;
}

interface Session {
  ws: WebSocket;
  ip: string;
  room: Room | null;
  player: Player | null;
  lastMsgAt: number;
  joinTimer: NodeJS.Timeout;
}

/** WebSocket front end: connection limits, validation, rooms and the fixed 60 Hz loop. */
export class NetServer {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Room>();
  private readonly sessions = new Set<Session>();
  private readonly perIp = new Map<string, number>();
  private readonly roomOwner = new Map<Room, string>();
  private readonly createLimiter: WindowLimiter;
  private readonly failedJoins: WindowLimiter;
  /** Wall time of each 60 Hz step over the last minute, and the other counters behind /health and /metrics. */
  private readonly tickMs = new SampleWindow(3600);
  private readonly startedAt = performance.now();
  private readonly rejects = new Map<string, number>();
  private readonly roomMeta = new Map<Room, { phase: string; raceStartedAt: number }>();
  private tickMax = 0;
  private overruns = 0;
  private stalls = 0;
  private roomsOpened = 0;
  private racesRun = 0;
  private connectionsTotal = 0;
  private bytesOut = 0;
  private snapsOut = 0;
  /** Per-second samples of the two counters above (last 10 s) for the rates. */
  private readonly rateBytes = new Float64Array(10).fill(-1);
  private readonly rateSnaps = new Float64Array(10).fill(-1);
  private rateAt = performance.now();
  private rateIdx = 0;
  private rateBytesBase = 0;
  private rateSnapsBase = 0;
  private loop: NodeJS.Timeout | null = null;
  private readonly hash = dataHash();
  private readonly opts: Required<Omit<NetServerOptions, 'log'>> & { log: (line: string) => void };
  private lastTime = 0;
  private acc = 0;

  constructor(o: NetServerOptions) {
    this.opts = {
      host: '0.0.0.0',
      maxRooms: 20,
      maxConnectionsPerIp: 8,
      maxConnections: 200,
      maxRoomsPerIp: 4,
      maxRoomCreatesPerMin: 20,
      maxFailedJoinsPerMin: 10,
      maxBufferedBytes: 1024 * 1024,
      trustProxy: 0,
      legacyJoin: true,
      idleTimeoutMs: 30_000,
      joinTimeoutMs: 5_000,
      defaultTrack: TRACKS[0].id,
      defaultLaps: 3,
      soloStart: false,
      rematchSec: REMATCH_SECONDS,
      logLevel: 'info',
      log: () => undefined,
      ...o,
    };
    this.createLimiter = new WindowLimiter(this.opts.maxRoomCreatesPerMin, 60_000);
    this.failedJoins = new WindowLimiter(this.opts.maxFailedJoinsPerMin, 60_000);
    this.http = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.health()));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(this.metricsText());
        return;
      }
      res.writeHead(404).end();
    });
    // Slow-loris: a handshake that dribbles in is cut off; sockets that never finish upgrading are capped too.
    this.http.headersTimeout = 10_000;
    this.http.requestTimeout = 10_000;
    this.http.keepAliveTimeout = 5_000;
    this.http.maxConnections = this.opts.maxConnections * 2 + 16;
    this.wss = new WebSocketServer({ server: this.http, maxPayload: MAX_MESSAGE_CHARS * 2 });
    this.wss.on('connection', (ws, req) => {
      const xff = req.headers['x-forwarded-for'];
      this.onConnection(
        ws,
        clientIp(req.socket.remoteAddress ?? 'unknown', Array.isArray(xff) ? xff[0] : xff, this.opts.trustProxy),
      );
    });
  }

  async listen(): Promise<number> {
    await initSim();
    await new Promise<void>((resolve) => this.http.listen(this.opts.port, this.opts.host, resolve));
    this.lastTime = performance.now();
    this.loop = setInterval(() => this.pump(), 2);
    const addr = this.http.address();
    return typeof addr === 'object' && addr ? addr.port : this.opts.port;
  }

  async close(): Promise<void> {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    for (const s of this.sessions) {
      clearTimeout(s.joinTimer);
      s.ws.terminate();
    }
    for (const r of this.rooms.values()) r.dispose();
    this.rooms.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  health(): {
    rooms: number;
    maxRooms: number;
    players: number;
    tickMsP50: number;
    tickMsP99: number;
    tickMsMax: number;
    tickMsMean: number;
    hz: number;
    uptimeSec: number;
    snapshotBytesPerSec: number;
    snapshotsPerSec: number;
    rssMb: number;
    cpuSec: number;
  } {
    const t = this.tickMs.stats([0.5, 0.99]);
    let players = 0;
    for (const r of this.rooms.values()) players += r.humanCount;
    const cpu = process.cpuUsage();
    return {
      rooms: this.rooms.size,
      maxRooms: this.opts.maxRooms,
      players,
      tickMsP50: t.q[0],
      tickMsP99: t.q[1],
      tickMsMax: t.max,
      tickMsMean: t.mean,
      hz: SIM_HZ,
      uptimeSec: (performance.now() - this.startedAt) / 1000,
      snapshotBytesPerSec: this.rate(this.rateBytes),
      snapshotsPerSec: this.rate(this.rateSnaps),
      rssMb: process.memoryUsage.rss() / 1048576,
      cpuSec: (cpu.user + cpu.system) / 1e6,
    };
  }

  /** Prometheus text for `/metrics`. */
  metricsText(): string {
    const h = this.health();
    const byPhase = new Map<string, number>();
    let late = 0;
    let dropped = 0;
    for (const r of this.rooms.values()) {
      byPhase.set(r.phase, (byPhase.get(r.phase) ?? 0) + r.humanCount);
      for (const p of r.players.values()) {
        late += p.late;
        dropped += p.dropped;
      }
    }
    const g = (name: string, help: string, value: number, type: PromSample['type'] = 'gauge'): PromSample => ({
      name,
      help,
      type,
      values: [{ value }],
    });
    return promText([
      g('voltline_uptime_seconds', 'Seconds since the server started.', h.uptimeSec),
      g('voltline_rooms', 'Open rooms.', h.rooms),
      g('voltline_rooms_max', 'Room cap (MAX_ROOMS).', h.maxRooms),
      {
        name: 'voltline_players',
        help: 'Connected humans by room phase.',
        type: 'gauge',
        values: [...byPhase].map(([phase, value]) => ({ labels: { phase }, value })),
      },
      {
        name: 'voltline_tick_ms',
        help: 'Wall time of one 60 Hz step over all rooms, last 3600 steps.',
        type: 'gauge',
        values: [
          { labels: { stat: 'p50' }, value: h.tickMsP50 },
          { labels: { stat: 'p99' }, value: h.tickMsP99 },
          { labels: { stat: 'max' }, value: h.tickMsMax },
          { labels: { stat: 'mean' }, value: h.tickMsMean },
        ],
      },
      g('voltline_tick_ms_max_lifetime', 'Slowest 60 Hz step since start.', this.tickMax),
      g('voltline_tick_overruns_total', 'Steps that took longer than the 16.7 ms budget.', this.overruns, 'counter'),
      g(
        'voltline_tick_stalls_total',
        'Times the loop fell more than 5 steps behind and dropped time.',
        this.stalls,
        'counter',
      ),
      g(
        'voltline_snapshot_bytes_per_second',
        'Bytes sent per second to all clients (10 s mean).',
        h.snapshotBytesPerSec,
      ),
      g(
        'voltline_snapshots_per_second',
        'Snapshot messages sent per second, all clients (10 s mean).',
        h.snapshotsPerSec,
      ),
      g('voltline_sent_bytes_total', 'Bytes of text sent to clients.', this.bytesOut, 'counter'),
      g('voltline_connections_total', 'WebSocket connections accepted.', this.connectionsTotal, 'counter'),
      g('voltline_sessions', 'Open WebSocket connections.', this.sessions.size),
      g('voltline_rooms_opened_total', 'Rooms opened.', this.roomsOpened, 'counter'),
      g('voltline_races_total', 'Races that reached the results screen.', this.racesRun, 'counter'),
      {
        name: 'voltline_rejects_total',
        help: 'Refused joins and protocol abuse, by reason.',
        type: 'counter',
        values: [...this.rejects].map(([reason, value]) => ({ labels: { reason }, value })),
      },
      g('voltline_input_late_frames', 'Input frames that arrived after their tick (seated players).', late),
      g('voltline_input_rate_limited_frames', 'Input frames dropped by the rate limiter (seated players).', dropped),
      g('process_resident_memory_bytes', 'Resident memory.', h.rssMb * 1048576),
      g('process_cpu_seconds_total', 'User plus system CPU time.', h.cpuSec, 'counter'),
    ]);
  }

  private rate(ring: Float64Array): number {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < ring.length; i++) {
      if (ring[i] >= 0) {
        sum += ring[i];
        n++;
      }
    }
    return n > 0 ? sum / n : 0;
  }

  private lastServerSampleAt = 0;

  private logEvent(level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>): void {
    if (levelEnabled(this.opts.logLevel, level)) this.opts.log(logLine(level, event, fields));
  }

  /** Real time -> fixed 60 Hz steps with an accumulator; a stall catches up at most 5 steps (then drops the rest). */
  private pump(): void {
    const now = performance.now();
    this.acc += now - this.lastTime;
    this.lastTime = now;
    const step = 1000 / SIM_HZ;
    let n = 0;
    while (this.acc >= step && n < 5) {
      this.acc -= step;
      n++;
      const t0 = performance.now();
      for (const room of [...this.rooms.values()]) {
        try {
          room.tick();
        } catch (err) {
          this.dropRoom(room, `tick failed: ${String(err)}`);
        }
      }
      const ms = performance.now() - t0;
      this.tickMs.push(ms);
      if (ms > this.tickMax) this.tickMax = ms;
      if (ms > step) this.overruns++;
    }
    if (this.acc > step * 5) {
      this.acc = 0;
      this.stalls++;
    }
    this.watchRooms(now);
    this.serverSample(now);
    this.reapRooms();
  }

  /** A room threw: close it and its players, never the process. */
  private dropRoom(room: Room, why: string): void {
    this.opts.log(`room ${room.code} dropped (${why})`);
    for (const s of this.sessions) if (s.room === room) s.ws.terminate();
    room.dispose();
    this.rooms.delete(room.code);
    this.roomOwner.delete(room);
    this.roomMeta.delete(room);
  }

  /** Once per pump: phase changes (race start / end logs, counters) and the per-second send-rate samples. */
  private watchRooms(now: number): void {
    for (const [code, room] of this.rooms) {
      for (const n of room.drainNotes())
        this.logEvent('info', n.event, { room: code, track: room.trackId, ...n.fields });
      const meta = this.roomMeta.get(room);
      if (!meta || meta.phase === room.phase) continue;
      if (room.phase === 'racing') {
        meta.raceStartedAt = now;
        this.logEvent('info', 'race_start', {
          room: code,
          track: room.trackId,
          laps: room.laps,
          humans: room.humanCount,
        });
      } else if (room.phase === 'results' && meta.phase !== 'lobby') {
        this.racesRun++;
        const durationSec = meta.raceStartedAt > 0 ? (now - meta.raceStartedAt) / 1000 : 0;
        this.logEvent('info', 'race_end', {
          room: code,
          track: room.trackId,
          durationSec: +durationSec.toFixed(1),
          players: room.playerStats(),
        });
      }
      meta.phase = room.phase;
    }
    if (now - this.rateAt >= 1000) {
      const secs = (now - this.rateAt) / 1000;
      this.rateBytes[this.rateIdx] = (this.bytesOut - this.rateBytesBase) / secs;
      this.rateSnaps[this.rateIdx] = (this.snapsOut - this.rateSnapsBase) / secs;
      this.rateIdx = (this.rateIdx + 1) % this.rateBytes.length;
      this.rateBytesBase = this.bytesOut;
      this.rateSnapsBase = this.snapsOut;
      this.rateAt = now;
    }
  }

  /** Once a minute while any room is open: server load next to the room telemetry, for lining up with a lag report. */
  private serverSample(now: number): void {
    if (this.rooms.size === 0 || now - this.lastServerSampleAt < 60_000) return;
    this.lastServerSampleAt = now;
    const h = this.health();
    this.logEvent('info', 'server_sample', {
      rooms: h.rooms,
      players: h.players,
      tickMsP50: +h.tickMsP50.toFixed(2),
      tickMsP99: +h.tickMsP99.toFixed(2),
      tickMsMax: +h.tickMsMax.toFixed(2),
      rssMb: Math.round(h.rssMb),
      cpuSec: +h.cpuSec.toFixed(1),
      snapshotBytesPerSec: Math.round(h.snapshotBytesPerSec),
      overruns: this.overruns,
      stalls: this.stalls,
    });
  }

  private reapRooms(): void {
    for (const [code, room] of this.rooms) {
      if (room.humanCount === 0) {
        for (const n of room.drainNotes()) this.logEvent('info', n.event, { room: code, ...n.fields });
        room.dispose();
        this.rooms.delete(code);
        this.roomOwner.delete(room);
        this.roomMeta.delete(room);
        this.logEvent('info', 'room_closed', { room: code, rooms: this.rooms.size });
      }
    }
  }

  /** Which room a `join` lands in (opening one when the mode allows), or why not. */
  private pickRoom(msg: Extract<ClientMsg, { t: 'join' }>, ip: string): Room | RejectReason {
    if (msg.mode === 'join') return this.rooms.get(msg.room) ?? 'not_found';
    if (msg.mode === 'quick') {
      // The fullest open public room fills up first.
      let best: Room | null = null;
      for (const r of this.rooms.values()) if (r.open && (!best || r.players.size > best.players.size)) best = r;
      if (best) return best;
    } else if (msg.mode === undefined) {
      const existing = this.rooms.get(msg.room);
      if (existing) return existing;
    }
    if (this.rooms.size >= this.opts.maxRooms) return msg.mode === 'quick' ? 'no_rooms' : 'full';
    // One address cannot hold the room cap hostage, nor churn rooms open and shut.
    let owned = 0;
    for (const owner of this.roomOwner.values()) if (owner === ip) owned++;
    if (owned >= this.opts.maxRoomsPerIp || this.createLimiter.blocked(ip)) return 'rate';
    this.createLimiter.record(ip);
    const code = msg.mode === undefined ? msg.room : this.newCode();
    const track = TRACKS.some((t) => t.id === msg.track) ? (msg.track as string) : this.opts.defaultTrack;
    const room = new Room({
      code,
      trackId: track,
      laps: msg.laps ?? this.opts.defaultLaps,
      hash: this.hash,
      isPublic: msg.mode === 'quick',
      rematchSec: this.opts.rematchSec,
      ...(this.opts.soloStart ? { minPlayers: 1, needAllReady: false } : {}),
    });
    this.rooms.set(code, room);
    this.roomOwner.set(room, ip);
    this.roomMeta.set(room, { phase: room.phase, raceStartedAt: 0 });
    this.roomsOpened++;
    this.logEvent('info', 'room_created', { room: code, track, public: msg.mode === 'quick', rooms: this.rooms.size });
    return room;
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  private reject(ws: WebSocket, reason: RejectReason): void {
    this.rejects.set(reason, (this.rejects.get(reason) ?? 0) + 1);
    this.logEvent(reason === 'rate' ? 'warn' : 'debug', 'reject', { reason });
    ws.send(encode({ t: 'reject', reason, v: PROTOCOL_VERSION }));
    ws.close(1008, reason);
  }

  /** A refused join; a miss on a code join counts against the address's brute-force budget. */
  private rejectJoin(s: Session, mode: string | undefined, reason: RejectReason): void {
    if (mode === 'join' && reason !== 'version' && reason !== 'data') this.failedJoins.record(s.ip);
    this.reject(s.ws, reason);
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const n = this.perIp.get(ip) ?? 0;
    if (n >= this.opts.maxConnectionsPerIp || this.sessions.size >= this.opts.maxConnections) {
      this.rejects.set('ip_limit', (this.rejects.get('ip_limit') ?? 0) + 1);
      ws.close(1013, 'too many connections');
      return;
    }
    this.perIp.set(ip, n + 1);
    this.connectionsTotal++;
    const session: Session = {
      ws,
      ip,
      room: null,
      player: null,
      lastMsgAt: Date.now(),
      joinTimer: setTimeout(() => ws.terminate(), this.opts.joinTimeoutMs),
    };
    this.sessions.add(session);
    const idle = setInterval(() => {
      if (Date.now() - session.lastMsgAt > this.opts.idleTimeoutMs) ws.terminate(); // a half-open peer never answers a close frame
    }, 5_000);

    ws.on('message', (data, isBinary) => {
      session.lastMsgAt = Date.now();
      if (isBinary) return this.reject(ws, 'bad_message');
      try {
        this.onMessage(session, data.toString());
      } catch (err) {
        // A bug a message can trigger costs that player their connection, never the process or the other rooms.
        this.opts.log(`message handler failed: ${String(err)}`);
        ws.terminate();
      }
    });
    ws.on('close', () => {
      clearInterval(idle);
      clearTimeout(session.joinTimer);
      this.sessions.delete(session);
      this.perIp.set(ip, Math.max(0, (this.perIp.get(ip) ?? 1) - 1));
      if (session.room && session.player) session.room.leave(session.player);
    });
    ws.on('error', () => ws.terminate());
  }

  private onMessage(s: Session, raw: string): void {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return this.reject(s.ws, 'bad_message');
    const msg = parsed.msg;
    if (!s.player) {
      if (msg.t !== 'join') return this.reject(s.ws, 'bad_message');
      if (msg.mode === undefined && !this.opts.legacyJoin) return this.reject(s.ws, 'bad_message');
      // Codes are 32^6 ~ 1e9 and checked by an oracle (`not_found`): cap how often one address may miss.
      if (msg.mode === 'join' && this.failedJoins.blocked(s.ip)) return this.reject(s.ws, 'rate');
      const found = this.pickRoom(msg, s.ip);
      if (typeof found === 'string') return this.rejectJoin(s, msg.mode, found);
      const room = found;
      const conn = {
        send: (text: string): void => {
          if (s.ws.readyState !== s.ws.OPEN) return;
          this.bytesOut += text.length; // the wire is ASCII JSON, so characters are bytes
          if (text.startsWith('{"t":"snap"')) this.snapsOut++;
          guardedSend(s.ws, text, this.opts.maxBufferedBytes);
        },
        close: (): void => s.ws.close(),
      };
      const seated = room.join(conn, msg);
      if (typeof seated === 'string') return this.rejectJoin(s, msg.mode, seated);
      clearTimeout(s.joinTimer);
      s.room = room;
      s.player = seated;
      return;
    }
    const abuse = s.room?.handle(s.player, msg) ?? null;
    if (abuse) {
      this.logEvent('warn', 'abuse', { room: s.room?.code, player: s.player.id, msg: msg.t, reason: abuse });
      this.reject(s.ws, abuse);
    }
  }
}
