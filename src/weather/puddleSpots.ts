import type { WeatherDef } from '../core/Data';

export interface PuddleSpot {
  x: number;
  y: number;
  z: number;
  radiusM: number;
  /** Unit tangent of the road there (x, z). */
  tx: number;
  tz: number;
  /** Road pitch (rad, + = climbing along travel). */
  pitch: number;
}

interface PathLike {
  pointAt(t: number): { x: number; y: number; z: number };
  tangentAt(t: number): { x: number; y: number; z: number };
}

/** World placement of the JSON puddles: `lateralM` is measured from the racing line, + = the car's left. */
export function puddleSpots(def: WeatherDef, path: PathLike, roadY: number): PuddleSpot[] {
  return def.puddles.items.map((it) => {
    const p = path.pointAt(it.t);
    const tg = path.tangentAt(it.t);
    const h = Math.hypot(tg.x, tg.z) || 1;
    const tx = tg.x / h;
    const tz = tg.z / h;
    // Left of travel = (tz, 0, -tx), the same convention as the road ribbon.
    return {
      x: p.x + tz * it.lateralM,
      y: p.y + roadY,
      z: p.z - tx * it.lateralM,
      radiusM: it.radiusM,
      tx,
      tz,
      pitch: Math.atan2(tg.y, h),
    };
  });
}

export interface PuddleTrackerOptions {
  /** Seconds the reduced grip lasts after entering. */
  gripSec: number;
  /** A car counts as inside within this fraction of the puddle radius. */
  hitRadiusMul: number;
}

interface CarState {
  inside: number;
  gripLeft: number;
}

/** Which cars are in a puddle and for how long their grip stays reduced. No allocation after a car is first seen. */
export class PuddleTracker {
  private readonly cars = new Map<string, CarState>();

  constructor(
    private readonly spots: readonly PuddleSpot[],
    private readonly opts: PuddleTrackerOptions,
  ) {}

  /** Advance one car. Returns the spot it just entered, or null. */
  update(carId: string, x: number, z: number, dt: number): PuddleSpot | null {
    let st = this.cars.get(carId);
    if (!st) {
      st = { inside: -1, gripLeft: 0 };
      this.cars.set(carId, st);
    }
    st.gripLeft = Math.max(0, st.gripLeft - dt);
    let now = -1;
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      const r = s.radiusM * this.opts.hitRadiusMul;
      const dx = x - s.x;
      const dz = z - s.z;
      if (dx * dx + dz * dz <= r * r) {
        now = i;
        break;
      }
    }
    let entered: PuddleSpot | null = null;
    if (now >= 0 && now !== st.inside) {
      st.gripLeft = this.opts.gripSec;
      entered = this.spots[now];
    }
    st.inside = now;
    return entered;
  }

  spotList(): readonly PuddleSpot[] {
    return this.spots;
  }

  gripActive(carId: string): boolean {
    return (this.cars.get(carId)?.gripLeft ?? 0) > 0;
  }

  forget(carId: string): void {
    this.cars.delete(carId);
  }
}
