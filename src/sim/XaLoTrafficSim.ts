import type RAPIER from '@dimforge/rapier3d-compat';
import { RACE, type TrackDef } from '../core/Data';
import type { TrackPath } from '../world/TrackPath';
import {
  KIND_KEYS,
  PLAN_SEED,
  SIZE_KEY,
  frontageSection,
  laneOffsetAt,
  pitchFromSlope,
  rightOfHeading,
  roadProfileOf,
  sampleRoad,
  trafficPlan,
  trafficT,
  type KindKey,
  type RawXaLo,
  type RoadProfile,
  type RoadSample,
  type TrafficSpec,
} from './trafficCommon';

type Rapier = typeof RAPIER;

/** One ambient vehicle: its plan, its kinematic body and where it is this step (the browser draws it from `x..qw`). */
export interface TrafficMover {
  spec: TrafficSpec;
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
 * The physics half of Map 3's ambient traffic: kinematic cuboids that follow the 3D racing line. No meshes, so the
 * server builds it too. `XaLoTraffic` (browser) draws from `movers`; both run the same clock.
 */
export class XaLoTrafficSim {
  readonly movers: TrafficMover[] = [];
  /** Kinds in `ambientTraffic` that have no model list (skipped, as in the browser). */
  readonly skippedKinds: KindKey[] = [];
  time = 0;
  private readonly raw: RawXaLo;
  private readonly profile: RoadProfile;
  private readonly section: { fromT: number; toT: number } | null;
  private readonly sample: RoadSample = { x: 0, y: 0, z: 0, tx: 0, tz: 1, slope: 0 };
  private readonly kinPos = { x: 0, y: 0, z: 0 };
  private readonly kinRot = { x: 0, y: 0, z: 0, w: 1 };

  constructor(
    R: Rapier,
    private readonly world: RAPIER.World,
    track: TrackDef,
    private readonly path: TrackPath,
  ) {
    this.raw = track.raw as unknown as RawXaLo;
    this.profile = roadProfileOf(track);
    this.section = frontageSection(this.raw);
    const cfg = this.raw.ambientTraffic;
    for (const key of KIND_KEYS) {
      const count = cfg[key];
      const models = cfg.models[key] ?? [];
      if (models.length === 0) {
        if (count > 0) this.skippedKinds.push(key);
        continue;
      }
      const specs = trafficPlan(key, count, models.length, {
        seed: PLAN_SEED,
        lapLengthM: path.lengthM,
        speedKmh: cfg.speedKmh,
        section: this.section,
      });
      const size = cfg.vehicleSizesM[SIZE_KEY[key]];
      const half: [number, number, number] = [size[0] / 2, size[1] / 2, size[2] / 2];
      for (const spec of specs) {
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

  /** Fixed-step update, after `world.step()`. */
  update(dt: number): void {
    this.time += dt;
    this.place(false);
  }

  dispose(): void {
    for (const mv of this.movers) this.world.removeRigidBody(mv.body);
    this.movers.length = 0;
  }

  /** Move every vehicle to its place for the current clock, riding the road's height and slope. */
  private place(initial: boolean): void {
    for (const mv of this.movers) {
      const spec = mv.spec;
      const t = trafficT(spec, this.time, this.path.lengthM, this.section);
      const s = sampleRoad(this.path, t, this.sample);
      const r = rightOfHeading(s.tx, s.tz);
      const d = laneOffsetAt(this.profile, t, spec.lane) + spec.jitterM;
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
