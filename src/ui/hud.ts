export interface HudState {
  speedKmh: number;
  nitroBars: number;
  nitroActive: boolean;
  drifting: boolean;
  gear: number;
  mph: boolean;
}

export class Hud {
  private readonly el: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly unit: HTMLElement;
  private readonly gearEl: HTMLElement;
  private lastGear = -1;
  private lastMph: boolean | null = null;
  private readonly nitro: HTMLElement;
  private readonly fills: HTMLElement[] = [];
  private readonly drift: HTMLElement;
  private lastSpeed = -1;
  private lastFill: number[] = [-1, -1, -1];
  private lastActive = false;
  private lastDrift = false;

  constructor(private readonly root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.innerHTML = `
      <div class="hud-speed">
        <div class="hud-speed-val">0</div>
        <div class="hud-speed-unit"><span class="hud-unit">KM/H</span> · <span class="hud-gear">GEAR 1</span></div>
        <div class="hud-nitro">${'<span class="hud-bar"><i></i></span>'.repeat(3)}</div>
      </div>
      <div class="hud-drift">DRIFT</div>
      <div class="hud-hint">
        <b>W/S</b> throttle/brake · <b>A/D</b> steer · <b>Space</b> drift · <b>J</b> gun · <b>K</b> rocket<br />
        <b>Shift</b> nitro · <b>R</b> reset
      </div>`;
    this.root.appendChild(this.el);
    this.speed = this.el.querySelector('.hud-speed-val') as HTMLElement;
    this.unit = this.el.querySelector('.hud-unit') as HTMLElement;
    this.gearEl = this.el.querySelector('.hud-gear') as HTMLElement;
    this.nitro = this.el.querySelector('.hud-nitro') as HTMLElement;
    this.drift = this.el.querySelector('.hud-drift') as HTMLElement;
    this.el.querySelectorAll<HTMLElement>('.hud-bar > i').forEach((f) => this.fills.push(f));
  }

  update(s: HudState): void {
    const sp = Math.round(s.mph ? s.speedKmh * 0.621371 : s.speedKmh);
    if (s.mph !== this.lastMph) {
      this.lastMph = s.mph;
      this.unit.textContent = s.mph ? 'MPH' : 'KM/H';
    }
    if (s.gear !== this.lastGear) {
      this.lastGear = s.gear;
      this.gearEl.textContent = `GEAR ${s.gear}`;
    }
    if (sp !== this.lastSpeed) {
      this.lastSpeed = sp;
      this.speed.textContent = String(sp);
    }
    for (let i = 0; i < 3; i++) {
      const pct = Math.round(Math.min(1, Math.max(0, s.nitroBars - i)) * 100);
      if (pct !== this.lastFill[i]) {
        this.lastFill[i] = pct;
        this.fills[i].style.width = `${pct}%`;
      }
    }
    if (s.nitroActive !== this.lastActive) {
      this.lastActive = s.nitroActive;
      this.nitro.classList.toggle('active', s.nitroActive);
    }
    if (s.drifting !== this.lastDrift) {
      this.lastDrift = s.drifting;
      this.drift.classList.toggle('on', s.drifting);
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
