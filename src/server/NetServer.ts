import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { TRACKS } from '../core/Data';
import { dataHash } from '../shared/dataHash';
import { MAX_MESSAGE_CHARS, SIM_HZ, encode, parseClientMessage, type RejectReason } from '../shared/protocol';
import { initSim } from '../sim/RaceSim';
import { Room, type Player } from './Room';

export interface NetServerOptions {
  port: number;
  host?: string;
  maxRooms?: number;
  maxConnectionsPerIp?: number;
  /** Close a connection that sends nothing for this long (ms). */
  idleTimeoutMs?: number;
  /** A new connection must send `join` within this long (ms). */
  joinTimeoutMs?: number;
  defaultTrack?: string;
  defaultLaps?: number;
  log?: (line: string) => void;
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
  private readonly tickMs: number[] = [];
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
      idleTimeoutMs: 30_000,
      joinTimeoutMs: 5_000,
      defaultTrack: TRACKS[0].id,
      defaultLaps: 3,
      log: () => undefined,
      ...o,
    };
    this.http = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.health()));
        return;
      }
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ server: this.http, maxPayload: MAX_MESSAGE_CHARS * 2 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? 'unknown'));
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

  health(): { rooms: number; players: number; tickMsP99: number; tickMsMean: number; hz: number } {
    const xs = [...this.tickMs].sort((a, b) => a - b);
    const mean = xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    let players = 0;
    for (const r of this.rooms.values()) players += r.humanCount;
    return {
      rooms: this.rooms.size,
      players,
      tickMsP99: xs.length > 0 ? xs[Math.floor(xs.length * 0.99)] : 0,
      tickMsMean: mean,
      hz: SIM_HZ,
    };
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
      for (const room of this.rooms.values()) room.tick();
      this.tickMs.push(performance.now() - t0);
      if (this.tickMs.length > 3600) this.tickMs.shift();
    }
    if (this.acc > step * 5) this.acc = 0;
    this.reapRooms();
  }

  private reapRooms(): void {
    for (const [code, room] of this.rooms) {
      if (room.humanCount === 0) {
        room.dispose();
        this.rooms.delete(code);
        this.opts.log(`room ${code} closed`);
      }
    }
  }

  private reject(ws: WebSocket, reason: RejectReason): void {
    ws.send(encode({ t: 'reject', reason }));
    ws.close(1008, reason);
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const n = this.perIp.get(ip) ?? 0;
    if (n >= this.opts.maxConnectionsPerIp) {
      ws.close(1013, 'too many connections');
      return;
    }
    this.perIp.set(ip, n + 1);
    const session: Session = {
      ws,
      ip,
      room: null,
      player: null,
      lastMsgAt: Date.now(),
      joinTimer: setTimeout(() => ws.close(1008, 'join timeout'), this.opts.joinTimeoutMs),
    };
    this.sessions.add(session);
    const idle = setInterval(() => {
      if (Date.now() - session.lastMsgAt > this.opts.idleTimeoutMs) ws.close(1008, 'idle');
    }, 5_000);

    ws.on('message', (data, isBinary) => {
      session.lastMsgAt = Date.now();
      if (isBinary) return this.reject(ws, 'bad_message');
      this.onMessage(session, data.toString());
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
      let room = this.rooms.get(msg.room);
      if (!room) {
        if (this.rooms.size >= this.opts.maxRooms) return this.reject(s.ws, 'full');
        const track = TRACKS.some((t) => t.id === msg.track) ? (msg.track as string) : this.opts.defaultTrack;
        room = new Room({
          code: msg.room,
          trackId: track,
          laps: msg.laps ?? this.opts.defaultLaps,
          hash: this.hash,
        });
        this.rooms.set(msg.room, room);
        this.opts.log(`room ${msg.room} opened (${track})`);
      }
      const conn = {
        send: (text: string): void => {
          if (s.ws.readyState === s.ws.OPEN) s.ws.send(text);
        },
        close: (): void => s.ws.close(),
      };
      const seated = room.join(conn, msg);
      if (typeof seated === 'string') return this.reject(s.ws, seated);
      clearTimeout(s.joinTimer);
      s.room = room;
      s.player = seated;
      return;
    }
    const abuse = s.room?.handle(s.player, msg) ?? null;
    if (abuse) this.reject(s.ws, abuse);
  }
}
