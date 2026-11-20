import type RAPIER from '@dimforge/rapier3d-compat';
import type { CarDef, HandlingDef } from '../core/Data';
import { NitroTank, slipAngleDeg } from './Nitro';
import { downforceN, openWheelGripMul } from './OpenWheel';

type Rapier = typeof RAPIER;

/** Same shape for player input and AI. steer: -1 = left, +1 = right. */
export interface CarControls {
  throttle: number;
  brake: number;
  steer: number;
  drift: boolean;
  nitro: boolean;
  fire: boolean;
  fireSecondary: boolean;
}

export const IDLE_CONTROLS: Readonly<CarControls> = {
  throttle: 0,
  brake: 0,
  steer: 0,
  drift: false,
  nitro: false,
  fire: false,
  fireSecondary: false,
};

export interface WheelState {
  suspensionLength: number;
  steerAngle: number;
  inContact: boolean;
}

/** One raycast wheel of the physics vehicle. Bikes use 4 virtual wheels that drive the 2 visual wheel nodes. */
export interface WheelLayout {
  /** Unique physics wheel name. */
  name: string;
  /** The cars.json wheel node this physics wheel drives (e.g. 'wheel_FL', or 'wheel_F' for a bike). */
  visual: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Multiplier on the steering angle (0 = fixed wheel). */
  steerScale: number;
  rear: boolean;
  virtual: boolean;
}

/** Builds the physics wheel list for a vehicle from cars.json + handling.json. Pure: unit-testable. */
export function buildWheelLayout(def: CarDef, h: HandlingDef): WheelLayout[] {
  if (def.vehicleType === 'bike') {
    const f = def.wheels.find((w) => w.name === 'wheel_F');
    const r = def.wheels.find((w) => w.name === 'wheel_R');
    if (!f || !r) throw new Error(`${def.id}: bike needs wheel_F and wheel_R in cars.json`);
    const half = h.bike.wheelHalfSpacingM;
    const mk = (w: typeof f, side: 'L' | 'R', front: boolean): WheelLayout => ({
      name: `${w.name}_${side}`,
      visual: w.name,
      x: side === 'L' ? half : -half, // +X is the vehicle's left
      y: w.y,
      z: w.z,
      radius: w.radius,
      steerScale: front ? 1 : 0,
      rear: !front,
      virtual: true,
    });
    return [mk(f, 'L', true), mk(f, 'R', true), mk(r, 'L', false), mk(r, 'R', false)];
  }
  return def.wheels.map((w) => {
    const axle2 = def.vehicleType === 'apc8x8' && /^wheel_2/.test(w.name);
    return {
      name: w.name,
      visual: w.name,
      x: w.x,
      y: w.y,
      z: w.z,
      radius: w.radius,
      steerScale: w.steer ? (axle2 ? h.apc8x8.axle2SteerScale : 1) : 0,
      rear: !w.steer,
      virtual: false,
    };
  });
}

/** Pose snapshot (x,y,z + quaternion x,y,z,w) used for render interpolation. */
export class Pose {
  p = { x: 0, y: 0, z: 0 };
  q = { x: 0, y: 0, z: 0, w: 1 };
  copy(o: Pose): void {
    this.p.x = o.p.x;
    this.p.y = o.p.y;
    this.p.z = o.p.z;
    this.q.x = o.q.x;
    this.q.y = o.q.y;
    this.q.z = o.q.z;
    this.q.w = o.q.w;
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const approach = (cur: number, target: number, maxStep: number): number =>
  cur < target ? Math.min(target, cur + maxStep) : Math.max(target, cur - maxStep);

export class CarPhysics {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  private readonly inertiaY: number;
  private readonly inertiaRoll: number;
  private readonly wheelIdx: number[] = [];
  readonly wheelLayout: readonly WheelLayout[];
  private readonly tp: HandlingDef['types']['car'];
  private lean = 0;

  readonly prev = new Pose();
  readonly curr = new Pose();
  readonly wheels: WheelState[] = [];
  readonly nitro: NitroTank;

  /** m/s along the car's nose (negative when reversing). */
  forwardSpeed = 0;
  /** m/s sideways; positive = towards the car's left (+X). */
  lateralSpeed = 0;
  slipDeg = 0;
  drifting = false;
  nitroActive = false;
  braking = false;
  /** Brake force actually requested last step (N, whole car): ramps up with the pedal, drops at once on release. */
  private brakeN = 0;
  airborne = false;
  steerAngle = 0;
  /** Horizontal speed (m/s) lost in the last step; large values mean a crash. */
  impactStrength = 0;
  /**
   * Surface multipliers a map's weather sets every fixed step (1 = dry road: the other maps never touch them).
   * `surfaceGripMul` scales tyre grip, `brakeDistanceMul` lengthens braking distances (a counter-force while braking) and
   * `dragMul` (>1) adds a speed-proportional drag, as in standing water.
   */
  surfaceGripMul = 1;
  brakeDistanceMul = 1;
  dragMul = 1;
  /** Yaw rate (rad/s) added at the next step, then cleared: puddle twitches. */
  private pendingYawKick = 0;
  private lastHSpeed = 0;
  private lastVx = 0;
  private lastVz = 0;
  /** Horizontal velocity at the end of the previous step and of this one (m/s): the hit rules compare them. */
  readonly velBefore = { x: 0, z: 0 };
  readonly velAfter = { x: 0, z: 0 };
  /** Bike only: visual lean about the local +Z axis in radians; positive = leaning to the right. 0 for other vehicles. */
  get leanRad(): number {
    return this.lean;
  }

  /** Bike lean as a fraction of maxLeanDeg, -1..1. */
  get leanFraction(): number {
    const max = this.maxLeanRad;
    return max > 0 ? this.lean / max : 0;
  }

  private get maxLeanRad(): number {
    return this.def.vehicleType === 'bike' ? ((this.def.maxLeanDeg ?? 0) * Math.PI) / 180 : 0;
  }

  get wheelCount(): number {
    return this.wheelLayout.length;
  }

  /** Bars gained from drifting this step (consumed by Car to emit events). */
  driftBarsGained = 0;
  private gripMix = 0;

  constructor(
    R: Rapier,
    private readonly world: RAPIER.World,
    readonly def: CarDef,
    private readonly h: HandlingDef,
    spawn: { x: number; y: number; z: number; yaw: number },
  ) {
    const { halfExtents: he, center } = def.collider;
    this.tp = h.types[def.vehicleType];
    this.wheelLayout = buildWheelLayout(def, h);
    const half = Math.sin(spawn.yaw / 2);
    this.body = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setRotation({ x: 0, y: half, z: 0, w: Math.cos(spawn.yaw / 2) })
        .setLinearDamping(h.body.linearDamping)
        .setAngularDamping(this.tp.angularDamping)
        .setCanSleep(false)
        .setCcdEnabled(true),
    );

    const m = def.massKg;
    const [w, ht, l] = [he[0] * 2, he[1] * 2, he[2] * 2];
    this.inertiaY = (m / 12) * (w * w + l * l);
    this.inertiaRoll = (m / 12) * (w * w + ht * ht) * this.tp.rollInertiaMul;
    this.collider = world.createCollider(
      // Raise the bottom of the box (top stays put) for ramp / kerb clearance: with the suspension sagged a stock
      // box sits ~2 cm above the road and its nose clips any slope before the springs can react.
      R.ColliderDesc.cuboid(he[0], he[1] - h.body.chassisClearanceBoostM / 2, he[2])
        .setTranslation(center[0], center[1] + h.body.chassisClearanceBoostM / 2, center[2])
        .setFriction(0.3)
        .setRestitution(0.1)
        // Low centre of mass keeps the car from rolling over in hard turns.
        .setMassProperties(
          m,
          { x: 0, y: this.tp.comY, z: 0 },
          {
            x: (m / 12) * (ht * ht + l * l) * this.tp.rollInertiaMul,
            y: this.inertiaY,
            z: (m / 12) * (w * w + ht * ht) * this.tp.rollInertiaMul,
          },
          { x: 0, y: 0, z: 0, w: 1 },
        ),
      this.body,
    );

    this.vehicle = world.createVehicleController(this.body);
    this.nitro = new NitroTank(h.nitro.maxBars, h.nitro.minBarsToFire);

    for (const wd of this.wheelLayout) {
      // Connection point sits one rest-length above the hub so the wheel is at the hub when fully extended.
      this.vehicle.addWheel(
        { x: wd.x, y: wd.y + h.suspension.restLength, z: wd.z },
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        h.suspension.restLength,
        wd.radius,
      );
      this.wheelIdx.push(this.wheelIdx.length);
      this.wheels.push({ suspensionLength: h.suspension.restLength, steerAngle: 0, inContact: false });
    }
    this.applyStatic();
    this.readPose(this.curr);
    this.prev.copy(this.curr);
  }

  /** Push live-tunable suspension numbers into the controller (cheap; lets lil-gui edit them). */
  private applyStatic(): void {
    const s = this.h.suspension;
    for (const i of this.wheelIdx) {
      this.vehicle.setWheelSuspensionRestLength(i, s.restLength);
      this.vehicle.setWheelMaxSuspensionTravel(i, s.maxTravel);
      this.vehicle.setWheelSuspensionStiffness(i, s.stiffness);
      this.vehicle.setWheelSuspensionCompression(i, s.compression);
      this.vehicle.setWheelSuspensionRelaxation(i, s.relaxation);
      this.vehicle.setWheelMaxSuspensionForce(i, s.maxForce);
    }
  }

  private readPose(out: Pose): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    out.p.x = t.x;
    out.p.y = t.y;
    out.p.z = t.z;
    out.q.x = r.x;
    out.q.y = r.y;
    out.q.z = r.z;
    out.q.w = r.w;
  }

  /** Queue a one-off yaw-rate change (rad/s, + = turn left); applied at the start of the next step. */
  addYawKick(radS: number): void {
    this.pendingYawKick += radS;
  }

  /** Runs before `world.step()`: converts controls into wheel forces. */
  preStep(dt: number, c: CarControls): void {
    const { h, def } = this;
    this.prev.copy(this.curr);
    this.applyStatic();

    if (this.pendingYawKick !== 0) {
      const w = this.body.angvel();
      this.body.setAngvel({ x: w.x, y: w.y + this.pendingYawKick, z: w.z }, true);
      this.pendingYawKick = 0;
    }
    const q = this.body.rotation();
    const v = this.body.linvel();
    // Local axes from the quaternion: forward = q·(0,0,1), left = q·(1,0,0).
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const lx = 1 - 2 * (q.y * q.y + q.z * q.z);
    const lz = 2 * (q.x * q.z - q.w * q.y);
    this.forwardSpeed = v.x * fx + v.z * fz;
    this.lateralSpeed = v.x * lx + v.z * lz;
    const speed = Math.hypot(v.x, v.z);
    this.slipDeg = slipAngleDeg(this.forwardSpeed, this.lateralSpeed);

    // --- nitro ---
    this.nitroActive = this.nitro.update(c.nitro && c.throttle > 0, dt, def.nitroBarSec);

    // --- drift state ---
    this.drifting =
      (c.drift && speed > h.grip.driftMinSpeedMps && !this.airborne && Math.abs(c.steer) > 0.05) ||
      (c.drift && this.drifting && speed > h.grip.driftMinSpeedMps * 0.6);
    this.driftBarsGained = 0;
    if (this.drifting && this.slipDeg > h.grip.driftMinSlipDeg) {
      this.driftBarsGained = h.nitro.driftBarsPerSec * dt;
      this.nitro.add(this.driftBarsGained);
    }

    // --- engine / brake ---
    const accel = h.engine.baseAccelMps2 + def.accel * h.engine.accelPerRating;
    const fMax = def.massKg * accel * this.tp.engineForceMul;
    const vTop = (def.topSpeedKmh / 3.6) * (this.nitroActive ? 1 + def.nitroBoost : 1);
    const fwd = this.forwardSpeed;
    let engine = 0;
    let brake = 0;
    this.braking = false;
    if (c.throttle > 0.01 && fwd > -1) {
      const rolloff = Math.max(0, 1 - Math.pow(Math.max(0, fwd) / vTop, h.engine.topSpeedRolloffPower));
      engine = c.throttle * fMax * rolloff * (this.nitroActive ? h.engine.nitroForceMul : 1);
      if (this.drifting) engine *= h.engine.handbrakeEngineMul;
    } else if (c.brake > 0.01) {
      if (fwd > 1) {
        brake = c.brake * h.engine.brakeDecelMps2 * def.massKg;
        this.braking = true;
      } else if (fwd > -h.engine.reverseMaxMps) {
        engine = -c.brake * fMax * h.engine.reverseAccelMul;
        this.braking = true;
      }
    } else if (c.throttle > 0.01) {
      brake = c.throttle * h.engine.brakeDecelMps2 * def.massKg; // throttle while rolling backwards
    } else if (Math.abs(fwd) > 0.5) {
      brake = h.engine.coastDecelMps2 * def.massKg;
    }

    // ABS: the pedal ramps in rather than slamming on, and no wheel is braked harder than its tyre can hold at its
    // current load (force = absMu × the wheel's suspension load). A wheel that is light (the tail on a nose-dive) or off the ground gets almost nothing, so hard
    // stops stay straight and flat instead of locking, pitching over or hopping.
    const bk = h.brake;
    const brakeMax = h.engine.brakeDecelMps2 * def.massKg;
    this.brakeN = brake > this.brakeN ? Math.min(brake, this.brakeN + (brakeMax / bk.riseFullSec) * dt) : brake;
    const absMu = bk.absMu * def.grip * (def.vehicleType === 'bike' ? bk.bikeMuMul : 1);

    // --- steering ---
    // Max angle falls with speed² so lateral demand stays inside what the tyres can give.
    const ratio = speed / h.steering.falloffSpeedMps;
    const maxSteer =
      Math.max(h.steering.minAtHighSpeedRad, h.steering.maxAtStandstillRad / (1 + ratio * ratio)) *
      (def.handling / h.steering.handlingRefRating) *
      this.tp.steerMaxMul;
    const target = -c.steer * maxSteer; // +angle = left (+X is left)
    const returning = Math.abs(target) < Math.abs(this.steerAngle) || target * this.steerAngle < 0;
    const rate = returning ? h.steering.returnRatePerSec : h.steering.ratePerSec;
    this.steerAngle = approach(this.steerAngle, target, rate * dt);

    // --- grip (front/rear split lets the tail swing out while drifting) ---
    this.gripMix = approach(this.gripMix, this.drifting ? 1 : 0, h.grip.gripBlendPerSec * dt);
    const baseSlip =
      h.grip.frictionSlip * def.grip * this.tp.frictionMul * this.surfaceGripMul * openWheelGripMul(def, speed, h);
    const rearMul = 1 - h.grip.driftRearGripDrop * def.drift * this.gripMix;
    const frontMul = 1 + (h.grip.driftFrontGripBoost - 1) * this.gripMix;

    const n = this.wheelLayout.length;
    for (let i = 0; i < n; i++) {
      const wl = this.wheelLayout[i];
      const rear = wl.rear;
      this.vehicle.setWheelSteering(i, this.steerAngle * wl.steerScale);
      this.vehicle.setWheelEngineForce(i, engine / n);
      const load = this.vehicle.wheelIsInContact(i) ? (this.vehicle.wheelSuspensionForce(i) ?? 0) : 0;
      // Rapier takes the brake as an impulse (N·s) per step, so force × dt.
      this.vehicle.setWheelBrake(i, Math.min(this.brakeN / n, absMu * load) * dt);
      this.vehicle.setWheelFrictionSlip(i, baseSlip * (rear ? rearMul : frontMul));
      this.vehicle.setWheelSideFrictionStiffness(
        i,
        h.grip.sideFrictionStiffness * this.surfaceGripMul * (rear ? Math.max(0.25, rearMul) : 1),
      );
    }

    // --- bike: visual lean follows steering, scaled by speed ---
    const maxLean = this.maxLeanRad;
    if (maxLean > 0) {
      const speedFactor = clamp(Math.abs(fwd) / h.bike.leanFullSpeedMps, 0, 1);
      const leanTarget = clamp(c.steer, -1, 1) * speedFactor * maxLean;
      this.lean += (leanTarget - this.lean) * (1 - Math.exp(-h.bike.leanRatePerSec * dt));
    }

    // --- extra forces: downforce for stability, yaw assist so drifts rotate the car ---
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.body.addForce(
      {
        x: 0,
        y:
          -h.body.downforcePerSpeedSq * this.tp.downforceMul * speed * speed -
          downforceN(def, speed, h, Math.abs(h.world.gravity)),
        z: 0,
      },
      true,
    );
    if (this.brakeDistanceMul !== 1 && this.braking && fwd > 1) {
      // The brakes saturate on the tyres, so neither brake force nor friction changes the stopping distance; instead
      // push back along the heading by the share of the (measured) braking deceleration that has to go: 1 - 1/mul.
      const k = (1 - 1 / this.brakeDistanceMul) * h.surface.measuredBrakeDecelMps2 * def.massKg;
      this.body.addForce({ x: fx * k, y: 0, z: fz * k }, true);
    }
    if (this.dragMul !== 1) {
      // Standing water: a drag deceleration proportional to speed, scaled by how much the multiplier exceeds 1.
      const k = (this.dragMul - 1) * h.surface.floodDragAccelPerMps * def.massKg;
      this.body.addForce({ x: -v.x * k, y: 0, z: -v.z * k }, true);
    }
    if (this.def.vehicleType === 'bike')
      this.applyRollBalance(
        q,
        fx,
        fz,
        this.h.bike.rollBalanceGain,
        this.h.bike.rollBalanceDamp,
        this.h.bike.rollBalanceMaxAccel,
        0,
      );
    else {
      // Anti-rollover: nothing until the body leans past `startDeg`, then a capped spring/damper back toward upright.
      const a = this.h.rollAssist;
      this.applyRollBalance(q, fx, fz, a.gain, a.damp, a.maxAccel, (a.startDeg * Math.PI) / 180);
    }
    if (this.drifting) {
      // Yaw-rate controller: rotate the nose into the turn, fading out as slip nears its cap so the slide settles.
      const slipFade = clamp(1 - this.slipDeg / h.grip.driftMaxSlipDeg, 0, 1);
      const want = -c.steer * h.grip.driftYawRateRad * slipFade;
      const accelY = clamp(
        h.grip.driftYawGain * (want - this.body.angvel().y),
        -h.grip.driftYawMaxAccel,
        h.grip.driftYawMaxAccel,
      );
      this.body.addTorque({ x: 0, y: accelY * this.inertiaY, z: 0 }, true);
    }

    this.vehicle.updateVehicle(dt);
  }

  /**
   * A bike is balanced by its rider: spring + damper about the forward axis keep the (4-virtual-wheel) body upright.
   * `q` is the body rotation; (fx, fz) the horizontal forward direction.
   */
  private applyRollBalance(
    q: { x: number; y: number; z: number; w: number },
    fx: number,
    fz: number,
    gain: number,
    damp: number,
    maxAccel: number,
    deadZoneRad: number,
  ): void {
    // Body axes in world space: up = q·(0,1,0), left = q·(1,0,0), forward = q·(0,0,1).
    const ux = 2 * (q.x * q.y - q.w * q.z);
    const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
    const uz = 2 * (q.y * q.z + q.w * q.x);
    const fy = 2 * (q.y * q.z - q.w * q.x);
    // Horizontal "left of heading" = up × forward (normalised), so roll is measured against the world, not the body.
    const hl = Math.hypot(fx, fz) || 1;
    const hx = fz / hl;
    const hz = -fx / hl;
    // Roll toward the right (away from the heading's left) is positive.
    const roll = Math.atan2(-(ux * hx + uz * hz), uy);
    const w = this.body.angvel();
    // Positive angular velocity about +forward (right-handed) rolls the top toward −left = right.
    const rollRate = w.x * fx + w.y * fy + w.z * fz;
    const excess = Math.sign(roll) * Math.max(0, Math.abs(roll) - deadZoneRad);
    if (deadZoneRad > 0 && excess === 0) return;
    const accel = clamp(-gain * excess - damp * rollRate, -maxAccel, maxAccel);
    const t = accel * this.inertiaRoll;
    this.body.addTorque({ x: fx * t, y: fy * t, z: fz * t }, true);
  }

  /** Runs after `world.step()`: reads results back for rendering and gameplay. */
  postStep(): void {
    let contacts = 0;
    for (let i = 0; i < this.wheelLayout.length; i++) {
      const w = this.wheels[i];
      w.inContact = this.vehicle.wheelIsInContact(i);
      w.suspensionLength = this.vehicle.wheelSuspensionLength(i) ?? this.h.suspension.restLength;
      w.steerAngle = this.vehicle.wheelSteering(i) ?? 0;
      if (w.inContact) contacts++;
    }
    this.airborne = contacts === 0;
    const v = this.body.linvel();
    const hs = Math.hypot(v.x, v.z);
    this.impactStrength = Math.max(0, this.lastHSpeed - hs);
    // A hard hit (another car's edge, a traffic body) must never throw the car skywards or into a spin: cap what the
    // collision can add vertically and rotationally. Ramp and crest jumps are wheel-driven and not affected.
    if (this.impactStrength > this.h.body.impactClampMinMps) {
      // ...nor press it down through the road (a rival ramming a parked car, or riding over its roof).
      const vy = Math.min(this.h.body.maxUpAfterImpactMps, Math.max(-this.h.body.maxDownAfterImpactMps, v.y));
      if (vy !== v.y) this.body.setLinvel({ x: v.x, y: vy, z: v.z }, true);
      const w = this.body.angvel();
      const spin = Math.hypot(w.x, w.y, w.z);
      const maxSpin = this.h.body.maxSpinAfterImpactRadS;
      if (spin > maxSpin) {
        const k = maxSpin / spin;
        this.body.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, true);
      }
    }
    this.velBefore.x = this.lastVx;
    this.velBefore.z = this.lastVz;
    const v2 = this.body.linvel();
    this.velAfter.x = v2.x;
    this.velAfter.z = v2.z;
    this.lastVx = v2.x;
    this.lastVz = v2.z;
    this.lastHSpeed = hs;
    this.readPose(this.curr);
  }

  /** Scale the horizontal velocity (wall hits: the car keeps `k` of its speed). Vertical velocity is untouched. */
  scaleHorizontalVelocity(k: number): void {
    const v = this.body.linvel();
    this.body.setLinvel({ x: v.x * k, y: v.y, z: v.z * k }, true);
    this.lastVx *= k;
    this.lastVz *= k;
    this.lastHSpeed *= k;
  }

  /** Add to the vertical velocity (m/s): the small hop when a wheel is clipped from the side. */
  hop(dvy: number): void {
    const v = this.body.linvel();
    this.body.setLinvel({ x: v.x, y: v.y + dvy, z: v.z }, true);
  }

  get suspensionRest(): number {
    return this.h.suspension.restLength;
  }

  get speedMps(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  /** Put the car upright on the ground at (x,z) keeping its heading. */
  /** `roadY` is the road height under (x, z); the car is dropped `dropHeightM` above it. */
  reset(x: number, z: number, yaw: number, roadY = 0): void {
    this.body.setTranslation({ x, y: roadY + this.h.reset.dropHeightM, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.lean = 0;
    this.lastHSpeed = 0;
    this.lastVx = 0;
    this.lastVz = 0;
    this.readPose(this.curr);
    this.prev.copy(this.curr);
  }

  /** Current heading (yaw) from the body quaternion. */
  get yaw(): number {
    const q = this.body.rotation();
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
  }

  dispose(): void {
    this.world.removeVehicleController(this.vehicle);
    this.world.removeRigidBody(this.body);
  }
}
