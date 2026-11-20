import type { CameraView } from '../core/ViewState';
import type { CarDef } from '../core/Data';

/** Pure helpers for the driver's first-person view: which views a car offers, the head-motion feel and the dash readout. */

export interface FpvFeel {
  fov: { cockpit: number; helmet: number; hood: number; nitroKickDeg: number; nitroLerpSec: number };
  head: {
    lagSec: number;
    leanMaxDeg: number;
    leanPerLatAccelDeg: number;
    leanRateSec: number;
    dipM: number;
    dipRecoverSec: number;
    dipMinImpactMps: number;
    bikeLeanMul: number;
  };
  apex: { gain: number; maxDeg: number; rateSec: number };
  lookBack: { rateSec: number };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const DEG = Math.PI / 180;
/** 1 − e^(−dt/τ): the share of the gap a first-order lag closes in `dt`. */
export const follow = (dt: number, tauSec: number): number => (tauSec <= 0 ? 1 : 1 - Math.exp(-dt / tauSec));

/** The views a car can show. Chase and hood always work; the driver's view needs fpv data (and the rig, for `cockpit` mode). */
export function availableViews(def: CarDef, rigLoaded: boolean): CameraView[] {
  const views: CameraView[] = ['chase', 'hood'];
  const f = def.fpv;
  if (f && (f.mode === 'helmet' || rigLoaded)) views.push('cockpit');
  return views;
}

/** The view after `cur` that this car can show (V cycles chase → hood → cockpit → chase). */
export function nextAvailableView(cur: CameraView, views: readonly CameraView[]): CameraView {
  const order: CameraView[] = ['chase', 'hood', 'cockpit'];
  for (let i = 1; i <= order.length; i++) {
    const v = order[(order.indexOf(cur) + i) % order.length];
    if (views.includes(v)) return v;
  }
  return 'chase';
}

/** A view the car can't show (a saved cockpit choice on a car without one) falls back to the chase camera. */
export const resolveView = (cur: CameraView, views: readonly CameraView[]): CameraView =>
  views.includes(cur) ? cur : 'chase';

/** Base field of view (degrees) of a first-person view, plus the nitro kick. */
export function fpvFov(view: CameraView, def: CarDef, feel: FpvFeel, nitro: number): number {
  const base = view === 'hood' ? feel.fov.hood : (def.fpv?.fovDeg ?? feel.fov[def.fpv?.mode ?? 'cockpit']);
  return base + feel.fov.nitroKickDeg * clamp(nitro, 0, 1);
}

/** The driver's head: lags the chassis, leans into corners, dips on landings and looks toward the apex. */
export class HeadMotion {
  /** Offset of the head from the eye point, in car space (m): x = left, y = up, z = forward. */
  readonly offset = { x: 0, y: 0, z: 0 };
  /** Extra rotation of the view (radians): yaw + = left, roll + = leaning right. */
  yaw = 0;
  roll = 0;
  private lookBack = 0;
  private dip = 0;
  private prevVy = 0;
  private apex = 0;
  private lean = 0;

  /** 0 → facing forward, 1 → looking over the shoulder. */
  get lookBackAmount(): number {
    return this.lookBack;
  }

  reset(): void {
    this.offset.x = this.offset.y = this.offset.z = 0;
    this.yaw = this.roll = this.lookBack = this.dip = this.prevVy = this.apex = this.lean = 0;
  }

  /**
   * `lateralG` = lateral acceleration in m/s² (+ = pushed to the car's left), `vy` = vertical speed, `steer` −1..1
   * (+ = left in the controls' sign convention the caller already flipped), `bike` leans the view with the machine.
   */
  update(
    dt: number,
    feel: FpvFeel,
    s: { lateralAccel: number; vy: number; steer: number; lookBack: boolean; bikeLeanRad: number; calm: boolean },
  ): void {
    const h = feel.head;
    // Landing: a sudden stop of the fall dips the head, then it recovers.
    const dvy = s.vy - this.prevVy;
    this.prevVy = s.vy;
    if (!s.calm && dvy > h.dipMinImpactMps)
      this.dip = clamp(this.dip + h.dipM * clamp(dvy / 10, 0.4, 1.5), 0, h.dipM * 1.5);
    this.dip *= Math.exp(-dt / h.dipRecoverSec);
    this.offset.y = -this.dip;

    // Head lag: lateral g slides the head sideways a little (the 0.03 s lag as a tiny displacement).
    const slide = s.calm ? 0 : clamp(-s.lateralAccel * h.lagSec * 0.012, -0.05, 0.05);
    this.offset.x += (slide - this.offset.x) * follow(dt, h.lagSec);

    // Lean ±leanMaxDeg with lateral g, eased.
    const leanGoal = s.calm ? 0 : clamp(s.lateralAccel * h.leanPerLatAccelDeg, -h.leanMaxDeg, h.leanMaxDeg) * DEG;
    this.lean += (leanGoal - this.lean) * follow(dt, h.leanRateSec);
    this.roll = this.lean + s.bikeLeanRad * h.bikeLeanMul;

    // Look toward the apex: yaw 0.12 × steer, max 8°.
    const apexGoal = s.calm ? 0 : clamp(s.steer * feel.apex.gain, -feel.apex.maxDeg * DEG, feel.apex.maxDeg * DEG);
    this.apex += (apexGoal - this.apex) * follow(dt, feel.apex.rateSec);

    this.lookBack += ((s.lookBack ? 1 : 0) - this.lookBack) * follow(dt, feel.lookBack.rateSec);
    this.yaw = this.apex + this.lookBack * Math.PI;
  }
}

/** Camera shake with its own decay: `kick` adds a burst, `angle` is the current wobble (radians). */
export class FpvShake {
  private left = 0;
  private total = 1;
  private amp = 0;

  kick(sec: number, deg: number): void {
    if (deg * DEG >= this.amp * (this.left / this.total)) {
      this.left = sec;
      this.total = sec;
      this.amp = deg * DEG;
    }
  }

  /** `rnd` returns −1..1; the wobble fades out over the burst. */
  step(dt: number, rnd: () => number): { x: number; y: number } {
    if (this.left <= 0) return { x: 0, y: 0 };
    this.left = Math.max(0, this.left - dt);
    const k = this.amp * (this.left / this.total);
    return { x: rnd() * k, y: rnd() * k };
  }

  get active(): boolean {
    return this.left > 0;
  }
}

/** Rocket-sized hits (explosions, wrecks) shake harder and longer than bullets. */
export function shakeFor(amount: number, rocketMin: number): 'hit' | 'rocket' {
  return amount >= rocketMin ? 'rocket' : 'hit';
}

/** Whether the mirror / dash should redraw now: `acc` is the time since the last redraw, `hz` the rate. */
export function dueForRedraw(acc: number, hz: number): boolean {
  return hz > 0 && acc >= 1 / hz - 1e-9;
}

export interface MirrorSpec {
  width: number;
  height: number;
  fps: number;
}

export function mirrorSpec(
  low: boolean,
  m: { width: number; height: number; fps: number; lowWidth: number; lowHeight: number; lowFps: number },
): MirrorSpec {
  return low
    ? { width: m.lowWidth, height: m.lowHeight, fps: m.lowFps }
    : { width: m.width, height: m.height, fps: m.fps };
}

export interface DashReadout {
  speed: string;
  unit: string;
  gear: string;
  rpm: number;
  nitroBars: number;
}

/** What the dash screen shows: speed in the player's unit, gear (R in reverse), revs 0..1 and the nitro bars (0..3). */
export function dashReadout(
  speedMps: number,
  reversing: boolean,
  gear: number,
  rpm: number,
  nitro: number,
  mph: boolean,
): DashReadout {
  const v = Math.abs(speedMps) * (mph ? 2.23694 : 3.6);
  return {
    speed: String(Math.round(v)),
    unit: mph ? 'MPH' : 'KM/H',
    gear: reversing ? 'R' : String(gear),
    rpm: clamp(rpm, 0, 1),
    nitroBars: clamp(nitro, 0, 3),
  };
}
