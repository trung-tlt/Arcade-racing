import {
  PROTOCOL_VERSION,
  encode,
  parseServerMessage,
  type ClientMsg,
  type JoinMode,
  type RejectReason,
  type RoomPhase,
  type ServerMsg,
  type SnapCar,
} from '../shared/protocol';
import type { CarControls } from '../vehicle/CarPhysics';

export interface NetClientEvents {
  onWelcome?(m: Extract<ServerMsg, { t: 'welcome' }>): void;
  onState?(m: Extract<ServerMsg, { t: 'state' }>): void;
  onSnapshot?(m: Extract<ServerMsg, { t: 'snap' }>): void;
  onReject?(reason: RejectReason, serverV?: number): void;
  onClose?(): void;
}

type WebSocketCtor = new (url: string) => WebSocket;

/**
 * Browser/Node WebSocket client for the race server (`WebSocket` is global in browsers and Node 22+). Phase 2: connects,
 * joins, streams inputs and exposes the latest snapshot and ping; prediction and interpolation come on top (Phase 3).
 */
export class NetClient {
  private ws: WebSocket | null = null;
  id = '';
  phase: RoomPhase = 'lobby';
  /** Latest snapshot from the server. */
  snap: Extract<ServerMsg, { t: 'snap' }> | null = null;
  private snapAt = 0;
  /** Diagnostics: input frames handed to `sendInput` and the newest tick among them. */
  sentFrames = 0;
  closeInfo = '';
  lastSentTick = -1;
  /** Round-trip time in ms (smoothed). */
  pingMs = 0;
  /** server clock minus client clock, ms. */
  clockOffsetMs = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    readonly events: NetClientEvents = {},
    private readonly Ctor: WebSocketCtor = WebSocket as unknown as WebSocketCtor,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new this.Ctor(this.url);
      this.ws = ws;
      ws.onopen = () => {
        const ping = (): void =>
          this.send({ t: 'ping', c: performance.now(), ...(this.pingMs > 0 ? { rtt: Math.round(this.pingMs) } : {}) });
        this.pingTimer = setInterval(ping, 2000);
        resolve();
      };
      ws.onerror = () => reject(new Error('connection failed'));
      ws.onclose = (e) => {
        this.closeInfo = `${e.code} ${e.reason}`;
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.events.onClose?.();
      };
      ws.onmessage = (e) => {
        const m = parseServerMessage(String(e.data));
        if (m) this.onMessage(m);
      };
    });
  }

  join(name: string, car: string, room: string, hash: string, track?: string, laps?: number, mode?: JoinMode): void {
    this.send({ t: 'join', v: PROTOCOL_VERSION, hash, name, car, room, track, laps, ...(mode ? { mode } : {}) });
  }

  /** Lobby: pick another vehicle. */
  car(car: string): void {
    this.send({ t: 'car', car });
  }

  /** Host only: change the track and/or laps (this un-readies everyone). */
  settings(track?: string, laps?: number): void {
    this.send({ t: 'settings', track, laps });
  }

  /** Results screen: `true` votes for a rematch, `false` asks for the lobby. */
  rematch(vote: boolean): void {
    this.send({ t: 'rematch', vote });
  }

  /** Leave the room (the server drops the seat; the socket is closed by the caller). */
  leave(): void {
    this.send({ t: 'leave' });
  }

  ready(ready: boolean): void {
    this.send({ t: 'ready', ready });
  }

  start(): void {
    this.send({ t: 'start' });
  }

  reset(): void {
    this.send({ t: 'reset' });
  }

  /** Send one control frame for server tick `tick` (see `InputFrame`). */
  sendInput(tick: number, c: CarControls, vt?: number): void {
    this.sentFrames++;
    this.lastSentTick = tick;
    this.send({ t: 'input', tick, ...c, ...(vt === undefined ? {} : { vt: Math.round(vt * 100) / 100 }) });
  }

  /** The server's sim tick right now, estimated from the newest snapshot and how long ago it arrived. */
  serverTickNow(): number {
    return this.snap ? this.snap.tick + Math.round(((performance.now() - this.snapAt) / 1000) * 60) : 0;
  }

  /** This client's car in the latest snapshot. */
  me(): SnapCar | undefined {
    return this.snap?.cars.find((c) => c.id === this.id);
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(encode(m));
  }

  private onMessage(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome':
        this.id = m.id;
        this.clockOffsetMs = m.ms - Date.now();
        this.events.onWelcome?.(m);
        break;
      case 'state':
        this.phase = m.phase;
        this.events.onState?.(m);
        break;
      case 'snap':
        this.snap = m;
        this.snapAt = performance.now();
        this.phase = m.phase;
        this.events.onSnapshot?.(m);
        break;
      case 'pong': {
        const rtt = performance.now() - m.c;
        this.pingMs = this.pingMs === 0 ? rtt : this.pingMs * 0.8 + rtt * 0.2;
        break;
      }
      case 'reject':
        this.events.onReject?.(m.reason, m.v);
        break;
    }
  }
}
