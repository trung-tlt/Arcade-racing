import online from '../../data/online_ui.json';
import type { RosterEntry } from '../shared/protocol';
import type { ResultsData } from './types';

/** Pure state for the two online in-race overlays (boards 50-55); the DOM lives in `onlineRaceOverlay.ts`. */
const LOADING = online.loading;
const FINISHED = online.finished;

export interface LoadingRow {
  id: string;
  name: string;
  isMe: boolean;
  state: 'loading' | 'ready' | 'slow';
}

export type LoadingFooter =
  | { kind: 'wait'; secLeft: number }
  | { kind: 'all' }
  /** The room starts without these players; the server lets them join as soon as they have loaded. */
  | { kind: 'anyway'; late: string[] }
  | { kind: 'youSlow'; secLeft: number };

export interface LoadingStatus {
  rows: LoadingRow[];
  me: LoadingRow['state'];
  footer: LoadingFooter;
  secLeft: number;
}

/** Who has built the race so far (`ready` means loaded while the room is loading), and what the footer says. */
export function loadingStatus(roster: RosterEntry[], selfId: string, elapsedSec: number): LoadingStatus {
  const humans = roster.filter((r) => !r.bot);
  const slow = elapsedSec >= LOADING.slowAfterSec;
  const rows: LoadingRow[] = humans.map((r) => ({
    id: r.id,
    name: r.name,
    isMe: r.id === selfId,
    state: r.ready ? 'ready' : slow ? 'slow' : 'loading',
  }));
  const secLeft = Math.max(0, Math.ceil(LOADING.timeoutSec - elapsedSec));
  const waiting = rows.filter((r) => r.state !== 'ready');
  const me = rows.find((r) => r.isMe)?.state ?? 'loading';
  let footer: LoadingFooter;
  if (waiting.length === 0) footer = { kind: 'all' };
  else if (elapsedSec >= LOADING.timeoutSec) footer = { kind: 'anyway', late: waiting.map((r) => r.name) };
  else if (me !== 'ready' && rows.every((r) => r.isMe || r.state === 'ready')) footer = { kind: 'youSlow', secLeft };
  else footer = { kind: 'wait', secLeft };
  return { rows, me, footer, secLeft };
}

export interface FinishedRow {
  name: string;
  isMe: boolean;
  /** Finishing time, or `LAP n` for a racer still on track. */
  text: string;
  done: boolean;
}

export interface FinishedStatus {
  /** `P2` and the finishing time of this player. */
  place: string;
  time: string;
  best: string;
  rows: FinishedRow[];
  racing: string[];
  /** Seconds until the server closes the race (counted from the first finisher seen), or null before anyone finished. */
  secLeft: number | null;
  closed: boolean;
}

const placeLabel = (n: number): string => `P${n}`;

/** The "finished, waiting" panel: finishing order, who is still racing and the 30 s grace countdown. */
export function finishedStatus(data: ResultsData, laps: number, sinceFirstSec: number | null): FinishedStatus {
  const me = data.rows.find((r) => r.isPlayer);
  const rows: FinishedRow[] = data.rows.map((r) => ({
    name: r.name,
    isMe: r.isPlayer,
    done: r.total !== 'RACING' && r.total !== 'DNF',
    text: r.total === 'RACING' ? `LAP ${Math.min(laps, r.lap ?? 1)}/${laps}` : r.total,
  }));
  const secLeft = sinceFirstSec === null ? null : Math.max(0, Math.ceil(FINISHED.closeAfterFirstSec - sinceFirstSec));
  return {
    place: placeLabel(me?.pos ?? data.position),
    time: me?.total ?? '',
    best: data.bestLap,
    rows,
    racing: rows.filter((r) => !r.done).map((r) => r.name),
    secLeft,
    closed: secLeft === 0,
  };
}

/** `mm:ss` for the countdown rings. */
export const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
