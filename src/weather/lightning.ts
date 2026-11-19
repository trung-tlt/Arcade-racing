import type { WeatherDef } from '../core/Data';

export interface Strike {
  /** Seconds from the flash to the thunder. */
  thunderDelaySec: number;
  /** Bolt direction relative to the camera's heading (degrees, 0 = straight ahead). */
  azimuthDeg: number;
  /** 0..1 position inside the configured distance range. */
  distanceK: number;
}

/** Strikes on a random timer (`everySec`). `rng` is injected so tests are deterministic. */
export class LightningScheduler {
  private timeLeft: number;

  constructor(
    private readonly cfg: WeatherDef['lightning'],
    private readonly sectorDeg: number,
    private readonly rng: () => number = Math.random,
  ) {
    this.timeLeft = this.nextGap();
  }

  private nextGap(): number {
    const [a, b] = this.cfg.everySec;
    return a + (b - a) * this.rng();
  }

  /** Seconds until the next strike. */
  get secondsToNext(): number {
    return this.timeLeft;
  }

  update(dt: number): Strike | null {
    this.timeLeft -= dt;
    if (this.timeLeft > 0) return null;
    this.timeLeft = this.nextGap();
    const [d0, d1] = this.cfg.thunder.delaySec;
    return {
      thunderDelaySec: d0 + (d1 - d0) * this.rng(),
      azimuthDeg: (this.rng() * 2 - 1) * this.sectorDeg,
      distanceK: this.rng(),
    };
  }
}

/**
 * Flash brightness 0..1 at `elapsed` seconds after the strike: with `double` the pattern (e.g. [1, 0.25, 1]) is
 * stepped through evenly over the flash, each step fading a little; otherwise one flash that fades out.
 */
export function flashLevel(elapsed: number, cfg: WeatherDef['lightning']['flash'], pattern: readonly number[]): number {
  if (elapsed < 0 || elapsed >= cfg.durationSec) return 0;
  const k = elapsed / cfg.durationSec;
  if (!cfg.double) return 1 - k;
  const n = pattern.length;
  const step = Math.min(n - 1, Math.floor(k * n));
  const within = k * n - step;
  return pattern[step] * (1 - 0.5 * within);
}
