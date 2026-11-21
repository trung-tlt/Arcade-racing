/**
 * Maps the local clock to the server's simulation clock from snapshot timestamps. Every snapshot says "the sim time was
 * T when I left"; the one that arrived with the least delay has the largest `T - localArrival`, so the maximum over a
 * sliding window estimates the offset at minimum latency. Jitter on top of that is absorbed by the interpolation delay.
 */
/** An offset error beyond this is replaced outright instead of slewed. */
const BIG_ERROR_SEC = 0.05;

export class ClockSync {
  private readonly samples: number[] = [];
  private offset = Number.NaN;

  constructor(private readonly windowSize = 60) {}

  /** `serverTimeSec`: the snapshot's sim time; `localNowSec`: local clock when it arrived. */
  onSnapshot(serverTimeSec: number, localNowSec: number): void {
    this.samples.push(serverTimeSec - localNowSec);
    if (this.samples.length > this.windowSize) this.samples.shift();
    let best = -Infinity;
    for (const s of this.samples) if (s > best) best = s;
    // Small corrections are slewed (1 ms per snapshot) so the render clock never visibly jumps; a big error (the first
    // samples were processed in a late burst, say) is simply wrong and is replaced at once.
    const err = best - this.offset;
    this.offset =
      Number.isNaN(this.offset) || Math.abs(err) > BIG_ERROR_SEC
        ? best
        : this.offset + Math.max(-0.001, Math.min(0.001, err));
  }

  get ready(): boolean {
    return !Number.isNaN(this.offset);
  }

  /** Estimated server sim time (seconds) at local time `localNowSec`, as of the fastest snapshots. */
  serverTime(localNowSec: number): number {
    return localNowSec + this.offset;
  }
}
