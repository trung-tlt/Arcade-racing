import type { NoFireZone } from '../core/Data';

/** The zone covering along-track `t` (wrapped into [0, 1)), or null. Zones come from the track JSON `noFireZones`. */
export function noFireZoneAt(zones: readonly NoFireZone[], t: number): NoFireZone | null {
  const tt = t - Math.floor(t);
  for (const z of zones) {
    if (tt >= z.fromT && tt < z.toT) return z;
  }
  return null;
}
