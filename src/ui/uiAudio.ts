import { UI_SOUNDS } from '../core/Data';
import { onSettingsChange, settings } from '../core/Settings';

/**
 * Menu sound + music: ONE audio system with a UI bus (master × effects) and a music bus (master × music slider),
 * separate from the in-race AudioBus. Browsers keep audio locked until the first input, so `unlock()` is wired to
 * the first key / pointer press at boot; everything before that is a silent no-op.
 *
 * The pure helpers at the top have no AudioContext / DOM dependency and are unit-tested in node.
 */

export type UiEvent = keyof typeof UI_SOUNDS.events;
export type VehicleType = 'car' | 'apc8x8' | 'bike';

export interface UiEventDef {
  file: string;
  volume: number;
  pitchJitter?: number;
  pitchByVehicleType?: Record<VehicleType, number>;
  /** Free-text follow-up from the data file, e.g. "start menu music" or "fade music out over 1.2 s". */
  then?: string;
}

const EVENTS = UI_SOUNDS.events as unknown as Record<string, UiEventDef>;

/** Music is ducked to this fraction on the Pause screen ("PAUSE (ducked to 40%)" in the data file). */
export const DUCK_LEVEL = 0.4;

/** Minimum gap (ms) between two plays of a chatty event, so a held arrow key doesn't machine-gun. */
export const THROTTLE_MS: Partial<Record<UiEvent, number>> = { focus_move: 45, slider_step: 40 };

export function eventDef(ev: string): UiEventDef | null {
  return EVENTS[ev] ?? null;
}

/** Playback rate: per-vehicle pitch × a small random jitter in ±pitchJitter. `rnd` is injectable for tests. */
export function pitchFor(def: UiEventDef, vehicleType?: VehicleType, rnd: () => number = Math.random): number {
  const base = vehicleType ? (def.pitchByVehicleType?.[vehicleType] ?? 1) : 1;
  const j = def.pitchJitter ?? 0;
  return base * (1 + (rnd() * 2 - 1) * j);
}

/** UI bus level: master × effects (the data file's `buses.ui.setting` is "sfx", i.e. the Effects slider). */
export function uiBusVolume(master: number, effects: number): number {
  return clamp01(master) * clamp01(effects);
}

/** Music bus level: master × music slider × the menu loop's own level from the data file. */
export function musicBusVolume(master: number, music: number, loopVolume: number): number {
  return clamp01(master) * clamp01(music) * clamp01(loopVolume);
}

/** Level of one clip before the bus: the event's own `volume`. */
export function clipGain(def: UiEventDef): number {
  return clamp01(def.volume);
}

/** What the music fader should be at: 0 when not wanted or muted, ducked on Pause, else 1. */
export function musicFadeTarget(wanted: boolean, muted: boolean, ducked: boolean): number {
  if (!wanted || muted) return 0;
  return ducked ? DUCK_LEVEL : 1;
}

/** True when enough time passed since the last play of a throttled event (always true for others). */
export function throttleOk(ev: UiEvent, last: number | undefined, now: number): boolean {
  const gap = THROTTLE_MS[ev];
  return gap === undefined || last === undefined || now - last >= gap;
}

export interface ThenAction {
  startMusic: boolean;
  /** Seconds to fade the music out over, or null. */
  fadeOutSec: number | null;
}

/** Reads the data file's free-text `then` field. */
export function parseThen(then: string | undefined): ThenAction {
  if (!then) return { startMusic: false, fadeOutSec: null };
  const fade = /fade music out over\s+([\d.]+)\s*s/i.exec(then);
  return { startMusic: /start menu music/i.test(then), fadeOutSec: fade ? Number(fade[1]) : null };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

export interface UiAudioState {
  unlocked: boolean;
  contextState: string;
  musicWanted: boolean;
  musicPlaying: boolean;
  musicMuted: boolean;
  musicDucked: boolean;
  log: string[];
}

const MUSIC = UI_SOUNDS.music.menu;
/** Fraction of the title sting that plays before the music comes in. */
const STING_OVERLAP = 0.85;

class UiAudio {
  private ctx: AudioContext | null = null;
  private uiBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicFade: GainNode | null = null;
  private musicSrc: AudioBufferSourceNode | null = null;
  private stopTimer = 0;
  private introUntil = 0;
  private offSettings: (() => void) | null = null;
  private removeUnlock: (() => void) | null = null;
  private readonly raw = new Map<string, Promise<ArrayBuffer | null>>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly decoding = new Map<string, Promise<AudioBuffer | null>>();
  private readonly lastPlay = new Map<string, number>();

  unlocked = false;
  musicWanted = false;
  musicMuted = false;
  musicDucked = false;
  readonly debugLog: string[] = [];

  /** Start fetching every file now (no AudioContext needed); decoding waits for the first input. */
  preload(): void {
    for (const def of Object.values(EVENTS)) this.fetchRaw(def.file);
    this.fetchRaw(MUSIC.file);
  }

  /** Attach one-shot listeners that unlock audio on the first key / pointer press. */
  installUnlock(target: Window = window): void {
    if (this.removeUnlock) return;
    const go = (): void => this.unlock();
    const events = ['keydown', 'pointerdown', 'touchstart'] as const;
    for (const e of events) target.addEventListener(e, go, { capture: true, passive: true });
    this.removeUnlock = () => events.forEach((e) => target.removeEventListener(e, go, { capture: true }));
  }

  /** Create / resume the AudioContext. Safe to call any number of times, from any input. */
  unlock(): void {
    if (this.unlocked) {
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.uiBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.musicFade = ctx.createGain();
    this.musicFade.gain.value = 0;
    this.uiBus.connect(ctx.destination);
    this.musicFade.connect(this.musicBus).connect(ctx.destination);
    this.unlocked = true;
    this.retune(true);
    this.offSettings = onSettingsChange(() => this.retune(false));
    void ctx.resume();
    this.removeUnlock?.();
    this.removeUnlock = null;
    for (const def of Object.values(EVENTS)) void this.decode(def.file);
    void this.decode(MUSIC.file);
    if (this.musicWanted) this.startMusic(true); // asked for before the first input
  }

  /** Re-read the volume sliders. */
  private retune(immediate: boolean): void {
    if (!this.ctx || !this.uiBus || !this.musicBus) return;
    const t = this.ctx.currentTime;
    const ui = uiBusVolume(settings.volumeMaster, settings.volumeEffects);
    const music = musicBusVolume(settings.volumeMaster, settings.volumeMusic, MUSIC.volume);
    if (immediate) {
      this.uiBus.gain.value = ui;
      this.musicBus.gain.value = music;
    } else {
      this.uiBus.gain.setTargetAtTime(ui, t, 0.03);
      this.musicBus.gain.setTargetAtTime(music, t, 0.03);
    }
  }

  private fetchRaw(file: string): Promise<ArrayBuffer | null> {
    let p = this.raw.get(file);
    if (!p) {
      p = fetch(`/assets/${file}`)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
      this.raw.set(file, p);
    }
    return p;
  }

  /** Decode a file once. The music loop tries OGG first and falls back to the WAV copy. */
  private decode(file: string): Promise<AudioBuffer | null> {
    const have = this.buffers.get(file);
    if (have) return Promise.resolve(have);
    let p = this.decoding.get(file);
    if (!p) {
      p = this.decodeFile(file).then((b) => {
        if (b) this.buffers.set(file, b);
        return b;
      });
      this.decoding.set(file, p);
    }
    return p;
  }

  private async decodeFile(file: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    const tryDecode = async (f: string): Promise<AudioBuffer | null> => {
      const data = await this.fetchRaw(f);
      if (!data) return null;
      try {
        return await ctx.decodeAudioData(data.slice(0)); // slice: decodeAudioData detaches its input
      } catch {
        return null;
      }
    };
    const first = await tryDecode(file);
    if (first) return first;
    return file === MUSIC.file ? tryDecode(MUSIC.fallback) : null;
  }

  private log(entry: string): void {
    if (this.debugLog.length < 500) this.debugLog.push(entry);
  }

  /** Play a menu sound. Returns its duration in seconds (0 if nothing played). Never throws. */
  play(ev: UiEvent, opts: { vehicleType?: VehicleType } = {}): number {
    const def = eventDef(ev);
    if (!def || !this.unlocked || !this.ctx) return 0;
    const now = performance.now();
    if (!throttleOk(ev, this.lastPlay.get(ev), now)) return 0;
    this.lastPlay.set(ev, now);
    this.log(ev);
    const act = parseThen(def.then);
    if (act.fadeOutSec !== null) this.stopMusic(act.fadeOutSec);

    const buf = this.buffers.get(def.file);
    if (buf) return this.start(def, buf, act, opts.vehicleType);
    // Not decoded yet (first sounds right after the first key): play as soon as it is.
    void this.decode(def.file).then((b) => {
      if (b) this.start(def, b, act, opts.vehicleType);
    });
    return 0;
  }

  private start(def: UiEventDef, buf: AudioBuffer, act: ThenAction, vehicleType?: VehicleType): number {
    const ctx = this.ctx;
    if (!ctx || !this.uiBus) return 0;
    if (ctx.state === 'suspended') void ctx.resume();
    const rate = pitchFor(def, vehicleType);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = clipGain(def);
    src.connect(g).connect(this.uiBus);
    src.onended = () => g.disconnect();
    src.start();
    const dur = buf.duration / rate;
    if (act.startMusic) {
      // "then: start menu music" — the sting plays out first; menu screens must not start the music over it.
      this.introUntil = performance.now() + dur * STING_OVERLAP * 1000;
      window.setTimeout(() => this.startMusic(true), dur * STING_OVERLAP * 1000);
    }
    return dur;
  }

  /** Start (or fade back in) the menu loop. */
  startMusic(force = false): void {
    this.musicWanted = true;
    window.clearTimeout(this.stopTimer);
    if (!this.unlocked || !this.ctx) return;
    if (!force && performance.now() < this.introUntil) return;
    if (this.musicSrc) {
      this.applyMusicLevel(0.8);
      return;
    }
    void this.decode(MUSIC.file).then((buf) => {
      const ctx = this.ctx;
      if (!buf || !ctx || !this.musicFade || !this.musicWanted || this.musicSrc) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true; // gapless: the loop is authored to repeat seamlessly
      src.connect(this.musicFade);
      src.start();
      this.musicSrc = src;
      if (ctx.state === 'suspended') void ctx.resume();
      this.log('music_start');
      this.applyMusicLevel(0.8);
    });
  }

  /** Fade the music out and stop it (a no-op if it is already stopping or stopped). */
  stopMusic(fadeSec: number): void {
    if (!this.musicWanted && !this.musicSrc) return;
    if (!this.musicWanted) return; // already on its way out: the first (usually longest) fade wins
    this.musicWanted = false;
    this.log('music_stop');
    if (!this.musicSrc || !this.ctx) return;
    this.applyMusicLevel(fadeSec);
    const src = this.musicSrc;
    window.clearTimeout(this.stopTimer);
    this.stopTimer = window.setTimeout(
      () => {
        if (this.musicWanted || this.musicSrc !== src) return;
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        src.disconnect();
        this.musicSrc = null;
      },
      fadeSec * 1000 + 100,
    );
  }

  /** Pause screen: music at 40%. */
  duckMusic(on: boolean): void {
    if (this.musicDucked === on) return;
    this.musicDucked = on;
    this.log(on ? 'music_duck' : 'music_unduck');
    this.applyMusicLevel(0.25);
  }

  /** M key. Returns the new muted state. */
  toggleMusicMute(): boolean {
    this.musicMuted = !this.musicMuted;
    this.log(this.musicMuted ? 'music_mute' : 'music_unmute');
    this.applyMusicLevel(0.15);
    return this.musicMuted;
  }

  private applyMusicLevel(rampSec: number): void {
    const ctx = this.ctx;
    const fade = this.musicFade;
    if (!ctx || !fade) return;
    const target = musicFadeTarget(this.musicWanted, this.musicMuted, this.musicDucked);
    const t = ctx.currentTime;
    fade.gain.cancelScheduledValues(t);
    fade.gain.setValueAtTime(fade.gain.value, t);
    fade.gain.linearRampToValueAtTime(target, t + Math.max(0.01, rampSec));
  }

  debugState(): UiAudioState {
    return {
      unlocked: this.unlocked,
      contextState: this.ctx?.state ?? 'none',
      musicWanted: this.musicWanted,
      musicPlaying: this.musicSrc !== null,
      musicMuted: this.musicMuted,
      musicDucked: this.musicDucked,
      log: [...this.debugLog],
    };
  }

  dispose(): void {
    window.clearTimeout(this.stopTimer);
    this.removeUnlock?.();
    this.removeUnlock = null;
    this.offSettings?.();
    this.offSettings = null;
    try {
      this.musicSrc?.stop();
    } catch {
      /* not started */
    }
    this.musicSrc = null;
    void this.ctx?.close();
    this.ctx = null;
    this.uiBus = this.musicBus = this.musicFade = null;
    this.unlocked = false;
    this.musicWanted = false;
  }
}

export const uiAudio = new UiAudio();

if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.defineProperty(window, '__voltlineUiAudio', { get: () => uiAudio.debugState(), configurable: true });
}
