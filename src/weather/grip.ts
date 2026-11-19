import type { WeatherDef } from '../core/Data';

export interface SurfaceMuls {
  grip: number;
  brakeDistance: number;
  drag: number;
}

/**
 * The multipliers a car feels this step. The wet road applies everywhere; a puddle (for its short timer) and the
 * flood each give their own grip figure, and the lowest one wins (they are fractions of dry grip, not stacked).
 */
export function composeSurface(def: WeatherDef, inPuddle: boolean, inFlood: boolean): SurfaceMuls {
  const g = def.grip;
  let grip = g.wetMul;
  if (inPuddle) grip = Math.min(grip, g.puddleMul);
  if (inFlood) grip = Math.min(grip, g.floodMul);
  return { grip, brakeDistance: g.brakeDistanceMul, drag: inFlood ? def.flood.dragMul : 1 };
}
