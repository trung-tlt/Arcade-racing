import { type RaceEntry, rankEntries } from './Positions';

/** What the standings need to know about one car; filled from its RaceManager. */
export interface CarRaceView {
  id: string;
  lap: number;
  t: number;
  /** t of the next gate to pass. */
  nextGateT: number;
  /** Checkpoints passed so far this lap. */
  checkpointsPassed: number;
  finished: boolean;
  finishTimeSec: number | null;
}

/**
 * Cars staged behind the start line have t ≈ 0.99 while still on lap 1, which would put them ahead of the cars that
 * are past the line. Until a car has passed its first checkpoint, treat t > 0.5 on lap 1 as negative.
 */
export function effectiveT(v: Pick<CarRaceView, 'lap' | 't' | 'checkpointsPassed'>): number {
  return v.lap === 1 && v.checkpointsPassed === 0 && v.t > 0.5 ? v.t - 1 : v.t;
}

/** Fraction of a lap from t to the next gate, going forward. */
export function distToGate(t: number, gateT: number): number {
  return (((gateT - t) % 1) + 1) % 1;
}

export function toEntry(v: CarRaceView): RaceEntry {
  const t = effectiveT(v);
  return {
    id: v.id,
    lap: v.lap,
    t,
    distToNext: distToGate(v.t, v.nextGateT),
    finished: v.finished,
    finishTime: v.finishTimeSec ?? undefined,
  };
}

/** Ids best-first. */
export function rankCars(views: readonly CarRaceView[]): string[] {
  return rankEntries(views.map(toEntry));
}

/** Rubber-band input: +1 when far behind the reference car, -1 when far ahead; `scaleLaps` = full-effect gap. */
export function rubberBandSignal(selfProgress: number, refProgress: number, scaleLaps: number): number {
  return Math.max(-1, Math.min(1, (refProgress - selfProgress) / scaleLaps));
}
