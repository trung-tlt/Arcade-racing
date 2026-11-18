/** Pure nitro-tank logic: bars are a float in [0, maxBars]. */
export class NitroTank {
  bars = 0;
  active = false;

  constructor(
    private readonly maxBars: number,
    private readonly minToFire: number,
  ) {}

  /** Returns the number of whole bars crossed by this addition. */
  add(bars: number): number {
    const before = Math.floor(this.bars);
    this.bars = Math.min(this.maxBars, Math.max(0, this.bars + bars));
    return Math.max(0, Math.floor(this.bars) - before);
  }

  /** Burns nitro while `wanted`; one bar lasts `barSec` seconds. Returns whether boost is on. */
  update(wanted: boolean, dt: number, barSec: number): boolean {
    if (wanted && this.bars >= (this.active ? 0 : this.minToFire)) {
      this.bars = Math.max(0, this.bars - dt / barSec);
      this.active = this.bars > 0;
    } else {
      this.active = false;
    }
    return this.active;
  }
}

/** Pure drift detection: slip angle between velocity and heading, in degrees. */
export function slipAngleDeg(forwardSpeed: number, lateralSpeed: number): number {
  return Math.abs((Math.atan2(lateralSpeed, Math.abs(forwardSpeed)) * 180) / Math.PI);
}
