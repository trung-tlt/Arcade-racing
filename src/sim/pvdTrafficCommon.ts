import type { TrackDef } from '../core/Data';
import { seededRng, type RoadPath } from './trafficCommon';

// Ambient-traffic planning for Map 4 shared by the browser's traffic scenery and the headless sim (no DOM / GL).

/** Kind indices as on Map 3 (`debugTrafficTs(kind)`): 0 is unused, 1 cars, 2 buses, 3 scooters. */
export const KIND = { cars: 1, buses: 2, scooters: 3 } as const;
export type KindKey = keyof typeof KIND;
export const KIND_KEYS: readonly KindKey[] = ['cars', 'buses', 'scooters'];

/** Traffic keeps this far past the start line free (a car at race speed covers it in about three seconds). */
export const KEEP_OUT_AHEAD_OF_LINE_M = 170;
/** Zones stop this far short of the U-turn flyover and of the final U-turn. */
export const ZONE_END_MARGIN_M = 40;
/** Zones stop this far short of / past the Binh Loi bridge. */
export const BRIDGE_PAD_M = 60;
/** "In the flooded dip scooters crawl at 8 km/h" (pham_van_dong.json `ambientTraffic.lanes`). */
export const FLOOD_CRAWL_KMH = 8;
/** How long a bus stands at a rain shelter. */
export const BUS_DWELL_SEC = 12;
/** Shares of the data's scooter and car counts that run on the outbound half; the rest run on the return half. */
export const OUTBOUND_SCOOTER_SHARE = 0.35;
export const OUTBOUND_CAR_SHARE = 0.5;

// ---------------------------------------------------------------------------------------------
// Pure helpers (no DOM / GL): all the numbers live here so they can be unit tested.
// ---------------------------------------------------------------------------------------------

export interface Zone {
  fromT: number;
  toT: number;
}

export interface PvdZones {
  /** Start straight (after the keep-out) up to the bridge. */
  outA: Zone;
  /** After the bridge to the U-turn flyover. */
  outB: Zone;
  /** After the flyover to the return bridge. */
  retA: Zone;
  /** After the return bridge to the final U-turn. */
  retB: Zone;
  /** `retA` from the far side of the flooded dip: the car lanes do not dip, so cars only run here. */
  retDry: Zone;
}

export type ZoneKey = keyof PvdZones;
export const ZONE_KEYS: readonly ZoneKey[] = ['outA', 'outB', 'retA', 'retB', 'retDry'];

const lenM = (z: Zone, lapLengthM: number): number => (z.toT - z.fromT) * lapLengthM;

/** t interval of a half of the lap whose centre line lies between N = fromN and N = toN metres north (z = −N). */
export function bridgeInterval(
  path: RoadPath,
  halfFromT: number,
  halfToT: number,
  fromN: number,
  toN: number,
): Zone | null {
  let from = Infinity;
  let to = -Infinity;
  for (let i = 0; i < path.count; i++) {
    const t = i / path.count;
    if (t < halfFromT || t > halfToT) continue;
    const n = -path.pz[i];
    if (n >= fromN && n <= toN) {
      from = Math.min(from, t);
      to = Math.max(to, t);
    }
  }
  return to >= from ? { fromT: from, toT: to } : null;
}

export interface ZoneInput {
  lapLengthM: number;
  /** Section bounds: the start straight's start (0), the U-turn flyover's start and end, the return's end. */
  outFromT: number;
  flyoverFromT: number;
  flyoverToT: number;
  returnToT: number;
  bridgeOut: Zone;
  bridgeRet: Zone;
  /** Where the flooded dip ends. */
  floodToT: number;
}

/** The four loop zones: each half of the lap minus the start keep-out, the flyover, the final U-turn and the bridges. */
export function trafficZones(i: ZoneInput): PvdZones {
  const m = ZONE_END_MARGIN_M / i.lapLengthM;
  const pad = BRIDGE_PAD_M / i.lapLengthM;
  const start = i.outFromT + KEEP_OUT_AHEAD_OF_LINE_M / i.lapLengthM;
  return {
    outA: { fromT: start, toT: i.bridgeOut.fromT - pad },
    outB: { fromT: i.bridgeOut.toT + pad, toT: i.flyoverFromT - m },
    retA: { fromT: i.flyoverToT + m, toT: i.bridgeRet.fromT - pad },
    retB: { fromT: i.bridgeRet.toT + pad, toT: i.returnToT - m },
    retDry: { fromT: Math.max(i.flyoverToT + m, i.floodToT + m), toT: i.bridgeRet.fromT - pad },
  };
}

/** One leg of a vehicle's cycle: it covers `lenM` metres in `durSec` seconds (`lenM` = 0 is a dwell). */
export interface Segment {
  lenM: number;
  durSec: number;
}

export interface Schedule {
  segs: readonly Segment[];
  cycleSec: number;
  lengthM: number;
}

export function makeSchedule(segs: readonly Segment[]): Schedule {
  const live = segs.filter((s) => s.lenM > 0 || s.durSec > 0);
  return {
    segs: live,
    cycleSec: live.reduce((a, s) => a + s.durSec, 0),
    lengthM: live.reduce((a, s) => a + s.lenM, 0),
  };
}

/** Metres from the start of the zone after `timeSec` of the cycle (the cycle repeats, so it wraps). */
export function scheduleDistance(s: Schedule, timeSec: number): number {
  if (s.cycleSec <= 0) return 0;
  let t = ((timeSec % s.cycleSec) + s.cycleSec) % s.cycleSec;
  let d = 0;
  for (const seg of s.segs) {
    if (t < seg.durSec) return d + (seg.durSec > 0 ? (seg.lenM * t) / seg.durSec : 0);
    t -= seg.durSec;
    d += seg.lenM;
  }
  return d;
}

/** A plain run at `speedMps`, crawling at `crawlMps` through the metres [crawlFromM, crawlToM] (when they overlap). */
export function runSchedule(
  zoneLenM: number,
  speedMps: number,
  crawl: { fromM: number; toM: number; mps: number } | null,
): Schedule {
  if (!crawl || crawl.toM <= 0 || crawl.fromM >= zoneLenM)
    return makeSchedule([{ lenM: zoneLenM, durSec: zoneLenM / speedMps }]);
  const a = Math.max(0, crawl.fromM);
  const b = Math.min(zoneLenM, crawl.toM);
  return makeSchedule([
    { lenM: a, durSec: a / speedMps },
    { lenM: b - a, durSec: (b - a) / crawl.mps },
    { lenM: zoneLenM - b, durSec: (zoneLenM - b) / speedMps },
  ]);
}

/** A run at `speedMps` that stands for `dwellSec` at each stop (metres from the zone start, any order). */
export function busSchedule(zoneLenM: number, speedMps: number, stopsM: readonly number[], dwellSec: number): Schedule {
  const stops = stopsM.filter((s) => s > 0 && s < zoneLenM).sort((x, y) => x - y);
  const segs: Segment[] = [];
  let at = 0;
  for (const s of stops) {
    segs.push({ lenM: s - at, durSec: (s - at) / speedMps }, { lenM: 0, durSec: dwellSec });
    at = s;
  }
  segs.push({ lenM: zoneLenM - at, durSec: (zoneLenM - at) / speedMps });
  return makeSchedule(segs);
}

/** Lateral offset (m, + = to the vehicle's right) of lane `lane` (0 = rightmost) of a band `bandWidthM` wide. */
export function laneOffsetInBand(bandWidthM: number, lanes: number, lane: number): number {
  return bandWidthM / 2 - (bandWidthM / lanes) * (lane + 0.5);
}

/** Where the lanes sit across the boulevard, from `roadLayout.crossSectionFromCentre`. */
export interface Bands {
  carWidthM: number;
  carLanes: number;
  motoWidthM: number;
  motoLanes: number;
  /** Distance between the centres of the car lanes and the motorbike lanes of one side. */
  deltaM: number;
}

export interface CrossPart {
  part: string;
  widthM: number;
}

export function bandsOf(cross: readonly CrossPart[]): Bands {
  const car = cross.find((p) => /car lanes/i.test(p.part));
  const moto = cross.find((p) => /motorbike/i.test(p.part));
  if (!car || !moto) throw new Error('roadLayout.crossSectionFromCentre needs car lanes and motorbike lanes');
  const lanesOf = (p: CrossPart, fallback: number): number => Number(/x(\d+)/.exec(p.part)?.[1] ?? fallback);
  let carCentre = 0;
  let motoCentre = 0;
  let at = 0;
  for (const p of cross) {
    if (p === car) carCentre = at + p.widthM / 2;
    if (p === moto) motoCentre = at + p.widthM / 2;
    at += p.widthM;
  }
  return {
    carWidthM: car.widthM,
    carLanes: lanesOf(car, 3),
    motoWidthM: moto.widthM,
    motoLanes: lanesOf(moto, 2),
    deltaM: motoCentre - carCentre,
  };
}

export interface Shelter {
  /** Along-track position. */
  t: number;
  /** Which half of the lap's racing line it is nearest to. */
  half: 'out' | 'ret';
}

/** Along-track position and half of the road sample nearest to (x, z): where a shelter's bus stops. */
export function shelterStop(path: RoadPath, x: number, z: number, splitT: number): Shelter {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.count; i++) {
    const d = (path.px[i] - x) ** 2 + (path.pz[i] - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const t = best / path.count;
  return { t, half: t < splitT ? 'out' : 'ret' };
}

export interface PvdSpec {
  /** KIND value. */
  kind: number;
  /** Index into that kind's model list. */
  model: number;
  zone: ZoneKey;
  /** Lateral offset of the band's centre from the racing line (+ = right of the heading). */
  bandM: number;
  /** Lateral offset of the lane inside the band, plus jitter. */
  laneM: number;
  /** Per-instance brightness variety. */
  tint: number;
  schedule: Schedule;
  /** Where in its cycle the vehicle is at t = 0. */
  offsetSec: number;
}

export interface PlanInput {
  seed: number;
  lapLengthM: number;
  speedKmh: readonly [number, number];
  counts: { scooters: number; cars: number; buses: number };
  models: { scooters: number; cars: number; buses: number };
  zones: PvdZones;
  flood: Zone;
  bands: Bands;
  shelters: readonly Shelter[];
}

const TINT_MIN = 0.8;

/** Splits `count` vehicles over the zones in proportion to their length (every zone gets at least one when it can). */
export function spreadOverZones(count: number, zones: readonly { key: ZoneKey; lenM: number }[]): ZoneKey[] {
  const out: ZoneKey[] = [];
  const total = zones.reduce((a, z) => a + z.lenM, 0);
  if (count <= 0 || total <= 0) return out;
  const share = zones.map((z) => (z.lenM / total) * count);
  const given = share.map((v) => Math.floor(v));
  // The vehicles left over go to the zones with the biggest remainders (largest-remainder rounding).
  const order = share.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  for (let left = count - given.reduce((a, g) => a + g, 0), k = 0; left > 0; left--, k = (k + 1) % order.length) {
    given[order[k].i]++;
  }
  zones.forEach((z, i) => {
    for (let k = 0; k < given[i]; k++) out.push(z.key);
  });
  return out;
}

/**
 * Deterministic plan for every vehicle. Scooters: the east motorbike lanes (outbound zones) and the racing motorbike
 * lanes (return zones, crawling through the flooded dip). Cars: the racing car lanes' right lane (outbound) and the
 * west car lanes (return, after the dip). Buses: the motorbike lanes' curb lane, dwelling at the rain shelters.
 */
export function planPvdTraffic(inp: PlanInput): PvdSpec[] {
  const rng = seededRng(inp.seed);
  const L = inp.lapLengthM;
  const [vMin, vMax] = inp.speedKmh;
  const speed = (): number => (vMin + rng() * (vMax - vMin)) / 3.6;
  const crawlMps = FLOOD_CRAWL_KMH / 3.6;
  const b = inp.bands;
  const z = inp.zones;
  const out: PvdSpec[] = [];
  const zoneLen = (k: ZoneKey): number => lenM(z[k], L);
  const crawlIn = (k: ZoneKey): { fromM: number; toM: number; mps: number } => ({
    fromM: (inp.flood.fromT - z[k].fromT) * L,
    toM: (inp.flood.toT - z[k].fromT) * L,
    mps: crawlMps,
  });
  const push = (spec: Omit<PvdSpec, 'offsetSec' | 'tint'>): void => {
    out.push({ ...spec, tint: TINT_MIN + rng() * (1 - TINT_MIN), offsetSec: rng() * spec.schedule.cycleSec });
  };

  // Scooters.
  const nOutS = Math.round(inp.counts.scooters * OUTBOUND_SCOOTER_SHARE);
  const scooterZones = [
    ...spreadOverZones(
      nOutS,
      ['outA', 'outB'].map((key) => ({ key: key as ZoneKey, lenM: zoneLen(key as ZoneKey) })),
    ).map((k) => ({
      k,
      out: true,
    })),
    ...spreadOverZones(
      inp.counts.scooters - nOutS,
      ['retA', 'retB'].map((key) => ({ key: key as ZoneKey, lenM: zoneLen(key as ZoneKey) })),
    ).map((k) => ({ k, out: false })),
  ];
  for (const { k, out: outbound } of scooterZones) {
    const lane = outbound ? Math.floor(rng() * b.motoLanes) : 0; // the racing lanes: the curb lane only
    push({
      kind: KIND.scooters,
      model: inp.models.scooters > 0 ? Math.floor(rng() * inp.models.scooters) : 0,
      zone: k,
      bandM: outbound ? b.deltaM : 0,
      laneM: laneOffsetInBand(b.motoWidthM, b.motoLanes, lane) + (rng() - 0.5) * 0.5,
      schedule: runSchedule(zoneLen(k), speed(), k === 'retA' || k === 'retB' ? crawlIn(k) : null),
    });
  }

  // Cars (cars skip the dip: the car lanes do not go down into it).
  const nOutC = Math.round(inp.counts.cars * OUTBOUND_CAR_SHARE);
  const carZones = [
    ...spreadOverZones(
      nOutC,
      ['outA', 'outB'].map((key) => ({ key: key as ZoneKey, lenM: zoneLen(key as ZoneKey) })),
    ).map((k) => ({
      k,
      out: true,
    })),
    ...spreadOverZones(
      inp.counts.cars - nOutC,
      ['retDry', 'retB'].map((key) => ({ key: key as ZoneKey, lenM: zoneLen(key as ZoneKey) })),
    ).map((k) => ({ k, out: false })),
  ];
  for (const { k, out: outbound } of carZones) {
    const lane = outbound ? 0 : Math.floor(rng() * b.carLanes);
    push({
      kind: KIND.cars,
      model: inp.models.cars > 0 ? Math.floor(rng() * inp.models.cars) : 0,
      zone: k,
      bandM: outbound ? 0 : -b.deltaM,
      laneM: laneOffsetInBand(b.carWidthM, b.carLanes, lane) + (rng() - 0.5) * 0.6,
      schedule: runSchedule(zoneLen(k), speed(), null),
    });
  }

  // Buses: one east (start straight), one east (after the bridge), one west (the return half before its bridge).
  const busZones: { zone: ZoneKey; outbound: boolean }[] = [
    { zone: 'outA', outbound: true },
    { zone: 'outB', outbound: true },
    { zone: 'retA', outbound: false },
  ];
  for (let i = 0; i < inp.counts.buses; i++) {
    const { zone, outbound } = busZones[i % busZones.length];
    const stops = inp.shelters
      .filter((s) => (s.half === 'out') === outbound && s.t > z[zone].fromT && s.t < z[zone].toT)
      .map((s) => (s.t - z[zone].fromT) * L);
    push({
      kind: KIND.buses,
      model: inp.models.buses > 0 ? Math.floor(rng() * inp.models.buses) : 0,
      zone,
      bandM: outbound ? b.deltaM : 0,
      laneM: laneOffsetInBand(b.motoWidthM, b.motoLanes, 0) + (rng() - 0.5) * 0.3,
      schedule: busSchedule(zoneLen(zone), speed(), stops, BUS_DWELL_SEC),
    });
  }
  return out;
}

/** Loop position (0..1 of the lap) of a vehicle after `timeSec`. */
export function trafficT(spec: PvdSpec, zones: PvdZones, lapLengthM: number, timeSec: number): number {
  return zones[spec.zone].fromT + scheduleDistance(spec.schedule, timeSec + spec.offsetSec) / lapLengthM;
}

export interface RawPvd {
  roadLayout: { crossSectionFromCentre: CrossPart[] };
  sections: { id: string; name: string; fromT: number; toT: number }[];
  weather: { flood: { fromT: number; toT: number } };
  bridge: { binhLoi: { fromN: number; toN: number } };
  dressing: { shelters: { positions: [number, number, number][] } };
  ambientTraffic: {
    ponchoScooters: number;
    cars: number;
    buses: number;
    speedKmh: [number, number];
    models: Record<'scooters' | 'cars' | 'buses', string[]>;
    vehicleSizesM: Record<'scooter' | 'car' | 'bus', [number, number, number]>;
  };
}

export const SIZE_KEY: Record<KindKey, 'scooter' | 'car' | 'bus'> = { cars: 'car', buses: 'bus', scooters: 'scooter' };
export const MODEL_KEY: Record<KindKey, 'scooters' | 'cars' | 'buses'> = {
  cars: 'cars',
  buses: 'buses',
  scooters: 'scooters',
};
export const PLAN_SEED = 2013;

/** The zones, bands and shelter stops of Map 4, read from its JSON and the racing path. */
export function layoutOf(
  track: TrackDef,
  path: RoadPath,
): { zones: PvdZones; bands: Bands; shelters: Shelter[]; flood: Zone } {
  const raw = track.raw as unknown as RawPvd;
  const sec = (id: string): { fromT: number; toT: number } => {
    const s = raw.sections.find((x) => x.id === id);
    if (!s) throw new Error(`pham_van_dong.json has no section ${id}`);
    return s;
  };
  const flyover = sec('F');
  const splitT = (flyover.fromT + flyover.toT) / 2;
  const { fromN, toN } = raw.bridge.binhLoi;
  const bridgeOut = bridgeInterval(path, 0, splitT, fromN, toN) ?? { fromT: 0.11, toT: 0.23 };
  const bridgeRet = bridgeInterval(path, splitT, 1, fromN, toN) ?? { fromT: 0.72, toT: 0.85 };
  const zones = trafficZones({
    lapLengthM: path.lengthM,
    outFromT: sec('A').fromT,
    flyoverFromT: flyover.fromT,
    flyoverToT: flyover.toT,
    returnToT: sec('H').toT,
    bridgeOut,
    bridgeRet,
    floodToT: raw.weather.flood.toT,
  });
  return {
    zones,
    bands: bandsOf(raw.roadLayout.crossSectionFromCentre),
    shelters: raw.dressing.shelters.positions.map((p) => shelterStop(path, p[0], p[2], splitT)),
    flood: raw.weather.flood,
  };
}
