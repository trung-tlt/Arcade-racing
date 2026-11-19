import { AUDIO } from '../core/Data';
import type { AudioBus } from '../audio/AudioBus';
import { type CoverBox, coverFactor } from './cover';

/** The storm's sound: a rain loop whose level follows the intensity (quieter under a deck), thunder and splashes. */
export class WeatherAudio {
  private readonly loop: { setLevel(level: number, rampSec?: number): void; stop(): void } | null;
  private lastLevel = -1;

  constructor(
    private readonly bus: AudioBus | null,
    private readonly covers: readonly CoverBox[],
    private readonly underMute: number,
    private readonly volumeFromIntensity: boolean,
  ) {
    const c = AUDIO.weather.rainLoop;
    this.loop = bus?.loop(c.file, c.gain) ?? null;
  }

  update(intensity: number, x: number, y: number, z: number): void {
    if (!this.loop) return;
    const base = this.volumeFromIntensity ? intensity : 1;
    const level = base * coverFactor(this.covers, x, y, z, this.underMute);
    if (Math.abs(level - this.lastLevel) < 0.01) return;
    this.lastLevel = level;
    this.loop.setLevel(level, 1 / AUDIO.weather.rainFadePerSec);
  }

  thunder(): void {
    this.bus?.play(AUDIO.weather.thunder, 0.92 + Math.random() * 0.16);
  }

  /** `near` is 0..1 (1 = right next to the listener). */
  splash(near: number): void {
    if (near > 0.02) this.bus?.play(AUDIO.weather.splash, 0.9 + Math.random() * 0.25, near);
  }

  dispose(): void {
    this.loop?.stop();
  }
}
