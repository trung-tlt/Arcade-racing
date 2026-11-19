import { AUDIO } from '../core/Data';
import type { EventBus, Vec3 } from '../core/Events';
import type { AudioBus } from './AudioBus';

/** Event-driven one-shots: checkpoints, impacts, countdown. Returns an unsubscribe function. */
export function bindSfx(bus: AudioBus, events: EventBus, listener: () => Vec3): () => void {
  const O = AUDIO.oneShots;
  let lastImpact = -1;
  /** Linear distance falloff; 0 beyond soundRangeM. */
  const near = (p: Vec3): number => {
    const l = listener();
    const d = Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z);
    return Math.max(0, 1 - d / AUDIO.thresholds.soundRangeM);
  };
  const play = (c: (typeof O)[keyof typeof O], p: Vec3, rate = 1): void => {
    const g = near(p);
    if (g > 0.02) bus.play(c, rate, g);
  };
  const offs = [
    events.on('gunFired', (e) => play(O.mgShot, e.pos, 0.95 + Math.random() * 0.1)),
    events.on('gunOverheated', (e) => play(O.overheat, e.pos)),
    events.on('rocketLaunched', (e) => play(O.rocketLaunch, e.pos)),
    events.on('explosion', (e) => play(O.explosion, e.pos)),
    events.on('pickupTaken', (e) => play(O.pickup, e.pos)),
    events.on('checkpoint', () => bus.play(O.checkpoint)),
    events.on('lapComplete', () => bus.play(O.checkpoint, 1.25)),
    events.on('carImpact', (e) => {
      const now = bus.ctx.currentTime;
      if (now - lastImpact < AUDIO.thresholds.impactCooldownSec) return;
      lastImpact = now;
      const loud = Math.min(1, e.strength / 25);
      bus.play(O.impact, 0.9 + Math.random() * 0.2, 0.4 + 0.6 * loud);
      bus.play(O.hitMetal, 0.9 + Math.random() * 0.2, 0.4 + 0.6 * loud);
    }),
  ];
  return () => offs.forEach((off) => off());
}

/** Countdown beeps (3,2,1) and the GO sound + launch whoosh. Call whenever the countdown value changes. */
export function playCountdown(bus: AudioBus, value: number): void {
  if (value > 0) bus.play(AUDIO.oneShots.countdownBeep);
  else {
    bus.play(AUDIO.oneShots.countdownGo);
    bus.play(AUDIO.oneShots.launch);
  }
}

export function sfxFiles(): string[] {
  return [
    AUDIO.engine.file,
    AUDIO.skid.file,
    ...Object.values(AUDIO.layers).map((l) => l.file),
    ...Object.values(AUDIO.oneShots).map((o) => o.file),
    AUDIO.weather.rainLoop.file,
    AUDIO.weather.thunder.file,
    AUDIO.weather.splash.file,
  ];
}
