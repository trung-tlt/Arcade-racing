import type { RacePhase } from '../race/RaceManager';
import { formatTime } from './format';

export interface RaceHudState {
  phase: RacePhase;
  /** 3,2,1 → number; 0 → GO; null → hide. */
  countdown: number | null;
  lap: number;
  totalLaps: number;
  timeSec: number;
  lapTimes: readonly number[];
  bestLap: number | null;
  position: number;
  totalCars: number;
}

/** Top-left lap/time block, centre countdown banner and the finish card. */
export class RaceHud {
  private readonly el = document.createElement('div');
  private readonly pos: HTMLElement;
  private readonly lap: HTMLElement;
  private readonly time: HTMLElement;
  private readonly best: HTMLElement;
  private readonly banner: HTMLElement;
  private last = { pos: '', lap: '', time: '', best: '', banner: '' };

  constructor(root: HTMLElement) {
    this.el.innerHTML = `
      <div class="race-top">
        <div class="race-label">POS</div>
        <div class="race-pos"></div>
        <div class="race-label">LAP</div>
        <div class="race-lap"></div>
        <div class="race-time"></div>
        <div class="race-best"></div>
      </div>
      <div class="race-banner" hidden></div>`;
    root.appendChild(this.el);
    const q = (s: string): HTMLElement => this.el.querySelector(s) as HTMLElement;
    this.pos = q('.race-pos');
    this.lap = q('.race-lap');
    this.time = q('.race-time');
    this.best = q('.race-best');
    this.banner = q('.race-banner');
  }

  update(s: RaceHudState): void {
    const pos = `${s.position}<small>/${s.totalCars}</small>`;
    if (pos !== this.last.pos) {
      this.last.pos = pos;
      this.pos.innerHTML = pos;
    }
    const lap = `${Math.min(s.lap, s.totalLaps)}<small>/${s.totalLaps}</small>`;
    if (lap !== this.last.lap) {
      this.last.lap = lap;
      this.lap.innerHTML = lap;
    }
    const time = formatTime(s.timeSec);
    if (time !== this.last.time) {
      this.last.time = time;
      this.time.textContent = time;
    }
    const best = `BEST ${formatTime(s.bestLap)}`;
    if (best !== this.last.best) {
      this.last.best = best;
      this.best.textContent = best;
    }

    const banner = s.countdown === null ? '' : s.countdown === 0 ? 'GO!' : String(s.countdown);
    if (banner !== this.last.banner) {
      this.last.banner = banner;
      this.banner.hidden = banner === '';
      this.banner.classList.toggle('go', s.countdown === 0);
      const hint = s.countdown === 0 ? 'FULL THROTTLE' : 'WAIT FOR GO';
      this.banner.innerHTML = `${banner}<span class="race-banner-hint">${hint}</span>`;
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
