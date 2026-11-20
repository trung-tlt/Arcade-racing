import * as THREE from 'three';
import { FPV, type CarDef } from '../core/Data';
import { userSettings } from '../core/Settings';
import type { CameraView } from '../core/ViewState';
import type { ChaseCamera } from './ChaseCamera';
import type { CarPhysics } from './CarPhysics';
import { FpvShake, HeadMotion, fpvFov, follow, shakeFor, type FpvFeel } from './FpvMath';

const FEEL = FPV as unknown as FpvFeel;
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpE = new THREE.Euler();
const posNow = new THREE.Vector3();
const quatNow = new THREE.Quaternion();

export interface ViewFrame {
  dt: number;
  /** Render-interpolated pose of the player's car (no bike lean). */
  carPos: THREE.Vector3;
  carQuat: THREE.Quaternion;
  carYaw: number;
  physics: CarPhysics;
  steer: number;
  lookBack: boolean;
  /** No head motion or shake: Reduce motion, or the Low preset. */
  calm: boolean;
}

/** World → screen pixels for a point in front of the camera; `null` when it is behind it. */
export function projectToScreen(
  camera: THREE.Camera,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } | null {
  tmpV.set(x, y, z).project(camera);
  if (tmpV.z > 1 || tmpV.z < -1) return null;
  out.x = (tmpV.x * 0.5 + 0.5) * width;
  out.y = (-tmpV.y * 0.5 + 0.5) * height;
  return out;
}

/**
 * Drives the one render camera: the chase camera as before, or the driver's eye (hood, cockpit, helmet) with head lag,
 * lean, dip, look-to-apex, look-back, shake and a nitro FOV kick. Changing view eases the pose over a fraction of a
 * second. The cockpit rig is drawn from the head pose exposed here, so the two stay locked together.
 */
export class ViewCamera {
  readonly head = new HeadMotion();
  private readonly shake = new FpvShake();
  private view: CameraView = 'chase';
  private blend = 1;
  private readonly fromPos = new THREE.Vector3();
  private readonly fromQuat = new THREE.Quaternion();
  private fromFov = 70;
  private nitro = 0;
  /** Head pose for the cockpit camera (cabin space) after the last update. */
  readonly pose = { x: 0, y: 0, z: 0, yaw: 0, roll: 0, pitch: 0 };
  fov = 70;

  constructor(
    private readonly chase: ChaseCamera,
    private readonly def: CarDef,
  ) {}

  get current(): CameraView {
    return this.view;
  }

  /** 0..1 progress of the last change of view. */
  get blendAmount(): number {
    return this.blend;
  }

  /** True once the camera has settled into the cockpit view enough for the rig to show. */
  get cockpitVisible(): boolean {
    return (
      this.view === 'cockpit' &&
      this.def.fpv?.mode === 'cockpit' &&
      this.blend >= FPV.cockpitShowAt &&
      this.head.lookBackAmount < 0.5
    );
  }

  setView(v: CameraView): void {
    if (v === this.view) return;
    this.fromPos.copy(this.chase.camera.position);
    this.fromQuat.copy(this.chase.camera.quaternion);
    this.fromFov = this.chase.camera.fov;
    this.view = v;
    this.blend = 0;
    this.head.reset();
    if (v === 'chase') this.chase.snap();
  }

  /** A gameplay shake event: bullets rattle, rockets and wrecks slam. */
  addShake(amount: number): void {
    if (this.view === 'chase') return;
    const k = shakeFor(amount, FPV.shake.rocketMinAmount);
    this.shake.kick(FPV.shake[k].sec, FPV.shake[k].deg);
  }

  snap(): void {
    this.head.reset();
    this.chase.snap();
  }

  /** Where the eye is in car space for this view. */
  eyeOf(view: CameraView, out: THREE.Vector3): THREE.Vector3 {
    const d = this.def;
    if (view === 'cockpit' && d.fpv) return out.set(d.fpv.eye[0], d.fpv.eye[1], d.fpv.eye[2]);
    const c = d.collider;
    const h = FPV.hood;
    return out.set(
      0,
      Math.max(h.minHeightM, c.center[1] + c.halfExtents[1] + h.aboveRoofM),
      c.center[2] + c.halfExtents[2] - h.forwardInsetM,
    );
  }

  update(f: ViewFrame): void {
    const cam = this.chase.camera;
    if (this.view === 'chase') {
      this.chase.update(f.dt, f.carPos, f.carYaw, f.physics);
      this.setProjection(cam, undefined, FPV.near.world);
    } else {
      this.updateEye(f, cam);
    }
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + f.dt / FPV.transitionSec);
      const e = this.blend * this.blend * (3 - 2 * this.blend);
      posNow.copy(cam.position);
      quatNow.copy(cam.quaternion);
      cam.position.lerpVectors(this.fromPos, posNow, e);
      cam.quaternion.slerpQuaternions(this.fromQuat, quatNow, e);
      const goal = cam.fov;
      this.setProjection(cam, this.fromFov + (goal - this.fromFov) * e, cam.near);
    }
  }

  private updateEye(f: ViewFrame, cam: THREE.PerspectiveCamera): void {
    const p = f.physics;
    const w = p.body.angvel();
    const lv = p.body.linvel();
    this.head.update(f.dt, FEEL, {
      lateralAccel: p.forwardSpeed * w.y,
      vy: lv.y,
      steer: -f.steer,
      lookBack: f.lookBack,
      bikeLeanRad: this.def.vehicleType === 'bike' ? p.leanRad : 0,
      calm: f.calm,
    });
    const s = f.calm ? { x: 0, y: 0 } : this.shake.step(f.dt, () => Math.random() * 2 - 1);
    this.pose.x = this.head.offset.x;
    this.pose.y = this.head.offset.y;
    this.pose.z = this.head.offset.z;
    this.pose.yaw = this.head.yaw + s.x;
    // The rig sits low in the frame: tip the view down a little so the dash and wheel are not cropped.
    this.pose.pitch =
      s.y -
      (this.def.fpv?.mode === 'cockpit' && this.view === 'cockpit' ? FPV.cockpitPitchDownDeg * (Math.PI / 180) : 0);
    this.pose.roll = this.head.roll;

    // World pose: the eye plus the head's offset, turned by the car and then by the head.
    this.eyeOf(this.view, posNow);
    tmpV.set(this.pose.x, this.pose.y, this.pose.z).add(posNow);
    cam.position.copy(tmpV).applyQuaternion(f.carQuat).add(f.carPos);
    tmpE.set(this.pose.pitch, this.pose.yaw + Math.PI, -this.pose.roll, 'YXZ');
    tmpQ.setFromEuler(tmpE);
    cam.quaternion.copy(f.carQuat).multiply(tmpQ);

    const wantKick = f.physics.nitroActive && userSettings.fovKick ? 1 : 0;
    this.nitro += (wantKick - this.nitro) * follow(f.dt, FEEL.fov.nitroLerpSec);
    this.fov = fpvFov(this.view, this.def, FEEL, this.nitro);
    const near = this.view === 'cockpit' && this.def.fpv?.mode === 'helmet' ? FPV.near.helmet : FPV.near.world;
    this.setProjection(cam, this.fov, near);
  }

  private setProjection(cam: THREE.PerspectiveCamera, fov: number | undefined, near: number): void {
    if ((fov !== undefined && Math.abs(cam.fov - fov) > 0.01) || cam.near !== near) {
      if (fov !== undefined) cam.fov = fov;
      cam.near = near;
      cam.updateProjectionMatrix();
    }
  }
}
