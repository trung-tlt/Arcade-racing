import type { CarControls } from '../vehicle/CarPhysics';
import { AI, decideFire, newGunnerState, type GunnerState } from './AIGunner';
import type { RacingLine } from './RacingLine';

export interface SelfState {
  x: number;
  z: number;
  yaw: number;
  forwardSpeed: number;
  lateralSpeed: number;
  /** Along-track position. */
  t: number;
  nitroBars: number;
  airborne: boolean;
  /** Integrator says the car is stuck right now (skips the internal timer). */
  stuckHint?: boolean;
  /** Controls are locked (countdown): the driver idles and its timers hold. */
  locked?: boolean;
}

export interface PickupHint {
  x: number;
  z: number;
  type: 'rocket' | 'repair' | 'nitro';
}

export interface OtherCar {
  id: string;
  x: number;
  y: number;
  z: number;
  wrecked: boolean;
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface AIDriverOpts {
  carId: string;
  line: RacingLine;
  laneOffsetM: number;
  /** Along-track stretches too narrow for lane spreading (a gate, a yard lane): the driver holds the centre line there. */
  /** Half width of the carriageway at along-track t: pickups outside it (opposite carriageway, behind a median) are ignored. */
  halfWidthAt?: (t: number) => number;
  centreRanges?: readonly { fromT: number; toT: number }[];
  /** 0..1, scales pace. */
  skill: number;
  topSpeedMps: number;
  self: () => SelfState;
  others: () => readonly OtherCar[];
  pickups: () => readonly PickupHint[];
  /** -1 (far ahead) .. +1 (far behind). */
  rubberBand: () => number;
  rocketAmmo: () => number;
  hullFraction: () => number;
  difficulty?: Difficulty;
  /** cars.json handling rating (1–10); scales the slowest speed the AI will take a hairpin at. Default = reference. */
  handling?: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Small deterministic PRNG (mulberry32) seeded from a string. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pure-pursuit racing-line driver. Produces the same controls shape as the player's input. */
export class AIDriver {
  private readonly rnd: () => number;
  private readonly gunCfg: typeof AI.gunner;
  private readonly gun: GunnerState;
  private readonly skill: number;
  private readonly out: CarControls = {
    throttle: 0,
    brake: 0,
    steer: 0,
    drift: false,
    nitro: false,
    fire: false,
    fireSecondary: false,
  };
  private offset: number;
  private noise = 0;
  private noiseLeft = 0;
  private nitroOn = false;
  private stuckFor = 0;
  private reverseLeft = 0;
  private hasMoved = false;

  constructor(private readonly o: AIDriverOpts) {
    const d = AI.difficulty[o.difficulty ?? (AI.difficulty.default as Difficulty)];
    this.rnd = seeded(o.carId);
    this.skill = o.skill * d.skillMul;
    this.gunCfg = { ...AI.gunner, reactionSec: AI.gunner.reactionSec * d.reactionMul };
    this.gun = newGunnerState(this.gunCfg);
    this.offset = o.laneOffsetM;
  }

  read(): CarControls {
    const o = this.o;
    const c = this.out;
    const s = o.self();
    const dt = AI.stepSec;
    c.throttle = c.brake = c.steer = 0;
    c.drift = c.nitro = c.fire = c.fireSecondary = false;
    if (s.locked) return c;

    const v = s.forwardSpeed;
    if (Math.abs(v) > AI.stuck.movedSpeedMps) this.hasMoved = true;

    // --- stuck recovery: reverse out, then carry on ---
    if (this.reverseLeft > 0) {
      this.reverseLeft -= dt;
      const tgt = o.line.targetPoint(s.t, AI.steering.lookaheadBaseM * 2, 0);
      c.brake = 1; // brake at standstill = reverse
      c.steer = clamp(this.headingError(s, tgt) * AI.steering.gain, -1, 1); // steering inverts in reverse
      return c;
    }
    const slow = Math.abs(v) < AI.stuck.speedBelowMps && !s.airborne;
    this.stuckFor = s.stuckHint || (slow && this.hasMoved) ? this.stuckFor + dt : 0;
    if (s.stuckHint || this.stuckFor > AI.stuck.afterSec) {
      this.stuckFor = 0;
      this.reverseLeft = AI.stuck.reverseSec;
    }

    // --- lateral target: lane + noise + pickup detour + gentle avoidance ---
    this.noiseLeft -= dt;
    if (this.noiseLeft <= 0) {
      this.noiseLeft = AI.offset.noiseEverySec * (0.5 + this.rnd());
      this.noise = (this.rnd() * 2 - 1) * AI.offset.noiseM;
    }
    const centred = o.centreRanges?.some((r) => s.t >= r.fromT && s.t <= r.toT) ?? false;
    let want = centred ? 0 : o.laneOffsetM + this.noise;
    const pk = centred ? null : this.pickupOffset(s, want);
    if (pk !== null) want = pk;
    if (!centred) want += this.avoidNudge(s);
    want = clamp(want, -AI.maxOffsetM, AI.maxOffsetM);
    this.offset += clamp(want - this.offset, -AI.offset.ratePerSec * dt, AI.offset.ratePerSec * dt);

    // --- steering ---
    let look = clamp(
      AI.steering.lookaheadBaseM + AI.steering.lookaheadPerMps * Math.abs(v),
      AI.steering.lookaheadBaseM,
      AI.steering.lookaheadMaxM,
    );
    // Never aim further ahead than a fraction of the local turn radius: a long lookahead cuts straight across a hairpin.
    const kAhead = Math.max(
      Math.abs(o.line.curvatureAt(s.t)),
      Math.abs(o.line.curvatureAt(s.t + (look * 0.5) / o.line.lengthM)),
      Math.abs(o.line.curvatureAt(s.t + look / o.line.lengthM)),
    );
    if (kAhead > 1e-4) look = clamp((1 / kAhead) * AI.steering.radiusLookFrac, AI.steering.lookaheadMinM, look);
    const tgt = o.line.targetPoint(s.t, look, this.offset);
    c.steer = clamp(-this.headingError(s, tgt) * AI.steering.gain, -1, 1);

    // --- speed ---
    const rb = o.rubberBand();
    const pace = this.skill * (1 + (rb > 0 ? rb * AI.rubberBand.maxBoost : rb * AI.rubberBand.maxPenalty));
    const ahead = AI.speed.cornerLookaheadBaseM + AI.speed.cornerLookaheadPerMps * Math.abs(v);
    const corner = o.line.maxCornerSpeed(s.t, ahead, AI.speed.maxLatAccelMps2);
    const straight = corner > Math.abs(v) * 1.3 && Math.abs(c.steer) < AI.nitro.maxSteerAbs;

    // Nitro: start with a full bar on a straight, keep going until empty or a turn.
    if (!s.airborne) {
      if (this.nitroOn) this.nitroOn = s.nitroBars > 0.02 && straight;
      else this.nitroOn = s.nitroBars >= AI.nitro.minBars && straight && v > AI.nitro.minSpeedMps;
    } else this.nitroOn = false;
    c.nitro = this.nitroOn;

    const top = o.topSpeedMps * (this.nitroOn ? AI.nitro.speedMul : 1);
    // Low-handling vehicles (heavy, long) need a lower floor to get round a tight hairpin without running wide.
    const hr = Math.min(1, (o.handling ?? AI.speed.handlingRef) / AI.speed.handlingRef);
    const floor = Math.max(AI.speed.absoluteMinMps, AI.speed.minTargetMps * hr * hr);
    const target = Math.max(floor, pace * Math.min(top, corner));
    if (v < target) c.throttle = clamp((target - v) / AI.speed.throttleSlackMps, 0, 1);
    if (v > target + AI.speed.brakeOverMps) {
      c.brake = clamp(
        (v - target - AI.speed.brakeOverMps) / (AI.speed.brakeFullOverMps - AI.speed.brakeOverMps),
        AI.speed.brakeMin,
        1,
      );
      c.throttle = 0;
    }

    // --- guns ---
    if (!s.airborne) {
      const f = decideFire(
        { x: s.x, y: AI.gunner.selfHeightM, z: s.z, yaw: s.yaw },
        o.others(),
        o.rocketAmmo(),
        this.gunCfg,
        this.gun,
        dt,
        this.rnd,
      );
      c.fire = f.fire;
      c.fireSecondary = f.fireSecondary;
    }
    return c;
  }

  /** Signed angle (rad) from the car's heading to a world point; + = point is to the left. */
  private headingError(s: SelfState, p: { x: number; z: number }): number {
    const e = Math.atan2(p.x - s.x, p.z - s.z) - s.yaw;
    return Math.atan2(Math.sin(e), Math.cos(e));
  }

  /** Lane offset that picks up the nearest worthwhile pickup ahead, or null. */
  private pickupOffset(s: SelfState, current: number): number | null {
    const P = AI.pickups;
    const fx = Math.sin(s.yaw);
    const fz = Math.cos(s.yaw);
    let best: { ahead: number; lateral: number } | null = null;
    for (const p of this.o.pickups()) {
      if (p.type === 'repair' && this.o.hullFraction() >= P.repairBelowHull) continue;
      const ahead = (p.x - s.x) * fx + (p.z - s.z) * fz;
      if (ahead < P.minAheadM || ahead > P.lookaheadM) continue;
      // Pickup position relative to the centreline point at the same distance ahead.
      const c = this.o.line.targetPoint(s.t, ahead, 0);
      const lateral = (p.x - c.x) * fz - (p.z - c.z) * fx; // left of the heading = (fz, -fx)
      if (Math.abs(lateral - current) > P.detourM) continue;
      if (this.o.halfWidthAt && Math.abs(lateral) > this.o.halfWidthAt(s.t) - P.edgeMarginM) continue;
      if (!best || ahead < best.ahead) best = { ahead, lateral };
    }
    return best ? best.lateral : null;
  }

  /** Small sideways nudge away from a car sitting right in front of us. */
  private avoidNudge(s: SelfState): number {
    const A = AI.avoid;
    const fx = Math.sin(s.yaw);
    const fz = Math.cos(s.yaw);
    for (const car of this.o.others()) {
      if (car.wrecked || car.id === this.o.carId) continue;
      const dx = car.x - s.x;
      const dz = car.z - s.z;
      const ahead = dx * fx + dz * fz;
      const side = dx * fz - dz * fx; // + = other car is to our left
      if (ahead > 2 && ahead < A.aheadM && Math.abs(side) < A.widthM) return side >= 0 ? -A.nudgeM : A.nudgeM;
    }
    return 0;
  }
}
