export interface RaceEntry {
  id: string;
  lap: number;
  /** Along-track position in [0,1) from the start line. */
  t: number;
  distToNext: number;
  finished?: boolean;
  finishTime?: number;
}

const TIE_EPS = 1e-6;
const MAX_JUMP = 0.25;

export function raceProgress(e: RaceEntry): number {
  return e.lap + e.t;
}

/** Ids best first: finished cars by finish time, then by progress, ties by distance to the next checkpoint. */
export function rankEntries(entries: readonly RaceEntry[]): string[] {
  return [...entries]
    .sort((a, b) => {
      if (a.finished && b.finished) return (a.finishTime ?? Infinity) - (b.finishTime ?? Infinity);
      if (a.finished) return -1;
      if (b.finished) return 1;
      const d = raceProgress(b) - raceProgress(a);
      if (Math.abs(d) > TIE_EPS) return d;
      return a.distToNext - b.distToNext;
    })
    .map((e) => e.id);
}

/** Shortest signed difference b − a on the closed [0,1) loop, in [-0.5, 0.5). */
export function wrapDelta(a: number, b: number): number {
  const d = b - a;
  return d - Math.floor(d + 0.5);
}

const wrap01 = (x: number): number => x - Math.floor(x);

/** True when a car moved forward over gateT between two samples (wrap-safe; rejects backwards and big jumps). */
export function crossed(prevT: number, currT: number, gateT: number): boolean {
  const step = wrapDelta(prevT, currT);
  if (step <= 0 || step > MAX_JUMP) return false;
  const toGate = wrap01(gateT - prevT);
  return toGate > 0 && toGate <= step;
}
