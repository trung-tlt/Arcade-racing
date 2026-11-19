import { AUDIO } from '../core/Data';

export interface ClipDef {
  file: string;
  gain: number;
  start?: number;
  dur?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** Owns the AudioContext, master gain and decoded buffers. Browsers start the context suspended until a gesture. */
export class AudioBus {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  /** One-shots and event sounds. */
  readonly sfx: GainNode;
  /** Engine, skid and layered loops. */
  readonly engine: GainNode;
  /** Wet send for tunnels and underpasses; silent until `setReverb` raises it. */
  private readonly wet: GainNode;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly onGesture = (): void => {
    void this.ctx.resume();
  };

  private constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = AUDIO.master;
    this.master.connect(this.ctx.destination);
    this.sfx = this.ctx.createGain();
    this.engine = this.ctx.createGain();
    this.sfx.connect(this.master);
    this.engine.connect(this.master);
    // Synthetic impulse: decaying noise, different per channel.
    const len = Math.floor(this.ctx.sampleRate * AUDIO.reverb.decaySec);
    const ir = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    const conv = this.ctx.createConvolver();
    conv.buffer = ir;
    this.wet = this.ctx.createGain();
    this.wet.gain.value = 0;
    this.sfx.connect(conv);
    this.engine.connect(conv);
    conv.connect(this.wet).connect(this.master);
    for (const ev of ['keydown', 'pointerdown', 'mousedown']) window.addEventListener(ev, this.onGesture);
  }

  /** Loads and decodes every file once. A file that fails to load is skipped (silent) with a warning. */
  static async load(files: readonly string[]): Promise<AudioBus> {
    const bus = new AudioBus();
    await Promise.all(
      [...new Set(files)].map(async (f) => {
        try {
          const res = await fetch(`/assets/${f}`);
          if (!res.ok) throw new Error(`${res.status}`);
          bus.buffers.set(f, await bus.ctx.decodeAudioData(await res.arrayBuffer()));
        } catch (e) {
          console.warn(`audio: could not load ${f}`, e);
        }
      }),
    );
    return bus;
  }

  /** Volumes are 0..1: `master` scales everything, `effects` the one-shots, `engine` the loops. */
  setVolumes(master: number, effects: number, engine: number): void {
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(AUDIO.master * master, t, 0.03);
    this.sfx.gain.setTargetAtTime(effects, t, 0.03);
    this.engine.gain.setTargetAtTime(engine, t, 0.03);
  }

  /** 0 = dry, 1 = full tunnel reverb. */
  setReverb(amount: number): void {
    this.wet.gain.setTargetAtTime(amount * AUDIO.reverb.wet, this.ctx.currentTime, AUDIO.reverb.fadeSec);
  }

  /**
   * A looping clip (rain ambience) on the effects bus. Returns null when the file is not loaded. `setLevel` eases the
   * volume (0..1 × the clip's gain) so intensity changes and bridge muting never click.
   */
  loop(file: string, gain: number): { setLevel(level: number, rampSec?: number): void; stop(): void } | null {
    const buf = this.buffers.get(file);
    if (!buf) return null;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.connect(this.sfx);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(g);
    src.start();
    return {
      setLevel: (level, rampSec = 0.2) => g.gain.setTargetAtTime(level * gain, this.ctx.currentTime, rampSec / 3),
      stop: () => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        src.disconnect();
        g.disconnect();
      },
    };
  }

  suspend(): void {
    void this.ctx.suspend();
  }

  resume(): void {
    void this.ctx.resume();
  }

  buffer(file: string): AudioBuffer | undefined {
    return this.buffers.get(file);
  }

  /** Fire-and-forget clip with a fade in/out envelope. `rate` and `gainMul` vary repeats. */
  play(c: ClipDef, rate = 1, gainMul = 1): void {
    const buf = this.buffers.get(c.file);
    if (!buf || this.ctx.state !== 'running') return;
    const start = c.start ?? 0;
    const dur = Math.min(c.dur ?? buf.duration - start, buf.duration - start);
    const now = this.ctx.currentTime;
    const fin = c.fadeIn ?? 0.005;
    const fout = Math.min(c.fadeOut ?? 0.02, dur);
    const g = this.ctx.createGain();
    const peak = c.gain * gainMul;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + fin);
    g.gain.setValueAtTime(peak, now + Math.max(fin, dur / rate - fout));
    g.gain.linearRampToValueAtTime(0, now + dur / rate);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(g).connect(this.sfx);
    src.start(now, start, dur);
    src.onended = () => g.disconnect();
  }

  dispose(): void {
    for (const ev of ['keydown', 'pointerdown', 'mousedown']) window.removeEventListener(ev, this.onGesture);
    void this.ctx.close();
  }
}
