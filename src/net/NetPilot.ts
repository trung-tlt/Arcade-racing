import { AIDriver, type OtherCar } from '../ai/AIDriver';
import { RacingLine } from '../ai/RacingLine';
import { RACE, getCarDef, getTrack, roadWidthAt } from '../core/Data';
import type { SnapCar } from '../shared/protocol';
import { FLAG_AIRBORNE, FLAG_WRECKED } from '../shared/protocol';
import { centreRanges } from '../sim/RaceSim';
import type { CarControls } from '../vehicle/CarPhysics';
import { relaxTightBends } from '../world/relaxBends';
import { TrackPath } from '../world/TrackPath';

/**
 * A bot client: the same racing-line `AIDriver` the server's rivals use, fed only from server snapshots (own state and
 * the other cars). Stands in for a human in tests and load tests; it has no knowledge the real client would lack
 * (it cannot see pickups).
 */
export class NetPilot {
  readonly path: TrackPath;
  private readonly driver: AIDriver;
  private me: SnapCar | null = null;
  private others: OtherCar[] = [];
  private readonly otherIds = new Set<string>();
  private locked = true;
  private ageSec = 0;
  private t = 0;
  private haveT = false;

  constructor(
    trackId: string,
    private readonly myId: string,
    carId: string,
    skill = 0.9,
  ) {
    const def = getTrack(trackId);
    this.path = new TrackPath(
      relaxTightBends(def.spline.points, RACE.track.minTurnRadiusM),
      RACE.track.sampleSpacingM,
      RACE.track.projectWindowSamples,
    );
    const carDef = getCarDef(carId);
    this.driver = new AIDriver({
      carId: myId,
      line: new RacingLine(this.path, RACE.track.sampleSpacingM),
      laneOffsetM: 0,
      centreRanges: centreRanges(def),
      difficulty: 'normal',
      halfWidthAt: (t) => roadWidthAt(def, t) / 2,
      skill,
      handling: carDef.handling,
      topSpeedMps: carDef.topSpeedKmh / 3.6,
      self: () => {
        const c = this.me as SnapCar;
        // Dead-reckon the snapshot forward by its age: position by velocity, heading by yaw rate.
        const age = this.ageSec;
        const [qx, qy, qz, qw] = c.q;
        const yaw0 = Math.atan2(2 * (qx * qz + qw * qy), 1 - 2 * (qx * qx + qy * qy));
        const yaw = yaw0 + c.w[1] * age;
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        // +X is the car's left when facing +Z, so left = (fz, -fx).
        return {
          x: c.p[0] + c.v[0] * age,
          z: c.p[2] + c.v[2] * age,
          yaw,
          forwardSpeed: c.v[0] * fx + c.v[2] * fz,
          lateralSpeed: c.v[0] * fz - c.v[2] * fx,
          t: this.t,
          nitroBars: c.nb,
          airborne: (c.fl & FLAG_AIRBORNE) !== 0,
          locked: this.locked,
        };
      },
      others: () => this.others,
      pickups: () => [],
      rubberBand: () => 0,
      rocketAmmo: () => 0,
      hullFraction: () => (this.me ? Math.min(1, this.me.hp / carDef.hp) : 1),
    });
  }

  /**
   * `locked`: the race hasn't started (countdown). `ageSec`: how old the snapshot is (the pilot extrapolates it).
   * Returns the controls to send.
   */
  read(cars: readonly SnapCar[], locked = false, ageSec = 0): CarControls {
    this.locked = locked;
    this.ageSec = ageSec;
    this.me = cars.find((c) => c.id === this.myId) ?? null;
    if (!this.me)
      return { throttle: 0, brake: 0, steer: 0, drift: false, nitro: false, fire: false, fireSecondary: false };
    // The client projects itself onto the road (a snapshot's `t` is rounded, ~0.5 m).
    this.t = this.haveT
      ? this.path.project(this.me.p[0], this.me.p[2], this.t)
      : this.path.project(this.me.p[0], this.me.p[2]);
    this.haveT = true;
    if (this.otherIds.size === 0) {
      for (const c of cars) if (c.id !== this.myId) this.otherIds.add(c.id);
      this.others = [...this.otherIds].map((id) => ({ id, x: 0, y: 0, z: 0, wrecked: false }));
    }
    for (const o of this.others) {
      const c = cars.find((x) => x.id === o.id);
      if (!c) continue;
      o.x = c.p[0];
      o.y = c.p[1];
      o.z = c.p[2];
      o.wrecked = (c.fl & FLAG_WRECKED) !== 0;
    }
    return { ...this.driver.read() };
  }
}
