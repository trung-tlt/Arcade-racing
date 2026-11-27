import type { TrackDef } from '../core/Data';
import type { EventBus } from '../core/Events';
import type { AudioBus } from './AudioBus';
import { crossed, zoneLevel } from './ArdennesAudio';

/**
 * Map 7's sound bed, driven by the track JSON's `audio` block: the autumn-evening loop everywhere, the hill crowd within
 * 90 m of a stand, the distant amusement park around the wheel, the positional whoosh of each car passing under the
 * crossover bridge, and the PA chime on the grid and as the final lap starts.
 */
interface AudioBlock {
  ambience?: { sfx: string; where?: string; volume: number }[];
  events?: { sfx: string; when?: string }[];
}

type Pt = { x: number; z: number };

/** The crowd is audible this far (m) from a stand, and at full level inside `CROWD_FULL_M`. */
export const CROWD_RADIUS_M = 90;
export const CROWD_FULL_M = 30;
/** The amusement park is heard within this distance (m) of the wheel, full inside `PARK_FULL_M`. */
export const PARK_RADIUS_M = 500;
export const PARK_FULL_M = 150;
/** A car must be at least this fast (km/h) for its pass under the bridge to whoosh. */
export const WHOOSH_MIN_KMH = 60;
const WHOOSH_GAIN = 0.8;
const CHIME_GAIN = 0.7;

export interface SuzukaPlacements {
  groups: Record<string, { model?: string; x: number; z: number }[]>;
}

export interface AudioState {
  /** The player's along-track t, lap (1-based) and position. */
  t: number;
  lap: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Every car, for the under-bridge whoosh. */
  cars: { id: string; t: number; x: number; y: number; z: number; speedKmh: number }[];
}

export function trackAudioFiles(def: TrackDef): string[] {
  const a = def.raw.audio as AudioBlock | undefined;
  if (!a) return [];
  return [...new Set([...(a.ambience ?? []).map((x) => x.sfx), ...(a.events ?? []).map((x) => x.sfx)])];
}

interface Loop {
  setLevel(level: number, rampSec?: number): void;
  stop(): void;
}

export class SuzukaAudio {
  private readonly stands: Pt[];
  private readonly wheel: Pt[];
  private readonly loops: Record<'autumn' | 'crowd' | 'park', Loop | null>;
  private readonly files = new Map<string, string>();
  private readonly lastT = new Map<string, number>();
  private readonly crossT: number;
  private chimedGrid = false;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly bus: AudioBus,
    private readonly def: TrackDef,
    events: EventBus,
    placements: SuzukaPlacements,
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
    this.files.set('whoosh', find(/crossover_whoosh/).sfx);
    this.files.set('chime', find(/pa_chime/).sfx);
    this.loops = { autumn: mk(/autumn_evening/), crowd: mk(/hill_crowd/), park: mk(/park_far/) };
    const g = placements.groups ?? {};
    this.stands = (g.stands ?? []).filter((s) => !/spectators_/.test(s.model ?? '')).map((s) => ({ x: s.x, z: s.z }));
    const wheel = (g.landmarks ?? []).find((p) => /ferris_wheel/.test(p.model ?? ''));
    this.wheel = wheel ? [{ x: wheel.x, z: wheel.z }] : [];
    this.crossT = (def.raw.crossover as { lowerT?: number } | undefined)?.lowerT ?? 0.4755;
    // The chime again as the final lap starts.
    this.offs.push(
      events.on('lapComplete', (e) => {
        if (e.carId === 'player' && e.lap + 1 === this.def.laps) this.playFlat('chime', CHIME_GAIN);
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
    panner.refDistance = 30;
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

  update(_dt: number, s: AudioState): void {
    this.loops.autumn?.setLevel(1, 0.5);
    this.loops.crowd?.setLevel(zoneLevel(this.stands, s.x, s.z, CROWD_RADIUS_M, CROWD_FULL_M), 0.3);
    this.loops.park?.setLevel(zoneLevel(this.wheel, s.x, s.z, PARK_RADIUS_M, PARK_FULL_M), 0.4);
    if (!this.chimedGrid) {
      this.chimedGrid = true;
      this.playFlat('chime', CHIME_GAIN);
    }
    for (const c of s.cars) {
      const prev = this.lastT.get(c.id);
      this.lastT.set(c.id, c.t);
      if (prev !== undefined && c.speedKmh >= WHOOSH_MIN_KMH && crossed(prev, c.t, this.crossT))
        this.playAt(this.files.get('whoosh'), WHOOSH_GAIN, c.x, c.y, c.z);
    }
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
