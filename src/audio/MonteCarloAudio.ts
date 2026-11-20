import type { TrackDef } from '../core/Data';
import type { EventBus } from '../core/Events';
import type { AudioBus } from './AudioBus';

/**
 * Map 5's sound bed, driven by the track JSON's `audio` block: the harbour ambience on the quay and main straight, the
 * crowd near the grandstands (and a cheer for an overtake or takedown close to one), a yacht horn now and then and when
 * the player takes the flag-line in P1, the TV helicopter over the leader, and the tunnel's reverb. The engine and the
 * start-light sounds belong to the vehicle and race code.
 */

interface AudioBlock {
  ambience: { sfx: string; where: string; volume: number }[];
  events: { sfx: string; when: string }[];
  tunnelReverb: string;
}

/** Closest approach (m) at which the crowd is at full volume, and where it fades out. */
export const CROWD_RADIUS_M = 60;
/** A cheer needs the action this close to a grandstand. */
export const CHEER_RADIUS_M = 80;
/** Seconds between yacht horns (random in this range). */
export const HORN_EVERY_SEC: readonly [number, number] = [25, 60];
/** Ambience fades over this fraction of the lap at the edge of its sections. */
const FADE_T = 0.012;
const CHEER_GAIN = 0.8;
const HORN_GAIN = 0.7;
/** Helicopter loop: audible out to `HELI_RANGE_M`, full volume inside `HELI_REF_M`. */
const HELI_GAIN = 0.5;
const HELI_REF_M = 40;
const HELI_RANGE_M = 420;
/** The harbour ambience is dulled to this fraction inside the tunnel. */
const TUNNEL_AMBIENCE_MUL = 0.2;

const SECTIONS_WITH_HARBOUR = ['A', 'F', 'G', 'H'];

/** Every audio file the track JSON names (the bus loads them with the rest of the sfx). */
export function trackAudioFiles(def: TrackDef): string[] {
  const a = def.raw.audio as Partial<AudioBlock> | undefined;
  if (!a) return [];
  const ambience = (a.ambience ?? []).map((x) => x.sfx);
  const events = (a.events ?? []).map((x) => x.sfx);
  const helicopter = (def.raw.helicopter as { sfx?: string } | undefined)?.sfx;
  return [...ambience, ...events, ...(a.tunnelReverb ? [a.tunnelReverb] : []), ...(helicopter ? [helicopter] : [])];
}

const smooth = (k: number): number => {
  const c = Math.min(1, Math.max(0, k));
  return c * c * (3 - 2 * c);
};

const wrap01 = (t: number): number => ((t % 1) + 1) % 1;

/** The harbour sections as t-intervals; neighbours (H runs into A across the start line) are one stretch. */
export function harbourIntervals(def: TrackDef): [number, number][] {
  const sections = (def.raw.sections as { id: string; fromT: number; toT: number }[] | undefined) ?? [];
  const spans = sections
    .filter((s) => SECTIONS_WITH_HARBOUR.includes(s.id))
    .map((s): [number, number] => [s.fromT, s.toT])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  // The lap wraps: a stretch ending at 1 continues into one starting at 0.
  const first = merged[0];
  const end = merged[merged.length - 1];
  if (merged.length > 1 && first[0] <= 1e-6 && end[1] >= 1 - 1e-6) {
    merged.pop();
    merged[0] = [end[0] - 1, first[1]];
  }
  return merged;
}

/** 1 inside any of the harbour sections (F–H) and the main straight (A), fading out over a few tens of metres. */
export function harbourLevel(def: TrackDef, t: number): number {
  const tt = wrap01(t);
  let level = 0;
  for (const [from, to] of harbourIntervals(def)) {
    for (const x of [tt, tt - 1]) level = Math.max(level, smooth(Math.min(x - from, to - x) / FADE_T + 0.5));
  }
  return level;
}

/** Crowd volume 0..1: full beside a grandstand, fading to nothing `CROWD_RADIUS_M` away. */
export function crowdLevel(stands: readonly { x: number; z: number }[], x: number, z: number): number {
  let best = Infinity;
  for (const s of stands) best = Math.min(best, Math.hypot(s.x - x, s.z - z));
  return best === Infinity ? 0 : Math.max(0, 1 - best / CROWD_RADIUS_M);
}

export function nearStand(stands: readonly { x: number; z: number }[], x: number, z: number, radius: number): boolean {
  return stands.some((s) => Math.hypot(s.x - x, s.z - z) <= radius);
}

/** Seconds until the next yacht horn for a random number in [0, 1). */
export function nextHornDelay(rnd: number): number {
  return HORN_EVERY_SEC[0] + (HORN_EVERY_SEC[1] - HORN_EVERY_SEC[0]) * Math.min(1, Math.max(0, rnd));
}

export interface AudioState {
  /** Player's along-track t, position and heading (radians, atan2(x, z)). */
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  place: number;
  /** 0..1 eased tunnel amount (MonteCarlo.tunnelAmount). */
  tunnel: number;
  helicopter: { x: number; y: number; z: number } | null;
}

interface Loop {
  setLevel(level: number, rampSec?: number): void;
  stop(): void;
}

export class MonteCarloAudio {
  private readonly stands: { x: number; z: number }[];
  private readonly yachts: { x: number; y: number; z: number }[];
  private readonly files: { harbour: string; crowd: string; cheer: string; horn: string; ir: string; heli: string };
  private readonly gains: { harbour: number; crowd: number };
  private readonly harbour: Loop | null;
  private readonly crowd: Loop | null;
  private heli: { src: AudioBufferSourceNode; panner: PannerNode; gain: GainNode } | null = null;
  private hornIn: number;
  private lastPlace = 0;
  private cheerCooldown = 0;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly bus: AudioBus,
    private readonly def: TrackDef,
    events: EventBus,
    /** The race position of the player (1 = leading), read when a lap is completed. */
    private readonly playerPlace: () => number,
    private readonly playerPos: () => { x: number; y: number; z: number },
    private readonly rnd: () => number = Math.random,
  ) {
    const a = def.raw.audio as AudioBlock;
    const find = (re: RegExp): string => a.events.find((e) => re.test(e.sfx))?.sfx ?? '';
    const amb = (re: RegExp): { sfx: string; volume: number } =>
      a.ambience.find((e) => re.test(e.sfx)) ?? { sfx: '', volume: 0 };
    const harbour = amb(/harbour/);
    const crowd = amb(/crowd/);
    this.files = {
      harbour: harbour.sfx,
      crowd: crowd.sfx,
      cheer: find(/cheer/),
      horn: find(/horn/),
      ir: a.tunnelReverb,
      heli: (def.raw.helicopter as { sfx?: string } | undefined)?.sfx ?? '',
    };
    this.gains = { harbour: harbour.volume, crowd: crowd.volume };
    const gs = def.raw.grandstands as { segments: { position: [number, number, number] }[] }[];
    this.stands = gs.flatMap((g) => g.segments.map((s) => ({ x: s.position[0], z: s.position[2] })));
    this.yachts = (def.raw.harbour as { yachts: { position: [number, number, number] }[] }).yachts.map((y) => ({
      x: y.position[0],
      y: y.position[1] + 8,
      z: y.position[2],
    }));
    this.harbour = this.files.harbour ? bus.loop(this.files.harbour, this.gains.harbour) : null;
    this.crowd = this.files.crowd ? bus.loop(this.files.crowd, this.gains.crowd) : null;
    this.hornIn = nextHornDelay(rnd());
    if (this.files.ir) bus.useImpulse(this.files.ir);
    this.startHelicopter();

    // The player crossing the line in P1 gets the horn; a takedown near a grandstand gets the crowd.
    this.offs.push(
      events.on('lapComplete', (e) => {
        if (e.carId === 'player' && this.playerPlace() === 1) this.horn();
      }),
      events.on('carWrecked', (e) => {
        const p = this.playerPos();
        if (e.attackerId !== null) this.cheer(p.x, p.z);
      }),
    );
  }

  private startHelicopter(): void {
    const buf = this.files.heli ? this.bus.buffer(this.files.heli) : undefined;
    if (!buf) return;
    const ctx = this.bus.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = HELI_GAIN;
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = HELI_REF_M;
    panner.maxDistance = HELI_RANGE_M;
    panner.rolloffFactor = 1.4;
    src.connect(gain).connect(panner).connect(this.bus.sfx);
    src.start();
    this.heli = { src, panner, gain };
  }

  private playAt(file: string, gain: number, x: number, y: number, z: number): void {
    const buf = file ? this.bus.buffer(file) : undefined;
    const ctx = this.bus.ctx;
    if (!buf || ctx.state !== 'running') return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 60;
    panner.rolloffFactor = 1;
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
    src.connect(g).connect(panner).connect(this.bus.sfx);
    src.start();
    src.onended = () => panner.disconnect();
  }

  /** A yacht horn from a random yacht on the harbour. */
  private horn(): void {
    const y = this.yachts[Math.floor(this.rnd() * this.yachts.length)];
    if (y) this.playAt(this.files.horn, HORN_GAIN, y.x, y.y, y.z);
  }

  private cheer(x: number, z: number): void {
    if (this.cheerCooldown > 0 || !nearStand(this.stands, x, z, CHEER_RADIUS_M)) return;
    this.cheerCooldown = 4;
    this.bus.play({ file: this.files.cheer, gain: CHEER_GAIN, fadeOut: 0.6 });
  }

  update(dt: number, s: AudioState): void {
    const harbour = harbourLevel(this.def, s.t);
    const duck = 1 - (1 - TUNNEL_AMBIENCE_MUL) * s.tunnel;
    this.harbour?.setLevel(harbour * duck, 0.4);
    this.crowd?.setLevel(crowdLevel(this.stands, s.x, s.z) * duck, 0.3);
    this.bus.setReverb(s.tunnel);
    this.cheerCooldown = Math.max(0, this.cheerCooldown - dt);
    // Overtake near a grandstand: the crowd cheers.
    if (this.lastPlace !== 0 && s.place < this.lastPlace) this.cheer(s.x, s.z);
    this.lastPlace = s.place;
    this.hornIn -= dt;
    if (this.hornIn <= 0) {
      this.horn();
      this.hornIn = nextHornDelay(this.rnd());
    }
    // Listener: the player's car, looking along its heading.
    const L = this.bus.ctx.listener;
    if (L.positionX) {
      L.positionX.value = s.x;
      L.positionY.value = s.y + 2;
      L.positionZ.value = s.z;
      L.forwardX.value = Math.sin(s.yaw);
      L.forwardY.value = 0;
      L.forwardZ.value = Math.cos(s.yaw);
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    }
    if (this.heli && s.helicopter) {
      this.heli.panner.positionX.value = s.helicopter.x;
      this.heli.panner.positionY.value = s.helicopter.y;
      this.heli.panner.positionZ.value = s.helicopter.z;
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.harbour?.stop();
    this.crowd?.stop();
    if (this.heli) {
      try {
        this.heli.src.stop();
      } catch {
        /* already stopped */
      }
      this.heli.src.disconnect();
      this.heli.panner.disconnect();
      this.heli = null;
    }
    this.bus.setReverb(0);
  }
}
