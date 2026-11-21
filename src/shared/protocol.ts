import type { CarControls } from '../vehicle/CarPhysics';

/** Bump on any breaking change to the messages below; the server rejects a mismatched client. */
export const PROTOCOL_VERSION = 1;

/** Simulation rate (Hz) and how many sim ticks pass between snapshots. */
export const SIM_HZ = 60;
export const SNAPSHOT_EVERY_TICKS = 3; // 20 Hz

export const MAX_MESSAGE_CHARS = 600;
export const MAX_NAME_CHARS = 16;
export const MAX_ROOM_CODE_CHARS = 8;

export type RoomPhase = 'lobby' | 'countdown' | 'racing' | 'results';

export interface RosterEntry {
  id: string;
  name: string;
  car: string;
  ready: boolean;
  /** Bots fill empty slots. */
  bot: boolean;
  host: boolean;
}

/** One control frame (60 Hz). `seq` increases by one per frame; the server acks the last one it applied. */
export interface InputFrame extends CarControls {
  seq: number;
}

export type ClientMsg =
  | { t: 'join'; v: number; hash: string; name: string; car: string; room: string; track?: string; laps?: number }
  | { t: 'ready'; ready: boolean }
  | { t: 'start' }
  | ({ t: 'input' } & InputFrame)
  | { t: 'reset' }
  | { t: 'ping'; c: number }
  | { t: 'leave' };

/** Car flag bits in a snapshot. */
export const FLAG_WRECKED = 1;
export const FLAG_AIRBORNE = 2;
export const FLAG_INVULNERABLE = 4;
export const FLAG_FINISHED = 8;

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
}

export interface ResultRow {
  id: string;
  name: string;
  place: number;
  /** Race time in seconds; null = did not finish. */
  timeSec: number | null;
  bestLapSec: number | null;
  bot: boolean;
}

export type RejectReason = 'version' | 'data' | 'full' | 'bad_message' | 'race_started' | 'rate' | 'unknown_car';

export type ServerMsg =
  | { t: 'welcome'; id: string; room: string; tick: number; ms: number; track: string; laps: number; hz: number }
  | { t: 'reject'; reason: RejectReason }
  | { t: 'state'; phase: RoomPhase; track: string; laps: number; roster: RosterEntry[]; results?: ResultRow[] }
  | { t: 'snap'; tick: number; ack: number; time: number; phase: RoomPhase; cars: SnapCar[] }
  | { t: 'pong'; c: number; s: number };

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; reason: 'bad_message' };

const bad: { ok: false; reason: 'bad_message' } = { ok: false, reason: 'bad_message' };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Printable ASCII/Latin text only, trimmed, at most `max` chars; empty -> the fallback. */
export function sanitizeName(raw: string, max: number, fallback: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : fallback;
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
      const { seq, throttle, brake, steer } = m;
      if (!isNum(seq) || !Number.isInteger(seq) || seq < 0) return bad;
      if (!isNum(throttle) || !isNum(brake) || !isNum(steer)) return bad;
      return {
        ok: true,
        msg: {
          t: 'input',
          seq,
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
      if (typeof m.car !== 'string' || typeof m.room !== 'string') return bad;
      if (m.hash.length > 16 || m.car.length > 32) return bad;
      const room = m.room
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, MAX_ROOM_CODE_CHARS);
      if (room.length === 0) return bad;
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
        },
      };
    }
    case 'ready':
      return typeof m.ready === 'boolean' ? { ok: true, msg: { t: 'ready', ready: m.ready } } : bad;
    case 'start':
    case 'reset':
    case 'leave':
      return { ok: true, msg: { t: m.t } };
    case 'ping':
      return isNum(m.c) ? { ok: true, msg: { t: 'ping', c: m.c } } : bad;
    default:
      return bad;
  }
}

/** Round to `dp` decimal places (snapshots stay small: 1 cm positions, 4 dp rotations). */
export const round = (v: number, dp: number): number => {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
};

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
