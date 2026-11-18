import type { EventBus } from '../core/Events';
import { LapTracker } from './Laps';
import { crossed } from './Positions';

export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface RaceConfig {
  carId: string;
  totalLaps: number;
  /** Along-track t of each checkpoint, in order. */
  checkpointTs: readonly number[];
  countdownSteps: number;
  countdownStepSec: number;
  goHoldSec: number;
}

/** Pure race state machine for one car: countdown → racing → finished. No rendering or physics. */
export class RaceManager {
  readonly laps: LapTracker;
  phase: RacePhase = 'countdown';
  /** Race clock in seconds; 0 until GO. */
  timeSec = 0;
  private countdownElapsed = 0;
  private sinceGo = 0;
  private lastT = 0;

  constructor(
    private readonly cfg: RaceConfig,
    private readonly events: EventBus,
  ) {
    this.laps = new LapTracker(cfg.checkpointTs.length, cfg.totalLaps);
  }

  restart(startT: number): void {
    this.phase = 'countdown';
    this.timeSec = 0;
    this.countdownElapsed = 0;
    this.sinceGo = 0;
    this.lastT = startT;
    this.laps.start(0);
  }

  /** Along-track position at the last update. */
  get progressT(): number {
    return this.lastT;
  }

  /** Race time at which the car finished, or null. */
  get finishTimeSec(): number | null {
    return this.laps.totalTimeSec;
  }

  /** t of the next gate the car must pass (a checkpoint, else the start/finish line at 0). */
  get nextGateT(): number {
    return this.laps.nextCheckpoint < this.cfg.checkpointTs.length
      ? this.cfg.checkpointTs[this.laps.nextCheckpoint]
      : 0;
  }

  /** 3, 2, 1 while counting down; 0 from GO until the banner expires; null afterwards. */
  get countdownValue(): number | null {
    if (this.phase === 'countdown') {
      const step = Math.floor(this.countdownElapsed / this.cfg.countdownStepSec);
      return Math.max(1, this.cfg.countdownSteps - step);
    }
    return this.phase === 'racing' && this.sinceGo < this.cfg.goHoldSec ? 0 : null;
  }

  /** Cars may drive once the lights go out. */
  get controlsLocked(): boolean {
    return this.phase === 'countdown';
  }

  /** Checkpoint to respawn at: the last valid one, or the start line (t = 0). */
  get respawnT(): number {
    const i = this.laps.lastCheckpoint;
    return i >= 0 ? this.cfg.checkpointTs[i] : 0;
  }

  update(dt: number, carT: number): void {
    if (this.phase === 'countdown') {
      this.countdownElapsed += dt;
      if (this.countdownElapsed >= this.cfg.countdownSteps * this.cfg.countdownStepSec) {
        this.phase = 'racing';
        this.sinceGo = 0;
      }
      this.lastT = carT;
      return;
    }
    if (this.phase === 'finished') return;

    this.timeSec += dt;
    this.sinceGo += dt;
    const { carId, checkpointTs } = this.cfg;
    for (let i = 0; i < checkpointTs.length; i++) {
      if (crossed(this.lastT, carT, checkpointTs[i]) && this.laps.passCheckpoint(i) === 'ok') {
        this.events.emit('checkpoint', { carId, index: i });
      }
    }
    if (crossed(this.lastT, carT, 0)) {
      const r = this.laps.crossStartLine(this.timeSec);
      if (r !== 'ignored') {
        this.events.emit('lapComplete', {
          carId,
          lap: this.laps.lapTimes.length,
          timeSec: this.laps.lapTimes[this.laps.lapTimes.length - 1],
        });
      }
      if (r === 'finish') {
        this.phase = 'finished';
        this.events.emit('raceFinished', {
          carId,
          totalTimeSec: this.laps.totalTimeSec ?? this.timeSec,
          bestLapSec: this.laps.bestLap,
        });
      }
    }
    this.lastT = carT;
  }
}
