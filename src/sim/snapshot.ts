import {
  FLAG_AIRBORNE,
  FLAG_BRAKING,
  FLAG_DRIFTING,
  FLAG_FINISHED,
  FLAG_INVULNERABLE,
  FLAG_NITRO,
  FLAG_WRECKED,
  round,
  type SnapCar,
} from '../shared/protocol';
import type { SimEntry } from './RaceSim';

/** One car's wire state. `quantise` rounds to the snapshot precision (1 cm, 4 dp rotation); a client's own state skips it. */
export function snapOfEntry(e: SimEntry, lap: number, respawns: number, quantise = true): SnapCar {
  const ph = e.car.physics;
  const body = ph.body;
  const v = body.linvel();
  const w = body.angvel();
  const { p, q } = ph.curr;
  const r = (x: number, dp: number): number => (quantise ? round(x, dp) : x);
  return {
    id: e.id,
    p: [r(p.x, 2), r(p.y, 2), r(p.z, 2)],
    q: [r(q.x, 4), r(q.y, 4), r(q.z, 4), r(q.w, 4)],
    v: [r(v.x, 2), r(v.y, 2), r(v.z, 2)],
    w: [r(w.x, 3), r(w.y, 3), r(w.z, 3)],
    hp: Math.round(e.car.hull.hp),
    nb: r(ph.nitro.bars, 2),
    lap,
    t: r(e.t, 4),
    fl:
      (e.car.hull.wrecked ? FLAG_WRECKED : 0) |
      (ph.airborne ? FLAG_AIRBORNE : 0) |
      (e.car.hull.invulnerable ? FLAG_INVULNERABLE : 0) |
      (e.race.phase === 'finished' ? FLAG_FINISHED : 0) |
      (ph.braking ? FLAG_BRAKING : 0) |
      (ph.nitroActive ? FLAG_NITRO : 0) |
      (ph.drifting ? FLAG_DRIFTING : 0),
    st: r(ph.wheels[0]?.steerAngle ?? 0, 3),
    rs: respawns,
  };
}
