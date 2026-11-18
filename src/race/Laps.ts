export type CheckpointResult = 'ok' | 'wrong-order' | 'ignored';

/** Pure lap/checkpoint bookkeeping for one car. A lap counts only if every checkpoint was passed in order. */
export class LapTracker {
  private next = 0;
  private last = -1;
  private currentLap = 1;
  private started = false;
  private lapStart = 0;
  private raceStart = 0;
  private done = false;
  private total: number | null = null;
  readonly lapTimes: number[] = [];

  constructor(
    private readonly checkpointCount: number,
    private readonly totalLaps: number,
  ) {}

  start(timeSec: number): void {
    this.started = true;
    this.raceStart = timeSec;
    this.lapStart = timeSec;
    this.next = 0;
    this.last = -1;
    this.currentLap = 1;
    this.done = false;
    this.total = null;
    this.lapTimes.length = 0;
  }

  passCheckpoint(index: number): CheckpointResult {
    if (!this.started || this.done || index < 0 || index >= this.checkpointCount) return 'ignored';
    if (index === this.next) {
      this.last = index;
      this.next++;
      return 'ok';
    }
    return index < this.next ? 'ignored' : 'wrong-order';
  }

  crossStartLine(timeSec: number): 'lap' | 'finish' | 'ignored' {
    if (!this.started || this.done || this.next < this.checkpointCount) return 'ignored';
    this.lapTimes.push(timeSec - this.lapStart);
    this.lapStart = timeSec;
    this.next = 0;
    this.last = -1;
    if (this.currentLap >= this.totalLaps) {
      this.done = true;
      this.total = timeSec - this.raceStart;
      return 'finish';
    }
    this.currentLap++;
    return 'lap';
  }

  /** 1-based current lap. */
  get lap(): number {
    return this.currentLap;
  }
  get nextCheckpoint(): number {
    return this.next;
  }
  get lastCheckpoint(): number {
    return this.last;
  }
  get finished(): boolean {
    return this.done;
  }
  get totalTimeSec(): number | null {
    return this.total;
  }
  get bestLap(): number | null {
    return this.lapTimes.length ? Math.min(...this.lapTimes) : null;
  }
}
