import type { AudioBus } from './AudioBus';

export interface LayerDef {
  file: string;
  gain: number;
  start: number;
  end: number;
  fade: number;
}

/**
 * Loops a region of a non-seamless clip by overlapping segments with crossfades,
 * so there is no click at the loop point. Volume is set with `target` and smoothed.
 */
export class CrossfadeLoop {
  private readonly out: GainNode;
  private nextAt = 0;
  private level = 0;
  target = 0;

  constructor(
    private readonly bus: AudioBus,
    private readonly def: LayerDef,
  ) {
    this.out = bus.ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(bus.engine);
  }

  /** Call every frame: keeps ~1 s of segments scheduled and eases the level toward `target`. */
  update(dt: number, rampPerSec: number): void {
    const ctx = this.bus.ctx;
    const buf = this.bus.buffer(this.def.file);
    if (!buf || ctx.state !== 'running') return;
    const d = this.target - this.level;
    this.level += Math.sign(d) * Math.min(Math.abs(d), rampPerSec * dt);
    this.out.gain.value = this.level * this.def.gain;
    if (this.level <= 0.001 && this.target <= 0.001) {
      this.nextAt = 0; // silent: let it restart cleanly next time
      return;
    }
    const len = Math.min(this.def.end, buf.duration) - this.def.start;
    const fade = Math.min(this.def.fade, len / 2);
    if (this.nextAt < ctx.currentTime) this.nextAt = ctx.currentTime;
    while (this.nextAt < ctx.currentTime + 1) {
      const g = ctx.createGain();
      const t0 = this.nextAt;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(1, t0 + fade);
      g.gain.setValueAtTime(1, t0 + len - fade);
      g.gain.linearRampToValueAtTime(0, t0 + len);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(g).connect(this.out);
      src.start(t0, this.def.start, len);
      src.onended = () => g.disconnect();
      this.nextAt += len - fade;
    }
  }

  dispose(): void {
    this.out.disconnect();
  }
}
