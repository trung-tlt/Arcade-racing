import type { CarDef, HandlingDef } from '../core/Data';

/** Pure open-wheel rules (Fulmine FX): speed-squared downforce and extra grip at speed. Numbers: handling.json `openWheel`. */

/**
 * Downforce in newtons for `downforce` x v^2 x coef, capped at `maxDownforceWeightMul` times the car's weight so a
 * very fast car can't be pinned to the road. `gravity` is the magnitude of world gravity (m/s^2).
 */
export function downforceN(def: CarDef, speedMps: number, h: HandlingDef, gravity: number): number {
  if (!def.openWheel || !def.downforce) return 0;
  const raw = def.downforce * h.openWheel.downforceCoef * speedMps * speedMps;
  return Math.min(raw, h.openWheel.maxDownforceWeightMul * def.massKg * gravity);
}

/** Tyre grip multiplier: 1 below the threshold, easing up to `gripBoostMul` over `gripBoostBlendKmh` above it. */
export function openWheelGripMul(def: CarDef, speedMps: number, h: HandlingDef): number {
  if (!def.openWheel) return 1;
  const o = h.openWheel;
  const over = speedMps * 3.6 - o.gripBoostAboveKmh;
  const k = Math.min(1, Math.max(0, over / o.gripBoostBlendKmh));
  return 1 + (o.gripBoostMul - 1) * k;
}
