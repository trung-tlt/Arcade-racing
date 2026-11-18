import { AUDIO } from '../core/Data';
import type { AudioBus } from './AudioBus';
import { CrossfadeLoop } from './Loops';
import { engineState } from './Rpm';

export interface DriveAudioState {
  forwardSpeed: number;
  topSpeedMps: number;
  throttle: number;
  brake: number;
  slipDeg: number;
  drifting: boolean;
  nitroActive: boolean;
  airborne: boolean;
  countdown: boolean;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Engine, skid and layered boost/ambience sounds driven from the player's car state. */
export class EngineSound {
  private readonly engine: { src: AudioBufferSourceNode; gain: GainNode } | null;
  private readonly skid: { src: AudioBufferSourceNode; gain: GainNode } | null;
  private readonly layers: Record<keyof typeof AUDIO.layers, CrossfadeLoop>;
  private pitchMul = 1;
  private gear = 1;
  private wasNitro = false;
  private wasDrifting = false;
  private cooldown = { shift: 0, screech: 0, squeal: 0 };

  constructor(private readonly bus: AudioBus) {
    const loop = (file: string): { src: AudioBufferSourceNode; gain: GainNode } | null => {
      const buf = bus.buffer(file);
      if (!buf) return null;
      const gain = bus.ctx.createGain();
      gain.gain.value = 0;
      const src = bus.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain).connect(bus.engine);
      src.start();
      return { src, gain };
    };
    this.engine = loop(AUDIO.engine.file);
    this.skid = loop(AUDIO.skid.file);
    this.layers = {
      idle: new CrossfadeLoop(bus, AUDIO.layers.idle),
      roar: new CrossfadeLoop(bus, AUDIO.layers.roar),
      turbo: new CrossfadeLoop(bus, AUDIO.layers.turbo),
      crackle: new CrossfadeLoop(bus, AUDIO.layers.crackle),
      chatter: new CrossfadeLoop(bus, AUDIO.layers.chatter),
      wind: new CrossfadeLoop(bus, AUDIO.layers.wind),
    };
  }

  update(dt: number, s: DriveAudioState): void {
    const A = AUDIO;
    const T = A.thresholds;
    const speed = Math.abs(s.forwardSpeed);
    const speedFrac = clamp01(speed / s.topSpeedMps);
    const { gear, rpm } = engineState(speed, s.topSpeedMps, A.engine.gears, A.engine.idleRpm, A.engine.gearBaseRpm);
    const now = this.bus.ctx.currentTime;
    for (const k of Object.keys(this.cooldown) as (keyof typeof this.cooldown)[]) {
      this.cooldown[k] = Math.max(0, this.cooldown[k] - dt);
    }

    if (this.engine) {
      this.engine.src.playbackRate.setTargetAtTime(
        (A.engine.rateBase + rpm * A.engine.rateRpm) * this.pitchMul,
        now,
        0.05,
      );
      this.engine.gain.gain.setTargetAtTime(A.engine.gain * (0.45 + 0.55 * s.throttle), now, 0.08);
    }
    if (this.skid) {
      const k = clamp01((s.slipDeg - A.skid.minSlipDeg) / (A.skid.fullSlipDeg - A.skid.minSlipDeg));
      const on = speed > A.skid.minSpeedMps && !s.airborne ? k : 0;
      this.skid.gain.gain.setTargetAtTime(A.skid.gain * on, now, 0.05);
    }

    const L = this.layers;
    L.idle.target = s.countdown ? 1 : clamp01(1 - speed / T.idleFadeSpeedMps);
    L.chatter.target = s.countdown ? 1 : 0;
    L.roar.target = clamp01((speedFrac - T.roarMinSpeedFrac) / (1 - T.roarMinSpeedFrac)) * s.throttle;
    L.turbo.target = s.nitroActive ? 1 : speedFrac > T.turboMinSpeedFrac ? 0.35 * s.throttle : 0;
    const windT = clamp01((speedFrac - T.windMinSpeedFrac) / (1 - T.windMinSpeedFrac));
    L.wind.target = windT * windT; // quadratic: barely there when slow, loud near top speed
    L.crackle.target = s.nitroActive ? 1 : 0;
    for (const l of Object.values(L)) l.update(dt, A.layerRampPerSec);

    if (gear !== this.gear && this.cooldown.shift === 0 && !s.countdown) {
      this.bus.play(A.oneShots.shift);
      this.cooldown.shift = T.shiftCooldownSec;
    }
    this.gear = gear;
    if (s.nitroActive && !this.wasNitro) this.bus.play(A.oneShots.nitro);
    this.wasNitro = s.nitroActive;
    if (s.drifting && !this.wasDrifting && this.cooldown.screech === 0 && !s.airborne) {
      this.bus.play(A.oneShots.screech, 0.95 + Math.random() * 0.1);
      this.cooldown.screech = T.screechCooldownSec;
    }
    this.wasDrifting = s.drifting;
    if (s.brake > 0.8 && s.forwardSpeed > T.squealMinSpeedMps && this.cooldown.squeal === 0) {
      this.bus.play(A.oneShots.squeal);
      this.cooldown.squeal = T.squealCooldownSec;
    }
  }

  /** Engine pitch multiplier for the vehicle type (bike higher, APC lower); see `vehiclePitch` in audio.json. */
  setPitchMul(m: number): void {
    this.pitchMul = m;
  }

  get currentGear(): number {
    return this.gear;
  }

  dispose(): void {
    for (const n of [this.engine, this.skid]) {
      n?.src.stop();
      n?.gain.disconnect();
    }
    for (const l of Object.values(this.layers)) l.dispose();
  }
}
