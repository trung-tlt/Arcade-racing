import type { TrackDef } from '../core/Data';
import type { EventBus } from '../core/Events';
import placementsJson from '../../data/tracks/cat_lai_placements.json';
import type { AudioBus } from './AudioBus';

/**
 * Map 1's (Cat Lai Port, daylight v2) sound bed, driven by the track JSON's `audio`, `sections` and `river.ferry`:
 *  - port_day_loop inside the port (every section but the Nguyen Thi Dinh road and the admin link), street_traffic_loop
 *    on those two street sections, cross-fading over a short stretch of the lap at their edges;
 *  - river_lapping_loop within 60 m of the quay edge ("within 60 m of the quay edge");
 *  - reverse_beeper_loop near terminal tractors / reach stackers (placement models tt_*, rs);
 *  - container_clank positional at a nearby STS/RTG crane every 4-9 s (JSON);
 *  - ship_horn once per lap from the river (positional at the nearest ship, fired as the player crosses SHIP_HORN_T);
 *  - ferry_horn when passing the ferry approach (the GATE section), and at the ferry's departure/arrival (every half of
 *    its 240 s crossing cycle) while the player is within earshot of the HCMC landing;
 *  - scooter_horns at random on Nguyen Thi Dinh.
 * Choices not in the JSON are marked CHOICE below. Engines, skids and lights belong to other code.
 */

interface AudioBlock {
  ambience?: { sfx: string; where?: string; volume: number }[];
  events?: { sfx: string; when?: string }[];
}

type Pt = { x: number; z: number };
type Seg = { a: Pt; b: Pt };

/** JSON: "within 60 m of the quay edge". River loop is full at the edge, fading out by this distance. */
export const RIVER_RADIUS_M = 60;
export const RIVER_FULL_M = 15;
/** CHOICE: beeper audible out to this distance of a tractor / reach stacker, full inside BEEPER_FULL_M. */
export const BEEPER_RADIUS_M = 50;
export const BEEPER_FULL_M = 12;
/** JSON: clank every 4-9 s while near a crane. CHOICE: "near" is 140 m. */
export const CLANK_EVERY_SEC: readonly [number, number] = [4, 9];
export const CLANK_RADIUS_M = 140;
/** CHOICE: scooter horns every 6-16 s on the street sections. */
export const SCOOTER_EVERY_SEC: readonly [number, number] = [6, 16];
/** CHOICE: the once-a-lap ship horn fires when the player passes this lap fraction (mid quay apron). */
export const SHIP_HORN_T = 0.33;
/** JSON river.ferry.crossingSec. */
export const FERRY_CYCLE_SEC = 240;
/** CHOICE: the ferry horn is heard from this far from the HCMC landing; a horn at most every FERRY_COOLDOWN_SEC. */
export const FERRY_EARSHOT_M = 450;
export const FERRY_COOLDOWN_SEC = 30;
/** Section ids that are street (Nguyen Thi Dinh road and the admin link back onto it). */
export const STREET_SECTIONS: readonly string[] = ['NTD', 'LINK'];
/** Section id of the ferry approach. */
export const FERRY_SECTION = 'GATE';
/** Fraction of the lap over which street/port cross-fade at section edges (CHOICE). */
const FADE_T = 0.012;
const CLANK_GAIN = 0.7;
const SHIP_GAIN = 0.9;
const FERRY_GAIN = 0.9;
const SCOOTER_GAIN = 0.7;
const HANDLER_MODELS: readonly string[] = ['tt_0', 'tt_1', 'tt_2', 'rs'];
const CRANE_MODELS: readonly string[] = ['sts', 'sts_up', 'rtg'];

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
  return [...new Set([...(a.ambience ?? []).map((x) => x.sfx), ...(a.events ?? []).map((x) => x.sfx)])];
}

/** The street sections as [fromT, toT] intervals, read from the JSON `sections`. */
export function streetIntervals(def: TrackDef): [number, number][] {
  const sections = (def.raw.sections as { id: string; fromT: number; toT: number }[] | undefined) ?? [];
  return sections.filter((s) => STREET_SECTIONS.includes(s.id)).map((s): [number, number] => [s.fromT, s.toT]);
}

/** The ferry approach (GATE section) as a [fromT, toT] interval, or null. */
export function ferryApproach(def: TrackDef): [number, number] | null {
  const s = (def.raw.sections as { id: string; fromT: number; toT: number }[] | undefined)?.find(
    (x) => x.id === FERRY_SECTION,
  );
  return s ? [s.fromT, s.toT] : null;
}

/** 0..1: inside any interval (fading over FADE_T at its edges; wraps at the start line). */
export function intervalLevel(intervals: readonly [number, number][], t: number): number {
  const tt = wrap01(t);
  let level = 0;
  for (const [a, b] of intervals) level = Math.max(level, smooth(Math.min(tt - a, b - tt) / FADE_T + 0.5));
  return level;
}

/** Street level 0..1 at lap fraction t (1 on Nguyen Thi Dinh and the admin link). */
export const streetLevel = (def: TrackDef, t: number): number => intervalLevel(streetIntervals(def), t);
/** Port level 0..1 = the complement of the street level. */
export const portLevel = (def: TrackDef, t: number): number => 1 - streetLevel(def, t);

/** True when the lap fraction moved forward over `at` between two frames (wrap and big jumps ignored). */
export function crossed(prevT: number, t: number, at: number): boolean {
  const d = wrap01(t - prevT);
  return d > 0 && d < 0.05 && wrap01(at - prevT) <= d && wrap01(at - prevT) > 0;
}

/** True when the lap fraction moved forward into [from, to] from outside it (entering the ferry approach). */
export function entered(prevT: number, t: number, [from, to]: readonly [number, number]): boolean {
  const inside = (v: number): boolean => wrap01(v) >= from && wrap01(v) <= to;
  const d = wrap01(t - prevT);
  return d > 0 && d < 0.05 && !inside(prevT) && inside(t);
}

/** Distance from a point to a segment. */
export function distToSegment(x: number, z: number, s: Seg): number {
  const dx = s.b.x - s.a.x;
  const dz = s.b.z - s.a.z;
  const l2 = dx * dx + dz * dz;
  const k = l2 === 0 ? 0 : clamp01(((x - s.a.x) * dx + (z - s.a.z) * dz) / l2);
  return Math.hypot(s.a.x + k * dx - x, s.a.z + k * dz - z);
}

/**
 * The quay edge as a segment: JSON quay.edgeStart, running `dirDeg` for `lengthM`. The direction follows the shoreline
 * (heading east and slightly to -z for 27 deg): (cos, -sin), checked against the river.shoreline points.
 */
export function quayEdge(def: TrackDef): Seg | null {
  const q = def.raw.quay as { edgeStart: number[]; dirDeg: number; lengthM: number } | undefined;
  if (!q) return null;
  const r = (q.dirDeg * Math.PI) / 180;
  const a = { x: q.edgeStart[0], z: q.edgeStart[2] };
  return { a, b: { x: a.x + Math.cos(r) * q.lengthM, z: a.z - Math.sin(r) * q.lengthM } };
}

/** River lapping level 0..1: full within RIVER_FULL_M of the quay edge, nothing beyond RIVER_RADIUS_M. */
export function riverLevel(edge: Seg | null, x: number, z: number): number {
  if (!edge) return 0;
  const d = distToSegment(x, z, edge);
  return 1 - smooth((d - RIVER_FULL_M) / (RIVER_RADIUS_M - RIVER_FULL_M));
}

/** 0..1: full inside `fullM` of the nearest point, fading smoothly to nothing at `radiusM`. */
export function zoneLevel(points: readonly Pt[], x: number, z: number, radiusM: number, fullM = 0): number {
  const n = nearest(points, x, z);
  if (!n) return 0;
  return 1 - smooth((n.d - fullM) / Math.max(1e-6, radiusM - fullM));
}

/** The nearest point and its distance, or null. */
export function nearest(points: readonly Pt[], x: number, z: number): { p: Pt; d: number } | null {
  let best: { p: Pt; d: number } | null = null;
  for (const p of points) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (!best || d < best.d) best = { p, d };
  }
  return best;
}

export function nextDelay(range: readonly [number, number], rnd: number): number {
  return range[0] + (range[1] - range[0]) * clamp01(rnd);
}

/** Random-interval trigger, only ticking while `active`. rng-injectable. First fire a full interval after activation. */
export class IntervalScheduler {
  private left: number;
  constructor(
    private readonly every: readonly [number, number],
    private readonly rnd: () => number = Math.random,
  ) {
    this.left = nextDelay(every, rnd());
  }
  tick(dt: number, active: boolean): boolean {
    if (!active) return false;
    this.left -= dt;
    if (this.left > 0) return false;
    this.left = nextDelay(this.every, this.rnd());
    return true;
  }
}

/** Container clank every 4-9 s while near a crane. */
export class ClankScheduler extends IntervalScheduler {
  constructor(rnd: () => number = Math.random, every: readonly [number, number] = CLANK_EVERY_SEC) {
    super(every, rnd);
  }
}
/** Scooter horns at random on the street sections. */
export class ScooterHornScheduler extends IntervalScheduler {
  constructor(rnd: () => number = Math.random, every: readonly [number, number] = SCOOTER_EVERY_SEC) {
    super(every, rnd);
  }
}

/**
 * The ferry horn: the ferry crosses in `cycleSec` (240 s), so it departs and arrives every half cycle. `tick` returns
 * true on the frame a horn should sound: at each half-cycle boundary while `near` the landing, or when `passing` the
 * approach, never twice within `cooldownSec`. The clock starts at 0 when the race starts (departure).
 */
export class FerryHornScheduler {
  private clock = 0;
  private lastHorn = -Infinity;
  constructor(
    private readonly cycleSec: number = FERRY_CYCLE_SEC,
    private readonly cooldownSec: number = FERRY_COOLDOWN_SEC,
  ) {}
  tick(dt: number, near: boolean, passing: boolean): boolean {
    const half = this.cycleSec / 2;
    const prev = this.clock;
    this.clock += dt;
    const boundary = Math.floor(this.clock / half) > Math.floor(prev / half);
    if (!((boundary && near) || passing)) return false;
    if (this.clock - this.lastHorn < this.cooldownSec) return false;
    this.lastHorn = this.clock;
    return true;
  }
}

export interface CatLaiPlacements {
  groups: Record<string, { model?: string; x: number; z: number; y?: number }[]>;
}

export interface CatLaiAudioState {
  /** Player's along-track t, position, heading (radians, atan2(x, z)) and speed. */
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speedKmh: number;
  /** Every car (player included); kept for parity with the other maps (the sound bed does not use it yet). */
  cars: { id: string; t: number; x: number; y: number; z: number; speedKmh: number }[];
}

interface Loop {
  setLevel(level: number, rampSec?: number): void;
  stop(): void;
}

export class CatLaiAudio {
  private readonly street: [number, number][];
  private readonly approach: [number, number] | null;
  private readonly edge: Seg | null;
  private readonly handlers: Pt[];
  private readonly cranes: Pt[];
  private readonly ships: Pt[];
  private readonly landing: Pt;
  private readonly files = new Map<string, string>();
  private readonly loops: Record<'port' | 'street' | 'river' | 'beeper', Loop | null>;
  private readonly clank: ClankScheduler;
  private readonly scooter: ScooterHornScheduler;
  private readonly ferry: FerryHornScheduler;
  private lastT: number | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly bus: AudioBus,
    def: TrackDef,
    events: EventBus,
    /** The race position of the player (1 = leading); kept for parity with the other maps' audio. */
    _playerPlace: () => number,
    _playerPos: () => { x: number; y: number; z: number },
    rnd: () => number = Math.random,
    placements: CatLaiPlacements = placementsJson as unknown as CatLaiPlacements,
  ) {
    const a = (def.raw.audio ?? {}) as AudioBlock;
    const all = [...(a.ambience ?? []), ...(a.events ?? [])] as { sfx: string; volume?: number }[];
    const find = (re: RegExp): { sfx: string; volume: number } => {
      const f = all.find((e) => re.test(e.sfx));
      return { sfx: f?.sfx ?? '', volume: f?.volume ?? 1 };
    };
    const mk = (re: RegExp): Loop | null => {
      const f = find(re);
      return f.sfx ? this.bus.loop(f.sfx, f.volume) : null;
    };
    for (const [k, re] of Object.entries({
      clank: /container_clank/,
      ship: /ship_horn/,
      ferry: /ferry_horn/,
      scooter: /scooter_horns/,
    }))
      this.files.set(k, find(re).sfx);
    this.loops = {
      port: mk(/port_day_loop/),
      street: mk(/street_traffic_loop/),
      river: mk(/river_lapping_loop/),
      beeper: mk(/reverse_beeper_loop/),
    };
    this.street = streetIntervals(def);
    this.approach = ferryApproach(def);
    this.edge = quayEdge(def);
    const g = placements.groups ?? {};
    const pts = (names: string[], models: readonly string[]): Pt[] =>
      names.flatMap((n) =>
        (g[n] ?? []).filter((p) => p.model && models.includes(p.model)).map((p) => ({ x: p.x, z: p.z })),
      );
    this.handlers = pts(['yard', 'quay'], HANDLER_MODELS);
    this.cranes = pts(['yard', 'quay'], CRANE_MODELS);
    this.ships = (g.river ?? []).filter((p) => p.model?.startsWith('ship_')).map((p) => ({ x: p.x, z: p.z }));
    const l = (def.raw.river as { ferry?: { landingHCMC?: number[] } } | undefined)?.ferry?.landingHCMC;
    this.landing = l ? { x: l[0], z: l[2] } : { x: 215, z: 245 };
    const cycle = (def.raw.river as { ferry?: { crossingSec?: number } } | undefined)?.ferry?.crossingSec;
    this.clank = new ClankScheduler(rnd);
    this.scooter = new ScooterHornScheduler(rnd);
    this.ferry = new FerryHornScheduler(cycle ?? FERRY_CYCLE_SEC);
    // Re-arm the once-a-lap ship horn crossing after each of the player's laps.
    this.offs.push(
      events.on('lapComplete', (e) => {
        if (e.carId === 'player') this.lastT = null;
      }),
    );
  }

  private playAt(file: string | undefined, gain: number, x: number, y: number, z: number): void {
    const buf = file ? this.bus.buffer(file) : undefined;
    const ctx = this.bus.ctx;
    if (!buf || ctx.state !== 'running') return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gn = ctx.createGain();
    gn.gain.value = gain;
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 40;
    panner.rolloffFactor = 1;
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
    src.connect(gn).connect(panner).connect(this.bus.sfx);
    src.start();
    src.onended = () => panner.disconnect();
  }

  update(dt: number, s: CatLaiAudioState): void {
    const street = intervalLevel(this.street, s.t);
    this.loops.port?.setLevel(1 - street, 0.5);
    this.loops.street?.setLevel(street, 0.5);
    this.loops.river?.setLevel(riverLevel(this.edge, s.x, s.z), 0.4);
    this.loops.beeper?.setLevel(zoneLevel(this.handlers, s.x, s.z, BEEPER_RADIUS_M, BEEPER_FULL_M), 0.3);

    const crane = nearest(this.cranes, s.x, s.z);
    if (this.clank.tick(dt, !!crane && crane.d <= CLANK_RADIUS_M) && crane)
      this.playAt(this.files.get('clank'), CLANK_GAIN, crane.p.x, s.y + 10, crane.p.z);
    if (this.scooter.tick(dt, street > 0.5)) this.playAt(this.files.get('scooter'), SCOOTER_GAIN, s.x, s.y + 1, s.z);

    const near = Math.hypot(this.landing.x - s.x, this.landing.z - s.z) <= FERRY_EARSHOT_M;
    const passing = this.lastT !== null && !!this.approach && entered(this.lastT, s.t, this.approach);
    if (this.ferry.tick(dt, near, passing))
      this.playAt(this.files.get('ferry'), FERRY_GAIN, this.landing.x, 6, this.landing.z);

    // Ship horn once a lap from the nearest ship on the river.
    if (this.lastT !== null && crossed(this.lastT, s.t, SHIP_HORN_T)) {
      const ship = nearest(this.ships, s.x, s.z);
      if (ship) this.playAt(this.files.get('ship'), SHIP_GAIN, ship.p.x, 15, ship.p.z);
    }
    this.lastT = s.t;

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
