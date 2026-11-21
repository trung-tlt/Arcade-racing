import type RAPIER from '@dimforge/rapier3d-compat';
import { RACE, type TrackDef } from '../core/Data';
import type { TrackPath } from '../world/TrackPath';
import {
  STACKER_HALF,
  TRUCK_HALF,
  catLaiRaw,
  stackerCrossings,
  stackerPose,
  yardTruckT,
  type Crossing,
  type StackerPose,
} from './catLaiTrafficCommon';

type Rapier = typeof RAPIER;

export interface YardMover {
  body: RAPIER.RigidBody;
  x: number;
  z: number;
  yaw: number;
}

/**
 * The physics half of Cat Lai's yard traffic: reach stackers shuttling across the Reefer lane and oncoming yard trucks.
 * Kinematic cuboids, no meshes, so the server builds it too. `CatLaiQuay` (browser) draws from `stackers`/`trucks`.
 */
export class CatLaiYardSim {
  readonly crossings: Crossing[];
  readonly stackers: YardMover[] = [];
  /** Indexed by truck number k = 0..n-1 (the browser's blue trucks are the even k, red the odd). */
  readonly trucks: YardMover[] = [];
  time = 0;
  private readonly laneM: number;
  private readonly sp: StackerPose = { x: 0, z: 0, yaw: 0 };
  private readonly kinPos = { x: 0, y: RACE.track.roadY, z: 0 };
  private readonly kinRot = { x: 0, y: 0, z: 0, w: 1 };

  constructor(
    R: Rapier,
    private readonly world: RAPIER.World,
    track: TrackDef,
    private readonly path: TrackPath,
  ) {
    const raw = catLaiRaw(track);
    this.crossings = stackerCrossings(track, path, raw.yardTraffic.reachStackers.count);
    for (let i = 0; i < this.crossings.length; i++) this.stackers.push(this.mover(R, STACKER_HALF));
    for (let k = 0; k < raw.yardTraffic.trucks; k++) this.trucks.push(this.mover(R, TRUCK_HALF));
    // Hug the left wall: the racers' centre line (and a 3.5 m wide APC) must stay clear.
    this.laneM = raw.roadLayout.yardLanes.widthM / 2 - TRUCK_HALF[0] - 0.35;
    this.place(true);
  }

  update(dt: number): void {
    this.time += dt;
    this.place(false);
  }

  dispose(): void {
    for (const m of [...this.stackers, ...this.trucks]) this.world.removeRigidBody(m.body);
    this.stackers.length = 0;
    this.trucks.length = 0;
  }

  private mover(R: Rapier, half: [number, number, number]): YardMover {
    const body = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
    this.world.createCollider(
      R.ColliderDesc.cuboid(half[0], half[1], half[2]).setTranslation(0, half[1], 0).setFriction(0.2),
      body,
    );
    return { body, x: 0, z: 0, yaw: 0 };
  }

  private move(m: YardMover, initial: boolean): void {
    this.kinPos.x = m.x;
    this.kinPos.z = m.z;
    this.kinRot.y = Math.sin(m.yaw / 2);
    this.kinRot.w = Math.cos(m.yaw / 2);
    if (initial) {
      m.body.setTranslation(this.kinPos, true);
      m.body.setRotation(this.kinRot, true);
    }
    m.body.setNextKinematicTranslation(this.kinPos);
    m.body.setNextKinematicRotation(this.kinRot);
  }

  private place(initial: boolean): void {
    const t = this.time;
    this.crossings.forEach((c, i) => {
      stackerPose(c, t, this.sp);
      const m = this.stackers[i];
      m.x = this.sp.x;
      m.z = this.sp.z;
      m.yaw = this.sp.yaw;
      this.move(m, initial);
    });
    const n = this.trucks.length;
    this.trucks.forEach((m, k) => {
      const tt = yardTruckT(k, n, t, this.path.lengthM);
      const p = this.path.pointAt(tt);
      const tg = this.path.tangentAt(tt);
      const len = Math.hypot(tg.x, tg.z) || 1;
      const tx = tg.x / len;
      const tz = tg.z / len;
      // Oncoming: they drive against the race, on their own right = the racers' left.
      m.x = p.x + tz * this.laneM;
      m.z = p.z - tx * this.laneM;
      m.yaw = Math.atan2(-tx, -tz);
      this.move(m, initial);
    });
  }
}
