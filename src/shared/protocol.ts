import type { CarControls } from '../vehicle/CarPhysics';

/** Bump on any breaking change to the messages below; the server rejects a mismatched client. */
export const PROTOCOL_VERSION = 1;

/** Simulation rate (Hz) and how many sim ticks pass between snapshots. */
export const SIM_HZ = 60;
export const SNAPSHOT_EVERY_TICKS = 3; // 20 Hz

export const MAX_MESSAGE_CHARS = 600;
export const MAX_NAME_CHARS = 16;
export const MAX_ROOM_CODE_CHARS = 8;
/** Room codes shown to players (`data/online_ui.json` roomCode): 6 characters, no O/0 or I/1. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
/** The rematch vote on the results screen runs this long before everyone goes back to the lobby. */
export const REMATCH_SECONDS = 30;

/** `VX7M4Q` as shown to players: `VX7·M4Q`. */
export const formatRoomCode = (code: string): string =>
  code.length === ROOM_CODE_LENGTH ? `${code.slice(0, 3)}·${code.slice(3)}` : code;

/** Upper-case a typed code and drop anything outside the room-code alphabet (the hub's input filter). */
export function cleanRoomCode(raw: string): string {
  return raw
    .toUpperCase()
    .split('')
    .filter((c) => ROOM_CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, ROOM_CODE_LENGTH);
}

/** `loading`: the grid is announced and clients are building the race; the countdown starts when all have said ready. */
export type RoomPhase = 'lobby' | 'loading' | 'countdown' | 'racing' | 'results';

export interface RosterEntry {
  id: string;
  name: string;
  car: string;
  ready: boolean;
  /** Bots fill empty slots. */
  bot: boolean;
  host: boolean;
  /** Round-trip time in ms as the player last reported it (-1 = not measured yet). */
  ping: number;
}

/** How a `join` picks its room: `create` opens a private one, `join` needs an existing code, `quick` takes the next open public room (or opens one). Without a mode the room is joined or created by the given name (dev/tests). */
export type JoinMode = 'create' | 'join' | 'quick';

/**
 * One control frame (60 Hz). `tick` is the server sim tick the frame is for: the client runs a few ticks ahead of the
 * server and the server applies the frame for tick N during its Nth step (or repeats the previous frame if it is missing).
 */
/** A car's body state (client-authority mode): the client says where its own car is at the start of the frame's tick. */
export interface PoseFrame {
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  w: [number, number, number];
}

export interface InputFrame extends CarControls {
  tick: number;
  /** Client-authority mode: the sender's own car state before this tick, and the reset count it has adopted (`SnapCar.rs`). */
  ps?: PoseFrame;
  rs?: number;
  /**
   * The server time, in ticks, of the remote cars as this client was drawing them when it made the frame. The server
   * rewinds other cars to that moment when it resolves this frame's hitscan (lag compensation), within a cap.
   */
  vt?: number;
}

/** What a client saw over the last few seconds (sent with the ping, logged by the server to read a lag report against). */
export interface ClientStats {
  /** Seconds the window covers. */
  sec: number;
  /** Frames drawn, and frames over 50 ms. */
  frames: number;
  hitches: number;
  /** Own-car corrections: over 0.5 m, hard snaps, the largest (m), and how many of the over-0.5 m ones had a car within 9 m. */
  over50: number;
  snaps: number;
  maxErrM: number;
  nearOver50: number;
  /** Frames the lead controller held or caught up. */
  holds: number;
  catchUps: number;
  /** Adaptive interpolation delay (ms). */
  interpMs: number;
  /** Times the predicted own car sat deep under the road surface for half a second. */
  deep: number;
}

export type ClientMsg =
  | {
      t: 'join';
      v: number;
      hash: string;
      name: string;
      car: string;
      room: string;
      track?: string;
      laps?: number;
      mode?: JoinMode;
    }
  | { t: 'ready'; ready: boolean }
  | { t: 'car'; car: string }
  | { t: 'settings'; track?: string; laps?: number; bots?: boolean }
  | { t: 'start' }
  /** Host only, mid-race: abandon this race and load the same one again with everyone ready. */
  | { t: 'restart' }
  /** Results screen: vote for a rematch ('yes'), ask to go back to the lobby ('lobby'), or withdraw the vote ('none'). */
  | { t: 'rematch'; vote: RematchVote }
  | ({ t: 'input' } & InputFrame)
  | { t: 'reset' }
  | { t: 'ping'; c: number; rtt?: number; cs?: ClientStats }
  | { t: 'leave' };

/** Car flag bits in a snapshot. */
export const FLAG_WRECKED = 1;
export const FLAG_AIRBORNE = 2;
export const FLAG_INVULNERABLE = 4;
export const FLAG_FINISHED = 8;
export const FLAG_BRAKING = 16;
export const FLAG_NITRO = 32;
export const FLAG_DRIFTING = 64;
export const FLAG_GUN_LOCKED = 128;

export interface SnapCar {
  id: string;
  /** Position (m), rotation (quaternion x,y,z,w), linear and angular velocity. */
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  w: [number, number, number];
  hp: number;
  /** Nitro bars (fractional). */
  nb: number;
  lap: number;
  /** Along-track position, 0..1. */
  t: number;
  fl: number;
  /** Front-wheel steer angle (rad), for the wheel visuals of remote cars. */
  st: number;
  /** Rockets in the rack and the Pulse MG's heat (0..1): the HUD of your own car reads these. */
  am: number;
  ht: number;
  /** Respawn counter: when it changes the car was teleported (wreck respawn, reset), so clients must not interpolate across it. */
  rs: number;
}

export interface GridEntry {
  id: string;
  name: string;
  car: string;
  bot: boolean;
  slot: number;
}

export interface ResultRow {
  id: string;
  name: string;
  place: number;
  /** Race time in seconds; null = did not finish. */
  timeSec: number | null;
  bestLapSec: number | null;
  bot: boolean;
  car: string;
  /** Cars this one wrecked. */
  takedowns: number;
  /** The lap a human was on when they left the race (null = stayed). */
  leftLap: number | null;
}

/** A rocket in flight. */
export interface SnapRocket {
  /** Pool slot: stable for the life of the rocket. */
  i: number;
  owner: string;
  p: [number, number, number];
  /** Unit heading. */
  d: [number, number, number];
}

/** Discrete things that happened since the last snapshot (delivered in order with it). */
export type NetEvent =
  | { k: 'gun'; c: string; f: [number, number, number]; to: [number, number, number]; h: 0 | 1 }
  | { k: 'heat'; c: string }
  | { k: 'rkt'; c: string; p: [number, number, number] }
  | { k: 'boom'; p: [number, number, number]; r: number }
  | { k: 'hit'; c: string; by: string | null; d: number }
  | { k: 'wreck'; c: string; by: string | null }
  | { k: 'pick'; c: string; kind: 'rocket' | 'repair' | 'nitro'; p: [number, number, number] }
  | { k: 'nitro'; c: string; src: 'drift' | 'pickup' | 'takedown' | 'hit' };

export type RejectReason =
  | 'version'
  | 'data'
  | 'full'
  | 'bad_message'
  | 'race_started'
  | 'rate'
  | 'unknown_car'
  /** `join` with a code no room has. */
  | 'not_found'
  /** The server cannot open another room (quick match found nothing and the room cap is reached). */
  | 'no_rooms';

/** What a client can say on the results screen. */
export type RematchVote = 'yes' | 'lobby' | 'none';
const REMATCH_VOTES: readonly unknown[] = ['yes', 'lobby', 'none'];

/** The rematch vote while the results are up. */
export interface RematchState {
  /** Player ids that voted yes / that asked to go back to the lobby. */
  yes: string[];
  no: string[];
  /** Seconds left when this message was sent. */
  secLeft: number;
}

export type ServerMsg =
  | { t: 'welcome'; id: string; room: string; tick: number; ms: number; track: string; laps: number; hz: number }
  /** `v` is the server's protocol version, so a client can say "this room runs v2 and you have v1". */
  | { t: 'reject'; reason: RejectReason; v?: number }
  | {
      t: 'state';
      phase: RoomPhase;
      track: string;
      laps: number;
      /** Whether bots fill the grid (the host's choice; off by default). */
      bots?: boolean;
      roster: RosterEntry[];
      grid?: GridEntry[];
      results?: ResultRow[];
      rematch?: RematchState;
      /** The room's code and whether quick match may send people to it. */
      code: string;
      open: boolean;
    }
  | {
      t: 'snap';
      /** Server sim ticks completed: the state is the result of applying input frames up to tick - 1. */
      tick: number;
      /** Newest input frame tick the server has received from you, and how many of your frames arrived too late to use. */
      ack: number;
      late: number;
      time: number;
      phase: RoomPhase;
      cars: SnapCar[];
      /** Rockets in flight, pickups currently taken (by id), events since the last snapshot. */
      rk: SnapRocket[];
      pk: number[];
      ev: NetEvent[];
    }
  | { t: 'pong'; c: number; s: number };

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; reason: 'bad_message' };

const bad: { ok: false; reason: 'bad_message' } = { ok: false, reason: 'bad_message' };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Largest input frame tick the parser accepts (~9 days at 60 Hz); anything bigger is garbage or an attack. */
export const MAX_INPUT_TICK = 2 ** 31 - 1;

/** Invisible or direction-changing code points: zero-width, bidi marks/overrides/isolates, BOM, soft hyphen, C1, line/paragraph separators. */
const HIDDEN_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0e\ufeff\uffa0\ufff9-\ufffb]/g;
const MARKUP_CHARS = /[<>&"'`\\]/g;
const MAX_MARKS_IN_A_ROW = 3;

/** Display name: no controls, bidi/zero-width tricks, markup characters or lone surrogates; capped by code points. */
export function sanitizeName(raw: string, max: number, fallback: string): string {
  const flat = raw.normalize('NFC').replace(HIDDEN_CHARS, '').replace(MARKUP_CHARS, '').replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  let marks = 0;
  for (const ch of flat) {
    const c = ch.codePointAt(0) as number;
    if (c >= 0xd800 && c <= 0xdfff) continue; // lone surrogate (iterating by code point keeps pairs whole)
    marks = /\p{M}/u.test(ch) ? marks + 1 : 0;
    if (marks > MAX_MARKS_IN_A_ROW) continue;
    out.push(ch);
    if (out.length >= max) break;
  }
  const name = out.join('').trim();
  return name.length > 0 ? name : fallback;
}

/**
 * Parse and validate one client message. Nothing the client sends is trusted: unknown shapes are rejected, numbers are
 * clamped to their legal range, strings are length-capped and sanitised.
 */
export function parseClientMessage(raw: string): ParseResult<ClientMsg> {
  if (raw.length > MAX_MESSAGE_CHARS) return bad;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return bad;
  }
  if (typeof j !== 'object' || j === null) return bad;
  const m = j as Record<string, unknown>;
  switch (m.t) {
    case 'input': {
      const { tick, throttle, brake, steer } = m;
      if (!isNum(tick) || !Number.isInteger(tick) || tick < 0 || tick > MAX_INPUT_TICK) return bad;
      if (!isNum(throttle) || !isNum(brake) || !isNum(steer)) return bad;
      const vt = m.vt === undefined ? undefined : isNum(m.vt) ? clamp(m.vt, 0, 1e9) : null;
      if (vt === null) return bad;
      const ps = m.ps === undefined ? undefined : parsePose(m.ps);
      if (ps === null) return bad;
      const rs = m.rs === undefined ? undefined : isNum(m.rs) ? clamp(Math.trunc(m.rs), 0, 1e6) : null;
      if (rs === null) return bad;
      return {
        ok: true,
        msg: {
          t: 'input',
          tick,
          vt,
          ...(ps ? { ps, rs: rs ?? 0 } : {}),
          throttle: clamp(throttle, 0, 1),
          brake: clamp(brake, 0, 1),
          steer: clamp(steer, -1, 1),
          drift: m.drift === true,
          nitro: m.nitro === true,
          fire: m.fire === true,
          fireSecondary: m.fireSecondary === true,
        },
      };
    }
    case 'join': {
      if (!isNum(m.v) || typeof m.hash !== 'string' || typeof m.name !== 'string') return bad;
      if (typeof m.car !== 'string') return bad;
      if (m.hash.length > 16 || m.car.length > 32) return bad;
      if (m.mode !== undefined && m.mode !== 'create' && m.mode !== 'join' && m.mode !== 'quick') return bad;
      const mode = m.mode as JoinMode | undefined;
      // `create` and `quick` name no room; the other forms must.
      if (typeof m.room !== 'string' && (mode === undefined || mode === 'join')) return bad;
      const rawRoom = typeof m.room === 'string' ? m.room : '';
      const room =
        mode === 'create' || mode === 'quick'
          ? ''
          : mode === 'join'
            ? cleanRoomCode(rawRoom)
            : rawRoom
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, MAX_ROOM_CODE_CHARS);
      if (room.length === 0 && mode === undefined) return bad;
      const laps = m.laps === undefined ? undefined : isNum(m.laps) ? clamp(Math.round(m.laps), 1, 9) : null;
      if (laps === null) return bad;
      if (m.track !== undefined && (typeof m.track !== 'string' || m.track.length > 32)) return bad;
      return {
        ok: true,
        msg: {
          t: 'join',
          v: m.v,
          hash: m.hash,
          name: sanitizeName(m.name, MAX_NAME_CHARS, 'Player'),
          car: m.car,
          room,
          track: m.track as string | undefined,
          laps,
          ...(mode ? { mode } : {}),
        },
      };
    }
    case 'ready':
      return typeof m.ready === 'boolean' ? { ok: true, msg: { t: 'ready', ready: m.ready } } : bad;
    case 'settings': {
      if (m.track !== undefined && (typeof m.track !== 'string' || m.track.length > 32)) return bad;
      const laps = m.laps === undefined ? undefined : isNum(m.laps) ? clamp(Math.round(m.laps), 1, 9) : null;
      if (laps === null) return bad;
      if (m.bots !== undefined && typeof m.bots !== 'boolean') return bad;
      return {
        ok: true,
        msg: {
          t: 'settings',
          track: m.track as string | undefined,
          laps,
          ...(m.bots === undefined ? {} : { bots: m.bots }),
        },
      };
    }
    case 'car':
      return typeof m.car === 'string' && m.car.length <= 32 ? { ok: true, msg: { t: 'car', car: m.car } } : bad;
    case 'rematch':
      return REMATCH_VOTES.includes(m.vote) ? { ok: true, msg: { t: 'rematch', vote: m.vote as RematchVote } } : bad;
    case 'start':
    case 'restart':
    case 'reset':
    case 'leave':
      return { ok: true, msg: { t: m.t } };
    case 'ping':
      if (!isNum(m.c)) return bad;
      if (m.rtt !== undefined && !isNum(m.rtt)) return bad;
      return {
        ok: true,
        msg: {
          t: 'ping',
          c: m.c,
          ...(m.rtt === undefined ? {} : { rtt: clamp(m.rtt, 0, 5000) }),
          ...(m.cs === undefined ? {} : parseClientStats(m.cs)),
        },
      };
    default:
      return bad;
  }
}

/** Round to `dp` decimal places (snapshots stay small: 1 cm positions, 4 dp rotations). */
export const round = (v: number, dp: number): number => {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
};

const POSE_LIMIT_M = 20000;

/** Four finite vectors of the right sizes, clamped to sane ranges; anything else is rejected. */
function parsePose(raw: unknown): PoseFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const vec = (v: unknown, n: number, lim: number): number[] | null =>
    Array.isArray(v) && v.length === n && v.every(isNum) ? v.map((x: number) => clamp(x, -lim, lim)) : null;
  const p = vec(r.p, 3, POSE_LIMIT_M);
  const q = vec(r.q, 4, 1);
  const v = vec(r.v, 3, 400);
  const w = vec(r.w, 3, 100);
  if (!p || !q || !v || !w) return null;
  return { p, q, v, w } as PoseFrame;
}

const STAT_KEYS: readonly (keyof ClientStats)[] = [
  'sec',
  'frames',
  'hitches',
  'over50',
  'snaps',
  'maxErrM',
  'nearOver50',
  'holds',
  'catchUps',
  'interpMs',
  'deep',
];

/** A stats block with every field a finite number, clamped; anything else is dropped (the ping still counts). */
function parseClientStats(raw: unknown): { cs?: ClientStats } {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const cs = {} as Record<string, number>;
  for (const k of STAT_KEYS) {
    if (!isNum(r[k])) return {};
    cs[k] = clamp(r[k] as number, 0, 1e6);
  }
  return { cs: cs as unknown as ClientStats };
}

export const encode = (msg: ServerMsg | ClientMsg): string => JSON.stringify(msg);

/** Client side: parse a server message (trusted peer, but a mismatched build must not crash the client). */
export function parseServerMessage(raw: string): ServerMsg | null {
  try {
    const j = JSON.parse(raw) as { t?: unknown };
    return typeof j === 'object' && j !== null && typeof j.t === 'string' ? (j as ServerMsg) : null;
  } catch {
    return null;
  }
}
