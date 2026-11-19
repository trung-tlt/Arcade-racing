import type { WeatherDef } from '../core/Data';

/** Is along-track `t` inside the flooded stretch? (The range never wraps the start line on Map 4.) */
export function inFloodRange(def: WeatherDef, t: number): boolean {
  const tt = t - Math.floor(t);
  return tt >= def.flood.fromT && tt <= def.flood.toT;
}

/** In the water: in the flooded stretch and low enough that the car actually stands in the dip. */
export function inFlood(def: WeatherDef, t: number, carY: number, marginM: number): boolean {
  return inFloodRange(def, t) && carY < def.flood.waterY + marginM;
}
