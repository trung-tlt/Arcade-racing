import type { WeatherDef } from '../core/Data';

/** Rain intensity 0..1 for a lap (0-based). The last listed value holds for any later lap. */
export function rainIntensityAt(def: WeatherDef, lap: number): number {
  const list = def.rain.intensity;
  if (list.length === 0) return 0;
  const i = Math.min(Math.max(0, Math.floor(lap)), list.length - 1);
  return Math.min(1, Math.max(0, list[i]));
}

/** Rain particle budget: phones and the Low preset use the small count. */
export function rainParticleCount(def: WeatherDef, reduced: boolean): number {
  const p = def.rain.particles;
  return reduced ? p.countMobile : p.countDesktop;
}

/** How many of `max` rain particles are drawn at an intensity. */
export function visibleRainCount(max: number, intensity: number): number {
  return Math.round(max * Math.min(1, Math.max(0, intensity)));
}
