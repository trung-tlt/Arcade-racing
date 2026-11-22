export interface PulseCfg {
  fireRatePerSec: number;
  heatPerShot: number;
  overheatLockoutSec: number;
  coolPerSec: number;
  /** Heat level right after a lockout ends. */
  heatAfterLockout: number;
}

/** Pure Pulse MG state: fire-rate accumulator, heat and overheat lockout. */
export class PulseGun {
  /** 0..1 */
  heat = 0;
  private lockTimer = 0;
  private accum: number;
  private overheatedNow = false;

  constructor(private readonly cfg: PulseCfg) {
    this.accum = 1 / cfg.fireRatePerSec; // primed: the first shot comes on the first tick of the trigger
  }

  /** Online: adopt the server's heat and lockout for the HUD. */
  sync(heat: number, locked: boolean): void {
    this.heat = heat;
    this.lockTimer = locked ? Math.max(this.lockTimer, 0.2) : 0;
  }

  get locked(): boolean {
    return this.lockTimer > 0;
  }

  /** True for the single update() in which the lockout began. */
  get justOverheated(): boolean {
    return this.overheatedNow;
  }

  /** Returns shots fired this tick. `enabled=false` (airborne, wrecked) fires nothing but still cools. */
  update(dt: number, trigger: boolean, enabled: boolean): number {
    this.overheatedNow = false;
    const interval = 1 / this.cfg.fireRatePerSec;

    if (this.lockTimer > 0) {
      this.lockTimer -= dt;
      this.accum = 0;
      if (this.lockTimer > 1e-9) return 0;
      this.lockTimer = 0;
      this.heat = this.cfg.heatAfterLockout;
      this.accum = 1 / this.cfg.fireRatePerSec;
      return 0;
    }

    if (!trigger || !enabled) {
      this.heat = Math.max(0, this.heat - this.cfg.coolPerSec * dt);
      // Ready to fire immediately on the next press.
      this.accum = interval;
      return 0;
    }

    this.accum += dt;
    let shots = 0;
    while (this.accum >= interval - 1e-9) {
      this.accum -= interval;
      shots++;
      this.heat += this.cfg.heatPerShot;
      if (this.heat >= 1 - 1e-9) {
        this.heat = 1;
        this.lockTimer = this.cfg.overheatLockoutSec;
        this.overheatedNow = true;
        this.accum = 0;
        break;
      }
    }
    return shots;
  }
}
