import { dataHash } from '../shared/dataHash';
import {
  PROTOCOL_VERSION,
  type GridEntry,
  type JoinMode,
  type RejectReason,
  type RematchState,
  type RematchVote,
  type ResultRow,
  type RoomPhase,
  type RosterEntry,
  type ServerMsg,
} from '../shared/protocol';
import { NetClient } from './NetClient';

/** What the online hub shows in place of a pop-up (`err.*` strings in data/online_ui.json). */
export type HubError = 'full' | 'started' | 'version' | 'down' | 'notfound' | 'empty';

export interface HubFailure {
  err: HubError;
  /** The server's protocol version, when it said (for "this room runs vX and you have vY"). */
  serverV?: number;
}

/** Everything the lobby and results screens draw. */
export interface RoomView {
  code: string;
  /** Quick match may send people here. */
  open: boolean;
  phase: RoomPhase;
  track: string;
  laps: number;
  /** Bots fill the grid (host's choice). */
  bots: boolean;
  roster: RosterEntry[];
  selfId: string;
  isHost: boolean;
  hostName: string;
  results: ResultRow[] | null;
  rematch: RematchState | null;
  /** `performance.now()` at which the rematch timer reaches zero. */
  rematchEndsAt: number;
}

export interface LobbyEvents {
  onView?(v: RoomView): void;
  /** The server announced the grid: build the race. */
  onGrid?(grid: GridEntry[], track: string, laps: number): void;
  onSnapshot?(m: Extract<ServerMsg, { t: 'snap' }>): void;
  /** The connection dropped after the room was entered. */
  onClosed?(): void;
}

export interface EnterOptions {
  name: string;
  car: string;
  /** Room code for `join`; ignored by the other modes. */
  room?: string;
  track?: string;
  laps?: number;
}

const CONNECT_TIMEOUT_MS = 6000;

/** Server reject reasons as the hub words them. */
export function hubErrorOf(reason: RejectReason): HubError {
  switch (reason) {
    case 'version':
    case 'data':
      return 'version';
    case 'not_found':
      return 'notfound';
    case 'no_rooms':
      return 'empty';
    case 'race_started':
      return 'started';
    default:
      return 'full';
  }
}

/** A seat in a room on the race server, as the online screens see it: no DOM, no three.js. */
export class LobbyClient {
  view: RoomView | null = null;
  private gridAnnounced = false;

  private constructor(
    readonly client: NetClient,
    private readonly events: LobbyEvents,
  ) {}

  /** Connect and take a seat (`create`, `join` with a code, or `quick`), or say why not. */
  static async enter(
    url: string,
    mode: JoinMode,
    opts: EnterOptions,
    events: LobbyEvents = {},
  ): Promise<{ lobby: LobbyClient } | HubFailure> {
    const client = new NetClient(url);
    const lobby = new LobbyClient(client, events);
    return new Promise((resolve) => {
      let settled = false;
      let entered = false;
      const done = (r: { lobby: LobbyClient } | HubFailure): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!('lobby' in r)) client.close();
        resolve(r);
      };
      const timer = setTimeout(() => done({ err: 'down' }), CONNECT_TIMEOUT_MS);
      client.events.onReject = (reason, v) => done({ err: hubErrorOf(reason), serverV: v });
      client.events.onWelcome = (m) => {
        client.id = m.id;
      };
      client.events.onState = (m) => {
        lobby.onState(m);
        entered = true;
        done({ lobby });
      };
      client.events.onSnapshot = (m) => events.onSnapshot?.(m);
      client.events.onClose = () => {
        // Closing after a reject is the server hanging up on a refused join, not a lost connection.
        if (!settled) done({ err: 'down' });
        else if (entered) events.onClosed?.();
      };
      client.connect().then(
        () => client.join(opts.name, opts.car, opts.room ?? '', dataHash(), opts.track, opts.laps, mode),
        () => done({ err: 'down' }),
      );
    });
  }

  private onState(m: Extract<ServerMsg, { t: 'state' }>): void {
    const self = this.client.id;
    const host = m.roster.find((r) => r.host);
    this.view = {
      code: m.code,
      open: m.open,
      phase: m.phase,
      track: m.track,
      laps: m.laps,
      bots: m.bots === true,
      roster: m.roster,
      selfId: self,
      isHost: !!host && host.id === self,
      hostName: host?.name ?? '',
      results: m.results ?? null,
      rematch: m.rematch ?? null,
      rematchEndsAt: m.rematch ? performance.now() + m.rematch.secLeft * 1000 : 0,
    };
    this.events.onView?.(this.view);
    // The grid is announced once per race (a rematch goes results -> lobby -> loading, so it re-arms).
    if (m.phase === 'loading' && m.grid) {
      if (!this.gridAnnounced) {
        this.gridAnnounced = true;
        this.client.snap = null; // a rematch must not start from the last race's final snapshot
        this.events.onGrid?.(m.grid, m.track, m.laps);
      }
    } else if (m.phase !== 'loading') {
      this.gridAnnounced = false;
    }
  }

  ready(v: boolean): void {
    this.client.ready(v);
  }
  start(): void {
    this.client.start();
  }
  car(id: string): void {
    this.client.car(id);
  }
  settings(track?: string, laps?: number, bots?: boolean): void {
    this.client.settings(track, laps, bots);
  }
  rematch(vote: RematchVote): void {
    this.client.rematch(vote);
  }
  restart(): void {
    this.client.restart();
  }

  /** Leave the room and close the socket. */
  leave(): void {
    this.client.leave();
    this.client.close();
  }
}

export const protocolVersionLabel = (v: number | undefined): string => `v${v ?? PROTOCOL_VERSION}`;
