import type { WeatherDef } from '../core/Data';
import { WEATHER_FX } from '../weather/config';
import { inFlood } from '../weather/flood';
import { composeSurface } from '../weather/grip';
import { PuddleTracker, puddleSpots, type PuddleSpot } from '../weather/puddleSpots';
import type { TrackPath } from '../world/TrackPath';

/** What the weather needs of a car's physics: where it is and the surface multipliers it writes back. */
export interface WeatherBody {
  readonly curr: { readonly p: { readonly x: number; readonly y: number; readonly z: number } };
  readonly speedMps: number;
  surfaceGripMul: number;
  brakeDistanceMul: number;
  dragMul: number;
  addYawKick(radS: number): void;
}

export interface WeatherStep {
  /** The puddle the car drove into this step, if any. */
  entered: PuddleSpot | null;
  flooded: boolean;
}

/** The yaw kick (rad/s) of puddle `index`: fixed per puddle (not random) so the server and the client agree on it. */
export function puddleYawKick(index: number, kickDegS: number): number {
  const mag = 0.5 + 0.5 * ((index * 0.6180339887) % 1);
  return (index % 2 === 0 ? 1 : -1) * mag * ((kickDegS * Math.PI) / 180);
}

/**
 * The simulation-affecting part of a map's weather (Map 4's storm): wet-road grip, the puddles' timed grip loss and
 * yaw kick, the flooded dip's grip and drag, and the longer braking distance. Everything is a function of where the
 * car is and the fixed-step clock, with no randomness, so the server's `RaceSim` and the browser (which predicts its
 * own car) apply the same multipliers. Rain intensity, spray, lightning and audio are not here: they are visual only
 * (`WeatherSystem`) and follow the lap schedule (`rainIntensityAt`).
 */
export class WeatherSim {
  private readonly tracker: PuddleTracker;
  private readonly carT = new Map<string, number>();

  constructor(
    readonly def: WeatherDef,
    private readonly path: TrackPath,
    roadY: number,
  ) {
    this.tracker = new PuddleTracker(puddleSpots(def, path, roadY), WEATHER_FX.puddle);
  }

  get spots(): readonly PuddleSpot[] {
    return this.tracker.spotList();
  }

  /** One fixed step for one car; call before the car's `preStep` so the multipliers are in place. */
  stepCar(id: string, body: WeatherBody, dt: number): WeatherStep {
    const p = body.curr.p;
    const t = this.alongTrack(id, p.x, p.z);
    const entered = this.tracker.update(id, p.x, p.z, dt);
    const flooded = inFlood(this.def, t, p.y, WEATHER_FX.flood.depthTestMarginM);
    const m = composeSurface(this.def, this.tracker.gripActive(id), flooded);
    body.surfaceGripMul = m.grip;
    body.brakeDistanceMul = m.brakeDistance;
    body.dragMul = m.drag;
    if (entered && body.speedMps > WEATHER_FX.puddle.splashMinSpeedMps) {
      body.addYawKick(puddleYawKick(this.tracker.spotList().indexOf(entered), WEATHER_FX.puddle.yawKickDegS));
    }
    return { entered: entered && body.speedMps > WEATHER_FX.puddle.splashMinSpeedMps ? entered : null, flooded };
  }

  /** Is the car's grip currently cut by a puddle (tests, debug)? */
  puddleActive(id: string): boolean {
    return this.tracker.gripActive(id);
  }

  /** Put a car's multipliers back to dry. */
  clear(body: WeatherBody): void {
    body.surfaceGripMul = 1;
    body.brakeDistanceMul = 1;
    body.dragMul = 1;
  }

  /**
   * Along-track t of a car: a windowed search around its last t, redone over the whole lap after a jump (respawn,
   * reset, teleport) when the windowed answer is nowhere near the car.
   */
  private alongTrack(id: string, x: number, z: number): number {
    const path = this.path;
    let t = path.project(x, z, this.carT.get(id));
    const i = Math.floor((t - Math.floor(t)) * path.count) % path.count;
    const dx = x - path.px[i];
    const dz = z - path.pz[i];
    if (dx * dx + dz * dz > 400) t = path.project(x, z);
    this.carT.set(id, t);
    return t;
  }
}
