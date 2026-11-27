import type { RacePhase } from '../race/RaceManager';
import { formatTime } from './format';

export interface RaceHudState {
  phase: RacePhase;
  /** 3,2,1 → number; 0 → GO; null → hide. */
  countdown: number | null;
  /** Light-sequence start: lamps lit so far (null = classic 3-2-1 or no countdown). */
  startLights?: number | null;
  startLightsTotal?: number;
  lap: number;
  totalLaps: number;
  timeSec: number;
  lapTimes: readonly number[];
  bestLap: number | null;
  position: number;
  totalCars: number;
  /** Online: the first few racers with the time gap to the car ahead (null for the leader), and this client's ping (ms). */
  standings?: { pos: number; name: string; gapSec: number | null; you: boolean }[];
  pingMs?: number;
}

/** Top-left lap/time block, centre countdown banner and the finish card. */
export class RaceHud {
  private readonly el = document.createElement('div');
  private readonly pos: HTMLElement;
  private readonly lap: HTMLElement;
  private readonly time: HTMLElement;
  private readonly best: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly standings: HTMLElement;
  private readonly ping: HTMLElement;
  private last = { pos: '', lap: '', time: '', best: '', banner: '', standings: '', ping: '' };

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
      <ol class="race-standings" aria-label="Live standings" hidden></ol>
      <div class="race-ping" hidden></div>
      <div class="race-banner" hidden></div>`;
    root.appendChild(this.el);
    const q = (s: string): HTMLElement => this.el.querySelector(s) as HTMLElement;
    this.pos = q('.race-pos');
    this.lap = q('.race-lap');
    this.time = q('.race-time');
    this.best = q('.race-best');
    this.banner = q('.race-banner');
    this.standings = q('.race-standings');
    this.ping = q('.race-ping');
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

    this.paintOnline(s);
    if (s.startLights !== undefined && s.startLights !== null) {
      // Five lamps instead of 3-2-1: red ones are lit; they all go out for GO.
      const total = s.startLightsTotal ?? 5;
      const key = `lamps${s.startLights}`;
      if (key !== this.last.banner) {
        this.last.banner = key;
        this.banner.hidden = false;
        this.banner.classList.remove('go');
        this.banner.classList.add('lamps');
        this.banner.innerHTML = `<span class="race-lamps" role="img" aria-label="${s.startLights} of ${total} start lights">${Array.from({ length: total }, (_, i) => `<i class="${i < (s.startLights ?? 0) ? 'on' : ''}"></i>`).join('')}</span><span class="race-banner-hint">WAIT FOR LIGHTS OUT</span>`;
      }
      return;
    }
    this.banner.classList.remove('lamps');
    const banner = s.countdown === null ? '' : s.countdown === 0 ? 'GO!' : String(s.countdown);
    if (banner !== this.last.banner) {
      this.last.banner = banner;
      this.banner.hidden = banner === '';
      this.banner.classList.toggle('go', s.countdown === 0);
      const hint = s.countdown === 0 ? 'FULL THROTTLE' : 'WAIT FOR GO';
      this.banner.innerHTML = `${banner}<span class="race-banner-hint">${hint}</span>`;
    }
  }

  /** Online only: the live standings list and the ping chip. */
  private paintOnline(s: RaceHudState): void {
    const rows = s.standings ?? null;
    const html = rows
      ? rows
          .map(
            (r) =>
              `<li class="${r.you ? 'you' : ''}"><span class="p">${r.pos}</span><span class="n">${r.name}</span><span class="g">${r.gapSec === null ? '' : `+${r.gapSec.toFixed(1)}`}</span></li>`,
          )
          .join('')
      : '';
    if (html !== this.last.standings) {
      this.last.standings = html;
      this.standings.hidden = rows === null;
      this.standings.innerHTML = html;
    }
    const ms = s.pingMs !== undefined && s.pingMs > 0 ? Math.round(s.pingMs) : null;
    const level = ms === null ? 0 : ms < 60 ? 4 : ms < 100 ? 3 : ms < 160 ? 2 : 1;
    const ping =
      ms === null
        ? ''
        : `<span class="bars l${level}" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span>${ms} ms</span>`;
    if (ping !== this.last.ping) {
      this.last.ping = ping;
      this.ping.hidden = ms === null;
      this.ping.innerHTML = ping;
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
