import type { TrackDef } from '../core/Data';
import type { EventBus } from '../core/Events';
import placementsJson from '../../data/tracks/ardennes_placements.json';
import type { AudioBus } from './AudioBus';

/**
 * Map 6's sound bed, driven by the track JSON's `audio` and `weather` blocks: the forest ambience everywhere outside
 * the spectator areas, the valley crowd at the Eau Rouge / La Source / pit / Blanchimont stands, the brook at the Eau
 * Rouge dip, cowbells at the pastures and the campsite radio, the lap-2 shower (rain canopy, rain on roofs, wet tyres,
 * far thunder), the compression whoosh at the bottom of Eau Rouge, the Stavelot church bell once a lap, wind gusts on
 * Kemmel and at Les Combes, kerb rumble and gravel spray. Engines, skids and the start lights belong to other code;
 * the shower itself is a pure function of the lap number here (audio only, the sim has its own).
 */

interface AudioBlock {
  ambience?: { sfx: string; where?: string; volume: number }[];
  events?: { sfx: string; when?: string }[];
  spotAmbience?: { sfx: string; where?: string; volume: number }[];
}

type Pt = { x: number; z: number };

export const CROWD_FULL_M = 40;
/** Crowd is audible out to this distance of a stand (JSON: "within 80 m"). */
export const CROWD_RADIUS_M = 80;
export const CREEK_RADIUS_M = 40;
export const PASTURE_RADIUS_M = 120;
export const CAMPSITE_RADIUS_M = 60;
/** The compression whoosh needs a car at least this fast through the bottom of Eau Rouge. */
export const WHOOSH_MIN_KMH = 180;
/** Gravel spray when entering a trap above this speed. */
export const GRAVEL_MIN_KMH = 60;
/** Thunder only on this lap, every 45-90 s (read from the JSON where present). */
export const THUNDER_EVERY_SEC: readonly [number, number] = [45, 90];
export const THUNDER_LAP = 2;
export const GUST_EVERY_SEC: readonly [number, number] = [20, 40];
/** Lap fraction of the bottom of Eau Rouge (T2) and of Stavelot (T14). */
export const EAU_ROUGE_T = 0.1422;
export const STAVELOT_T = 0.6587;
/** Wind gusts blow on the Kemmel straight and around Les Combes (t ranges). */
export const GUST_ZONES: readonly (readonly [number, number])[] = [
  [0.23, 0.36],
  [0.36, 0.43],
];
/** Fraction of the lap over which a wet zone fades in and out. */
const FADE_T = 0.008;
/** Speed (km/h) at which wet-tyre hiss reaches full volume. */
const WET_TYRES_FULL_KMH = 200;
const KERB_FULL_KMH = 200;
const WHOOSH_GAIN = 0.9;
const GRAVEL_GAIN = 0.7;
const GUST_GAIN = 0.6;
const THUNDER_GAIN = 0.8;
const BELL_GAIN = 0.8;
const KERB_GAIN = 0.5;
const WET_TYRES_GAIN = 0.5;

const smooth = (k: number): number => {
  const c = Math.min(1, Math.max(0, k));
  return c * c * (3 - 2 * c);
};
const wrap01 = (t: number): number => ((t % 1) + 1) % 1;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Every audio file the track JSON names (the bus loads them with the rest of the sfx). */
export function trackAudioFiles(def: TrackDef): string[] {
  const a = def.raw.audio as AudioBlock | undefined;
  if (!a) return [];
  const thunder = (def.raw.weather as { thunder?: { sfx?: string } } | undefined)?.thunder?.sfx;
  const all = [
    ...(a.ambience ?? []).map((x) => x.sfx),
    ...(a.events ?? []).map((x) => x.sfx),
    ...(a.spotAmbience ?? []).map((x) => x.sfx),
    ...(thunder ? [thunder] : []),
  ];
  return [...new Set(all)];
}

/** 0..1: full inside `fullM` of the nearest point, fading smoothly to nothing at `radiusM`. */
export function zoneLevel(points: readonly Pt[], x: number, z: number, radiusM: number, fullM = 0): number {
  let best = Infinity;
  for (const p of points) best = Math.min(best, Math.hypot(p.x - x, p.z - z));
  if (best === Infinity) return 0;
  return 1 - smooth((best - fullM) / Math.max(1e-6, radiusM - fullM));
}

/** Shower strength (0..1) on a lap, from `weather.laps` (the last entry at or below the lap; 0 when absent). */
export function showerForLap(def: TrackDef, lap: number): number {
  const laps = (def.raw.weather as { laps?: { lap: number; shower: number }[] } | undefined)?.laps ?? [];
  let s = 0;
  let at = -Infinity;
  for (const l of laps) {
    if (l.lap <= lap && l.lap > at) {
      at = l.lap;
      s = l.shower;
    }
  }
  return clamp01(s);
}

/** 0..1: inside any `weather.wetZones` interval, fading over a short stretch at the edges. */
export function wetZoneLevel(zones: readonly { fromT: number; toT: number }[], t: number): number {
  const tt = wrap01(t);
  let level = 0;
  for (const z of zones) level = Math.max(level, smooth(Math.min(tt - z.fromT, z.toT - tt) / FADE_T + 0.5));
  return level;
}

/** How wet the road/air is at a lap fraction on a lap: the shower strength where the wet zones are. */
export function wetnessAt(def: TrackDef, lap: number, t: number): number {
  const zones = (def.raw.weather as { wetZones?: { fromT: number; toT: number }[] } | undefined)?.wetZones ?? [];
  return showerForLap(def, lap) * wetZoneLevel(zones, t);
}

/** True when the lap fraction moved forward over `at` between two frames (lap wrap and big jumps ignored). */
export function crossed(prevT: number, t: number, at: number): boolean {
  const d = wrap01(t - prevT);
  return d > 0 && d < 0.05 && wrap01(at - prevT) <= d && wrap01(at - prevT) > 0;
}

/** True if a car passing `prevT` -> `t` at `speedKmh` triggers the Eau Rouge compression whoosh. */
export function whooshTrigger(prevT: number, t: number, speedKmh: number): boolean {
  return speedKmh >= WHOOSH_MIN_KMH && crossed(prevT, t, EAU_ROUGE_T);
}

export function nextDelay(range: readonly [number, number], rnd: number): number {
  return range[0] + (range[1] - range[0]) * clamp01(rnd);
}

/**
 * Far thunder: only on `lap` (2), a random 45-90 s apart. Pure and rng-injectable: `tick` returns true on the frame a
 * rumble should play. The first rumble comes a full interval after the lap begins.
 */
export class ThunderScheduler {
  private left: number;
  constructor(
    private readonly rnd: () => number = Math.random,
    private readonly every: readonly [number, number] = THUNDER_EVERY_SEC,
    private readonly lap = THUNDER_LAP,
  ) {
    this.left = nextDelay(every, rnd());
  }
  tick(dt: number, lap: number): boolean {
    if (lap !== this.lap) return false;
    this.left -= dt;
    if (this.left > 0) return false;
    this.left = nextDelay(this.every, this.rnd());
    return true;
  }
}

/** Random wind gusts every 20-40 s, only while `active` (on Kemmel or at Les Combes). */
export class GustScheduler {
  private left: number;
  constructor(private readonly rnd: () => number = Math.random) {
    this.left = nextDelay(GUST_EVERY_SEC, rnd());
  }
  tick(dt: number, active: boolean): boolean {
    if (!active) return false;
    this.left -= dt;
    if (this.left > 0) return false;
    this.left = nextDelay(GUST_EVERY_SEC, this.rnd());
    return true;
  }
}

export const inGustZone = (t: number): boolean => {
  const tt = wrap01(t);
  return GUST_ZONES.some(([a, b]) => tt >= a && tt <= b);
};

/** Kerb rumble level 0..1 (the loop's pitch cannot follow speed on the bus, so the volume does). */
export const kerbLevel = (onKerb: boolean, speedKmh: number): number =>
  onKerb ? clamp01(speedKmh / KERB_FULL_KMH) : 0;

/** Wet-tyre hiss level 0..1 = speed x wetness. */
export const wetTyresLevel = (speedKmh: number, wetness: number): number =>
  clamp01(speedKmh / WET_TYRES_FULL_KMH) * clamp01(wetness);

/** Gravel spray fires on the frame a car enters a trap above 60 km/h. */
export const gravelSpray = (wasInGravel: boolean, inGravel: boolean, speedKmh: number): boolean =>
  !wasInGravel && inGravel && speedKmh >= GRAVEL_MIN_KMH;

export interface ArdennesPlacements {
  groups: Record<string, { model?: string; x: number; z: number }[]>;
}

export interface AudioState {
  /** Player's along-track t, lap (1-based), position, heading (radians, atan2(x, z)) and speed. */
  t: number;
  lap: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speedKmh: number;
  /** Any wheel on a kerb_3d piece / the car entered a gravel trap. */
  onKerb: boolean;
  inGravel: boolean;
  /** Every car (player included), for the compression whoosh. */
  cars: { id: string; t: number; x: number; y: number; z: number; speedKmh: number }[];
}

interface Loop {
  setLevel(level: number, rampSec?: number): void;
  stop(): void;
}

export class ArdennesAudio {
  private readonly stands: Pt[];
  private readonly dip: Pt[];
  private readonly pasture: Pt[];
  private readonly campsite: Pt[];
  private readonly church: Pt;
  private readonly files = new Map<string, string>();
  private readonly loops: Record<
    'forest' | 'crowd' | 'creek' | 'rain' | 'cowbells' | 'radio' | 'roof' | 'wet' | 'kerb',
    Loop | null
  >;
  private readonly thunder: ThunderScheduler;
  private readonly gust: GustScheduler;
  private readonly lastT = new Map<string, number>();
  private lastPlayerT: number | null = null;
  private wasInGravel = false;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly bus: AudioBus,
    private readonly def: TrackDef,
    events: EventBus,
    /** The race position of the player (1 = leading); kept for parity with the other maps' audio. */
    _playerPlace: () => number,
    _playerPos: () => { x: number; y: number; z: number },
    rnd: () => number = Math.random,
    placements: ArdennesPlacements = placementsJson as unknown as ArdennesPlacements,
  ) {
    const a = (def.raw.audio ?? {}) as AudioBlock;
    const all = [...(a.ambience ?? []), ...(a.events ?? []), ...(a.spotAmbience ?? [])] as {
      sfx: string;
      volume?: number;
    }[];
    const find = (re: RegExp): { sfx: string; volume: number } => {
      const f = all.find((e) => re.test(e.sfx));
      return { sfx: f?.sfx ?? '', volume: f?.volume ?? 1 };
    };
    const mk = (re: RegExp, fallback = 1): Loop | null => {
      const f = find(re);
      return f.sfx ? this.bus.loop(f.sfx, f.volume ?? fallback) : null;
    };
    for (const [k, re] of Object.entries({
      whoosh: /compression_whoosh/,
      gravel: /gravel_spray/,
      gust: /wind_gust/,
      bell: /church_bell/,
      thunder: /far_thunder/,
    })) {
      this.files.set(k, find(re).sfx);
    }
    const thunderCfg = (def.raw.weather as { thunder?: { sfx?: string; everySec?: [number, number] } } | undefined)
      ?.thunder;
    if (!this.files.get('thunder') && thunderCfg?.sfx) this.files.set('thunder', thunderCfg.sfx);
    this.loops = {
      forest: mk(/forest_ambience/),
      crowd: mk(/crowd_valley/),
      creek: mk(/creek_loop/),
      rain: mk(/rain_canopy/),
      cowbells: mk(/cowbells/),
      radio: mk(/campsite_radio/),
      roof: mk(/rain_on_roof/),
      wet: mk(/wet_tyres/, WET_TYRES_GAIN),
      kerb: mk(/kerb_rumble/, KERB_GAIN),
    };
    const gs = (def.raw.grandstands ?? []) as { segments: { position: [number, number, number] }[] }[];
    this.stands = gs.flatMap((g) => g.segments.map((s) => ({ x: s.position[0], z: s.position[2] })));
    const g = placements.groups ?? {};
    this.pasture = (g.pasture ?? []).map((p) => ({ x: p.x, z: p.z }));
    this.campsite = (g.campsite ?? []).map((p) => ({ x: p.x, z: p.z }));
    const culvert = (g.landmarks ?? []).find((p) => p.model === 'culvert');
    const t2 = (def.raw.corners as { name: string; position: [number, number, number] }[] | undefined)?.find(
      (c) => c.name === 'Eau Rouge',
    );
    this.dip = culvert ? [{ x: culvert.x, z: culvert.z }] : t2 ? [{ x: t2.position[0], z: t2.position[2] }] : [];
    const church = (g.villages ?? []).find((p) => p.model === 'church');
    this.church = church ? { x: church.x, z: church.z } : { x: 2257.1, z: 330.3 };
    this.thunder = new ThunderScheduler(rnd, thunderCfg?.everySec ?? THUNDER_EVERY_SEC);
    this.gust = new GustScheduler(rnd);

    // Re-arm the once-a-lap bell crossing after each of the player's laps.
    this.offs.push(
      events.on('lapComplete', (e) => {
        if (e.carId === 'player') this.lastPlayerT = null;
      }),
    );
  }

  private playAt(file: string | undefined, gain: number, x: number, y: number, z: number): void {
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
    panner.refDistance = 40;
    panner.rolloffFactor = 1;
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
    src.connect(g).connect(panner).connect(this.bus.sfx);
    src.start();
    src.onended = () => panner.disconnect();
  }

  private playFlat(key: string, gain: number): void {
    const file = this.files.get(key);
    if (file) this.bus.play({ file, gain, fadeOut: 0.6 });
  }

  update(dt: number, s: AudioState): void {
    const crowd = zoneLevel(this.stands, s.x, s.z, CROWD_RADIUS_M, CROWD_FULL_M);
    const wet = wetnessAt(this.def, s.lap, s.t);
    const camp = zoneLevel(this.campsite, s.x, s.z, CAMPSITE_RADIUS_M, CAMPSITE_RADIUS_M * 0.4);
    const standsOrCamp = Math.max(crowd, camp);
    this.loops.forest?.setLevel(1 - crowd, 0.5);
    this.loops.crowd?.setLevel(crowd, 0.3);
    this.loops.creek?.setLevel(zoneLevel(this.dip, s.x, s.z, CREEK_RADIUS_M, 10), 0.3);
    this.loops.cowbells?.setLevel(zoneLevel(this.pasture, s.x, s.z, PASTURE_RADIUS_M, 40), 0.4);
    this.loops.radio?.setLevel(camp, 0.3);
    this.loops.rain?.setLevel(wet, 0.8);
    this.loops.roof?.setLevel(wet * standsOrCamp, 0.6);
    this.loops.wet?.setLevel(wetTyresLevel(s.speedKmh, wet), 0.25);
    this.loops.kerb?.setLevel(kerbLevel(s.onKerb, s.speedKmh), 0.08);

    if (this.thunder.tick(dt, s.lap)) this.playFlat('thunder', THUNDER_GAIN);
    if (this.gust.tick(dt, inGustZone(s.t))) this.playFlat('gust', GUST_GAIN);
    if (gravelSpray(this.wasInGravel, s.inGravel, s.speedKmh)) this.playFlat('gravel', GRAVEL_GAIN);
    this.wasInGravel = s.inGravel;

    // The compression whoosh, positional at each car that comes through the bottom of Eau Rouge fast enough.
    for (const c of s.cars) {
      const prev = this.lastT.get(c.id);
      this.lastT.set(c.id, c.t);
      if (prev !== undefined && whooshTrigger(prev, c.t, c.speedKmh))
        this.playAt(this.files.get('whoosh'), WHOOSH_GAIN, c.x, c.y, c.z);
    }
    // The Stavelot church bell, once a lap as the player passes the village.
    if (this.lastPlayerT !== null && crossed(this.lastPlayerT, s.t, STAVELOT_T))
      this.playAt(this.files.get('bell'), BELL_GAIN, this.church.x, s.y + 12, this.church.z);
    this.lastPlayerT = s.t;

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
  }

  dispose(): void {
    for (const off of this.offs) off();
    for (const l of Object.values(this.loops)) l?.stop();
  }
}
