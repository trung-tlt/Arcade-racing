/**
 * Light-sequence start (Map 5): `lamps` red lights come on one per `stepSec`, then a random hold of
 * `holdMinSec..holdMaxSec`, then all lights go out = GO. Pure and seedable; replaces the 3-2-1 countdown for tracks whose
 * JSON has `startLine.lights`.
 *
 * API (what the gantry visual and the HUD read):
 *   const sl = new StartLights(RACE.startLights, rnd)    // rnd defaults to Math.random
 *   sl.update(dt)            // fixed-step, ONCE per step (the game shares one instance between all cars)
 *   sl.lit                   // 0..lamps lit red lamps; drive `start_light_1..lit` emissives on (lit >= n)
 *   sl.phase                 // 'lighting' | 'hold' | 'go' (lights out, race live)
 *   sl.released              // true once the lights are out (phase === 'go')
 *   sl.sinceGoSec            // seconds since GO (0 before)
 *   sl.onLit(n => ...)       // callback fired once per lamp as it comes on (n = 1..lamps), for the clunk
 *   sl.onGo(() => ...)       // callback fired once when the lights go out
 *   sl.restart()             // new sequence with a fresh random hold
 * sl.isJumpStart(throttle) is true when the throttle is on before GO; the penalty is cfg.jumpStartPenaltySec (RaceManager).
 */
export interface StartLightsCfg {
  lamps: number;
  stepSec: number;
  holdMinSec: number;
  holdMaxSec: number;
  goHoldSec: number;
  jumpStartPenaltySec: number;
  jumpStartThrottle: number;
}

export type StartLightsPhase = 'lighting' | 'hold' | 'go';

export class StartLights {
  phase: StartLightsPhase = 'lighting';
  lit = 0;
  sinceGoSec = 0;
  /** The random pause between the last lamp and lights-out, chosen per sequence. */
  holdSec = 0;
  private elapsed = 0;
  private litHandlers: ((n: number) => void)[] = [];
  private goHandlers: (() => void)[] = [];

  constructor(
    private readonly cfg: StartLightsCfg,
    private readonly rnd: () => number = Math.random,
  ) {
    this.restart();
  }

  get released(): boolean {
    return this.phase === 'go';
  }

  /** Total seconds from the first lamp to lights-out for this sequence. */
  get totalSec(): number {
    return this.cfg.lamps * this.cfg.stepSec + this.holdSec;
  }

  restart(): void {
    this.phase = 'lighting';
    this.lit = 0;
    this.sinceGoSec = 0;
    this.elapsed = 0;
    const { holdMinSec: lo, holdMaxSec: hi } = this.cfg;
    this.holdSec = lo + (hi - lo) * Math.min(1, Math.max(0, this.rnd()));
  }

  onLit(fn: (n: number) => void): void {
    this.litHandlers.push(fn);
  }

  onGo(fn: () => void): void {
    this.goHandlers.push(fn);
  }

  update(dt: number): void {
    if (this.phase === 'go') {
      this.sinceGoSec += dt;
      return;
    }
    this.elapsed += dt;
    const { lamps, stepSec } = this.cfg;
    // The first lamp lights after one step, so there is always a beat of darkness before the sequence starts.
    const want = Math.min(lamps, Math.floor(this.elapsed / stepSec));
    while (this.lit < want) {
      this.lit++;
      for (const h of this.litHandlers) h(this.lit);
    }
    if (this.lit >= lamps) this.phase = 'hold';
    if (this.elapsed >= this.totalSec) {
      this.phase = 'go';
      this.lit = 0;
      this.sinceGoSec = this.elapsed - this.totalSec;
      for (const h of this.goHandlers) h();
    }
  }

  /** True when the throttle is on before the lights go out. */
  isJumpStart(throttle: number): boolean {
    return this.phase !== 'go' && throttle > this.cfg.jumpStartThrottle;
  }
}
