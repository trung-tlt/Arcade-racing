import { COMBAT, type TrackDef } from '../core/Data';
import type { PickupDef } from '../combat/Pickups';
import type { V3 } from '../combat/AutoAim';
import type { TrackPath } from '../world/TrackPath';

/** World position of every pickup, indexed by pickup id (centre line + lane offset, at the pickup height). */
export function pickupPositions(defs: readonly PickupDef[], path: TrackPath, track: TrackDef): V3[] {
  const out: V3[] = [];
  for (const d of defs) {
    const p = path.pointAt(d.t);
    const tg = path.tangentAt(d.t);
    const h = Math.hypot(tg.x, tg.z) || 1;
    const lx = tg.z / h;
    const lz = -tg.x / h;
    const off = track.laneOffsetsM[d.lane] ?? 0;
    out[d.id] = { x: p.x + lx * off, y: COMBAT.pickupHeightM, z: p.z + lz * off };
  }
  return out;
}
