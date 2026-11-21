import type RAPIER from '@dimforge/rapier3d-compat';
import { RACE, type TrackDef } from '../core/Data';
import type { TrackPath } from '../world/TrackPath';
import {
  KIND,
  KIND_KEYS,
  MODEL_KEY,
  PLAN_SEED,
  SIZE_KEY,
  layoutOf,
  planPvdTraffic,
  trafficT,
  type KindKey,
  type PvdSpec,
  type PvdZones,
  type RawPvd,
} from './pvdTrafficCommon';
import { pitchFromSlope, rightOfHeading, sampleRoad, type RoadSample } from './trafficCommon';

type Rapier = typeof RAPIER;

/** One ambient vehicle: its plan, its kinematic body and where it is this step. */
export interface PvdMover {
  spec: PvdSpec;
  key: KindKey;
  body: RAPIER.RigidBody;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/**
 * The physics half of Map 4's ambient traffic: kinematic cuboids on scripted schedules. No meshes, so the server builds
 * it too. `PvdTraffic` (browser) draws from `movers`; both run the same clock.
 */
export class PvdTrafficSim {
  readonly movers: PvdMover[] = [];
  time = 0;
  private wetMul = 1;
  private readonly zones: PvdZones;
  private readonly sample: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, slope: 0 };
  private readonly kinPos = { x: 0, y: 0, z: 0 };
  private readonly kinRot = { x: 0, y: 0, z: 0, w: 1 };

  constructor(
    R: Rapier,
    private readonly world: RAPIER.World,
    track: TrackDef,
    private readonly path: TrackPath,
  ) {
    const raw = track.raw as unknown as RawPvd;
    const cfg = raw.ambientTraffic;
    const layout = layoutOf(track, path);
    this.zones = layout.zones;
    const specs = planPvdTraffic({
      seed: PLAN_SEED,
      lapLengthM: path.lengthM,
      speedKmh: cfg.speedKmh,
      counts: { scooters: cfg.ponchoScooters, cars: cfg.cars, buses: cfg.buses },
      models: { scooters: cfg.models.scooters.length, cars: cfg.models.cars.length, buses: cfg.models.buses.length },
      zones: layout.zones,
      flood: layout.flood,
      bands: layout.bands,
      shelters: layout.shelters,
    });
    for (const key of KIND_KEYS) {
      const models = cfg.models[MODEL_KEY[key]] ?? [];
      const mine = specs.filter((s) => s.kind === KIND[key]);
      if (models.length === 0 || mine.length === 0) continue;
      const size = cfg.vehicleSizesM[SIZE_KEY[key]];
      const half: [number, number, number] = [size[0] / 2, size[1] / 2, size[2] / 2];
      for (const spec of mine) {
        const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
        world.createCollider(
          R.ColliderDesc.cuboid(half[0], half[1], half[2]).setTranslation(0, half[1], 0).setFriction(0.2),
          body,
        );
        this.movers.push({ spec, key, body, x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
      }
    }
    this.place(true);
  }

  /** The storm slows the road: every vehicle's clock runs at `mul` times real speed (1 = dry). */
  setWetSpeedMul(mul: number): void {
    this.wetMul = Math.max(0, mul);
  }

  /** Fixed-step update, after `world.step()`. */
  update(dt: number): void {
    this.time += dt * this.wetMul;
    this.place(false);
  }

  dispose(): void {
    for (const mv of this.movers) this.world.removeRigidBody(mv.body);
    this.movers.length = 0;
  }

  /** Dev/e2e: where every ambient vehicle is right now (x, z, kind, along-track t). */
  positions(): { kind: number; x: number; z: number; t: number }[] {
    return this.movers.map((m) => {
      const t = trafficT(m.spec, this.zones, this.path.lengthM, this.time);
      sampleRoad(this.path, t, this.sample);
      const r = rightOfHeading(this.sample.tx, this.sample.tz);
      const d = m.spec.bandM + m.spec.laneM;
      return { kind: m.spec.kind, x: this.sample.x + r.x * d, z: this.sample.z + r.z * d, t };
    });
  }

  /** Along-track t of every vehicle of a kind. */
  tsOfKind(kind: number): number[] {
    return this.movers
      .filter((m) => m.spec.kind === kind)
      .map((m) => trafficT(m.spec, this.zones, this.path.lengthM, this.time));
  }

  private place(initial: boolean): void {
    for (const mv of this.movers) {
      const spec = mv.spec;
      const t = trafficT(spec, this.zones, this.path.lengthM, this.time);
      const s = sampleRoad(this.path, t, this.sample);
      const r = rightOfHeading(s.tx, s.tz);
      const d = spec.bandM + spec.laneM;
      mv.x = s.x + r.x * d;
      mv.z = s.z + r.z * d;
      mv.y = s.y + RACE.track.roadY;
      // Euler (-pitch, yaw, 0) in YXZ order: nose up on a climb.
      const hx = -pitchFromSlope(s.slope) / 2;
      const hy = Math.atan2(s.tx, s.tz) / 2;
      const c1 = Math.cos(hx);
      const s1 = Math.sin(hx);
      const c2 = Math.cos(hy);
      const s2 = Math.sin(hy);
      mv.qx = s1 * c2;
      mv.qy = c1 * s2;
      mv.qz = -s1 * s2;
      mv.qw = c1 * c2;
      this.kinPos.x = mv.x;
      this.kinPos.y = mv.y;
      this.kinPos.z = mv.z;
      this.kinRot.x = mv.qx;
      this.kinRot.y = mv.qy;
      this.kinRot.z = mv.qz;
      this.kinRot.w = mv.qw;
      if (initial) {
        mv.body.setTranslation(this.kinPos, true);
        mv.body.setRotation(this.kinRot, true);
      }
      mv.body.setNextKinematicTranslation(this.kinPos);
      mv.body.setNextKinematicRotation(this.kinRot);
    }
  }
}
