import type RAPIER from '@dimforge/rapier3d-compat';
import type { TrackDef } from '../core/Data';
import type { TrackPath } from '../world/TrackPath';
import {
  rightLaneOffsetM,
  rightOfHeading,
  sampleAt,
  trafficPlan,
  trafficT,
  type PathSample,
  type TrafficKind,
  type TrafficSpec,
} from './congHoaTrafficCommon';

type Rapier = typeof RAPIER;

/** Ambient-traffic part of Cong Hoa's JSON. */
export interface CongHoaTrafficRaw {
  roadLayout: { lanesPerDirection: number };
  ambientTraffic: {
    scooters: number;
    cars: number;
    buses: number;
    speedKmh: [number, number];
    models: { scooters: string[]; cars: string[]; buses: string[] };
    /** Full box size (x, y, z) per vehicle kind; the collider is half of it. */
    vehicleSizesM: { scooter: [number, number, number]; car: [number, number, number]; bus: [number, number, number] };
  };
}

export interface CongHoaMover {
  spec: TrafficSpec;
  kindKey: string;
  body: RAPIER.RigidBody;
  x: number;
  z: number;
  yaw: number;
}

/**
 * The physics half of Cong Hoa's ambient traffic: kinematic cuboids in the right-hand lane, flat on the road. No
 * meshes, so the server builds it too. `CongHoaLandmarks` (browser) draws from `movers`.
 */
export class CongHoaTrafficSim {
  readonly movers: CongHoaMover[] = [];
  readonly skippedKinds: string[] = [];
  time = 0;
  private readonly raw: CongHoaTrafficRaw;
  private readonly sample: PathSample = { x: 0, z: 0, tx: 0, tz: 1 };
  private readonly kinPos = { x: 0, y: 0, z: 0 };
  private readonly kinRot = { x: 0, y: 0, z: 0, w: 1 };

  constructor(
    R: Rapier,
    private readonly world: RAPIER.World,
    private readonly track: TrackDef,
    private readonly path: TrackPath,
  ) {
    this.raw = track.raw as unknown as CongHoaTrafficRaw;
    const cfg = this.raw.ambientTraffic;
    const half = (size: [number, number, number]): [number, number, number] => [size[0] / 2, size[1] / 2, size[2] / 2];
    const kinds: TrafficKind[] = [
      { key: 'scooters', count: cfg.scooters, models: cfg.models.scooters, half: half(cfg.vehicleSizesM.scooter) },
      { key: 'cars', count: cfg.cars, models: cfg.models.cars, half: half(cfg.vehicleSizesM.car) },
      { key: 'buses', count: cfg.buses, models: cfg.models.buses, half: half(cfg.vehicleSizesM.bus) },
    ];
    kinds.forEach((kind, ki) => {
      if (kind.models.length === 0) {
        if (kind.count > 0) this.skippedKinds.push(kind.key);
        return;
      }
      const specs = trafficPlan(ki, kind.count, kind.models.length, 1971, cfg.speedKmh, track.lapLengthM, {
        behindLineM: 130,
        aheadOfLineM: 30,
      });
      for (const spec of specs) {
        const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
        world.createCollider(
          R.ColliderDesc.cuboid(kind.half[0], kind.half[1], kind.half[2])
            .setTranslation(0, kind.half[1], 0)
            .setFriction(0.2),
          body,
        );
        this.movers.push({ spec, kindKey: kind.key, body, x: 0, z: 0, yaw: 0 });
      }
    });
    this.place(true);
  }

  /** Fixed-step update, after `world.step()`. */
  update(dt: number): void {
    this.time += dt;
    this.place(false);
  }

  dispose(): void {
    for (const mv of this.movers) this.world.removeRigidBody(mv.body);
    this.movers.length = 0;
  }

  /** Along-track t of every vehicle of a kind (0 scooters, 1 cars, 2 buses). */
  tsOfKind(kind: number): number[] {
    return this.movers
      .filter((m) => m.spec.kind === kind)
      .map((m) => trafficT(m.spec, this.time, this.track.lapLengthM));
  }

  private place(initial: boolean): void {
    const offset = rightLaneOffsetM(this.track.roadWidthM, this.raw.roadLayout.lanesPerDirection);
    for (const mv of this.movers) {
      sampleAt(this.path, trafficT(mv.spec, this.time, this.track.lapLengthM), this.sample);
      const r = rightOfHeading(this.sample.tx, this.sample.tz);
      const d = offset + mv.spec.jitterM;
      mv.x = this.sample.x + r.x * d;
      mv.z = this.sample.z + r.z * d;
      mv.yaw = Math.atan2(this.sample.tx, this.sample.tz);
      this.kinPos.x = mv.x;
      this.kinPos.z = mv.z;
      this.kinRot.y = Math.sin(mv.yaw / 2);
      this.kinRot.w = Math.cos(mv.yaw / 2);
      if (initial) {
        mv.body.setTranslation(this.kinPos, true);
        mv.body.setRotation(this.kinRot, true);
      }
      mv.body.setNextKinematicTranslation(this.kinPos);
      mv.body.setNextKinematicRotation(this.kinRot);
    }
  }
}
