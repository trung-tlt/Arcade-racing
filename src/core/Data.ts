import carsJson from '../../data/cars.json';
import weaponsJson from '../../data/weapons.json';
import handlingJson from '../../data/handling.json';
import aiJson from '../../data/ai.json';
import audioJson from '../../data/audio.json';
import combatJson from '../../data/combat.json';
import lightingJson from '../../data/lighting.json';
import raceJson from '../../data/race.json';
import uiSoundsJson from '../../data/ui_sounds.json';
import congHoaJson from '../../data/tracks/cong_hoa.json';
import catLaiJson from '../../data/tracks/cat_lai.json';
import xaLoJson from '../../data/tracks/xa_lo_ha_noi.json';

export type VehicleType = 'car' | 'apc8x8' | 'bike';

export interface WheelDef {
  name: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  width: number;
  steer: boolean;
}

export interface CarDef {
  id: string;
  name: string;
  vehicleType: VehicleType;
  role?: string;
  /** Gun mount yaw limit in degrees (25 cars, 360 hauler/APC, 15 bike). */
  turretYawDeg: number;
  /** Bike only: max visual lean in degrees. */
  maxLeanDeg?: number;
  file: string;
  paint: string;
  collider: { halfExtents: [number, number, number]; center: [number, number, number] };
  wheels: WheelDef[];
  gunMount: [number, number, number];
  topSpeedKmh: number;
  accel: number;
  handling: number;
  hp: number;
  massKg: number;
  grip: number;
  drift: number;
  nitroBoost: number;
  nitroBarSec: number;
  ramDamageMul: number;
}

export type HandlingDef = typeof handlingJson;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(isNum);

/** Returns a list of schema problems; empty means valid. */
export function validateCars(data: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(data) || data.length === 0) return ['cars.json must be a non-empty array'];
  for (const [i, c] of (data as Record<string, unknown>[]).entries()) {
    const at = `cars[${i}]`;
    for (const k of ['id', 'name', 'file', 'paint']) {
      if (typeof c[k] !== 'string') errors.push(`${at}.${k} must be a string`);
    }
    for (const k of [
      'topSpeedKmh',
      'accel',
      'handling',
      'hp',
      'massKg',
      'grip',
      'drift',
      'nitroBoost',
      'nitroBarSec',
      'ramDamageMul',
    ]) {
      if (!isNum(c[k]) || (c[k] as number) <= 0) errors.push(`${at}.${k} must be a positive number`);
    }
    const col = c.collider as { halfExtents?: unknown; center?: unknown } | undefined;
    if (!col || !isVec3(col.halfExtents) || !isVec3(col.center)) errors.push(`${at}.collider invalid`);
    if (!isVec3(c.gunMount)) errors.push(`${at}.gunMount must be vec3`);
    const wheels = c.wheels as Record<string, unknown>[] | undefined;
    const type = c.vehicleType;
    const expected: Record<string, string[]> = {
      car: ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'],
      apc8x8: ['1L', '1R', '2L', '2R', '3L', '3R', '4L', '4R'].map((n) => `wheel_${n}`),
      bike: ['wheel_F', 'wheel_R'],
    };
    if (typeof type !== 'string' || !(type in expected)) errors.push(`${at}.vehicleType must be car | apc8x8 | bike`);
    if (!isNum(c.turretYawDeg) || (c.turretYawDeg as number) <= 0) errors.push(`${at}.turretYawDeg must be positive`);
    if (type === 'bike' && !isNum(c.maxLeanDeg)) errors.push(`${at}.maxLeanDeg required for bikes`);
    const want = expected[type as string];
    if (!Array.isArray(wheels) || !want || wheels.length !== want.length) {
      errors.push(`${at}.wheels must have ${want?.length ?? '?'} entries for ${String(type)}`);
    } else {
      const names = wheels.map((w) => w.name);
      for (const n of want) {
        if (!names.includes(n)) errors.push(`${at}.wheels missing ${n}`);
      }
      for (const w of wheels) {
        for (const k of ['x', 'y', 'z', 'radius', 'width']) {
          if (!isNum(w[k])) errors.push(`${at}.wheels.${String(w.name)}.${k} must be a number`);
        }
      }
    }
  }
  return errors;
}

export function validateWeapons(data: unknown): string[] {
  const errors: string[] = [];
  const w = data as Record<string, Record<string, unknown>> | null;
  if (!w || typeof w !== 'object') return ['weapons.json must be an object'];
  const mg = w.pulse_mg;
  for (const k of ['fireRatePerSec', 'damage', 'rangeM', 'autoAimConeDeg', 'heatPerShot', 'overheatLockoutSec']) {
    if (!mg || !isNum(mg[k])) errors.push(`pulse_mg.${k} must be a number`);
  }
  const rk = w.hornet_rocket;
  for (const k of ['ammoPerPickup', 'speedMps', 'damage', 'splashRadiusM', 'lifetimeSec']) {
    if (!rk || !isNum(rk[k])) errors.push(`hornet_rocket.${k} must be a number`);
  }
  if (!Array.isArray(w.damageStates)) errors.push('damageStates must be an array');
  if (!w.wreck || !isNum(w.wreck.respawnDelaySec)) errors.push('wreck.respawnDelaySec must be a number');
  return errors;
}

export function validateTrack(data: unknown): string[] {
  const errors: string[] = [];
  const t = data as Record<string, unknown> | null;
  if (!t || typeof t !== 'object') return ['track must be an object'];
  const pts = (t.spline as { points?: unknown[] } | undefined)?.points;
  if (!Array.isArray(pts) || pts.length < 4 || !pts.every(isVec3)) errors.push('spline.points invalid');
  const cps = t.checkpoints as { id: number; t: number }[] | undefined;
  if (!Array.isArray(cps) || cps.length !== 8) errors.push('track needs exactly 8 checkpoints');
  else if (cps.some((c, i) => i > 0 && c.t <= cps[i - 1].t)) errors.push('checkpoint t must increase');
  const layout = t.roadLayout as
    | { carriagewayWidthM?: unknown; mainCarriageway?: { widthM?: unknown }; truckRoad?: { widthM?: unknown } }
    | undefined;
  const layoutW = layout?.carriagewayWidthM ?? layout?.mainCarriageway?.widthM ?? layout?.truckRoad?.widthM;
  if (!isNum(t.laps) || !(isNum(t.roadWidthM) || isNum(layoutW))) errors.push('laps and a road width must be numbers');
  const grid = (t.startLine as { grid?: unknown[] } | undefined)?.grid;
  if (!Array.isArray(grid) || grid.length !== 6) errors.push('startLine.grid needs 6 slots');
  return errors;
}

export type TimeOfDay = 'night' | 'day' | 'dusk';

export interface DayLighting {
  sun: { dir: [number, number, number]; color: string; intensity: number };
  hemi: { sky: string; ground: string; intensity: number };
  fog: { color: string; density: number };
  /** Gradient texture used as the scene background. */
  sky: string;
  bloom: { strength: number; threshold: number };
  toneMappingExposure: number;
}

/** One playable map, normalised from its JSON (cat_lai.json / cong_hoa.json / xa_lo_ha_noi.json). */
export interface TrackDef {
  id: string;
  name: string;
  timeOfDay: TimeOfDay;
  laps: number;
  lapLengthM: number;
  /** Width of the drivable carriageway the racing line runs on. */
  roadWidthM: number;
  spline: { points: [number, number, number][] };
  startLine: { grid: [number, number][] };
  checkpoints: { id: number; t: number }[];
  ramps: { t: number; heightM: number; lengthM: number; model: string }[];
  pickups: { t: number; items: { type: string; lane: number }[] }[];
  /** Lateral offsets of the three pickup / racing lanes, +X = the car's left. */
  laneOffsetsM: number[];
  roadTexture: string;
  /** Metres of road per texture repeat along the road. */
  roadTextureRepeatM: number;
  /** Elevation in the spline (bridge, underpass, hump): the road is a 3D ribbon and the ground sits below it. */
  hasElevation: boolean;
  /** Y of the physics ground plane: 0 on flat maps, well below the lowest road point on maps with an underpass. */
  groundY: number;
  /** Stretches where the carriageway is a different width / texture (e.g. the 8 m frontage road). Empty = constant. */
  widthProfile: { fromT: number; toT: number; widthM: number; texture: string }[];
  /** Set for day and dusk maps; night maps use data/lighting.json. */
  daylight: DayLighting | null;
  /** The untouched JSON, for map-specific dressing (sections, dressing, flyover, traffic...). */
  raw: Record<string, unknown>;
}

interface RawTrack {
  id: string;
  name: string;
  timeOfDay?: TimeOfDay;
  laps: number;
  lapLengthM: number;
  roadWidthM?: number;
  roadLayout?: {
    carriagewayWidthM?: number;
    lanesPerDirection?: number;
    roadTexture?: string;
    mainCarriageway?: { widthM: number; lanes: number; texture: string };
    frontageRoad?: { widthM: number; lanes: number; texture: string };
    truckRoad?: { widthM: number; lanes: number; texture: string };
    portLanes?: { widthM: number; texture: string };
    yardLanes?: { widthM: number };
  };
  sections?: { id: string; name: string; fromT: number; toT: number }[];
  laneOffsetsM?: number[];
  spline: { points: [number, number, number][] };
  startLine: { grid: [number, number][] };
  checkpoints: { id: number; t: number }[];
  ramps?: TrackDef['ramps'];
  pickups: TrackDef['pickups'];
  dressing?: { lighting?: DayLighting };
}

export function loadTrack(json: unknown): TrackDef {
  const r = json as RawTrack;
  const main = r.roadLayout?.mainCarriageway ?? r.roadLayout?.truckRoad;
  const width = main?.widthM ?? r.roadLayout?.carriagewayWidthM ?? r.roadWidthM ?? 18;
  // Lanes across the racing carriageway: the old maps list lanes per direction, Map 3 lists the 4 lanes of its road.
  const lanes = main?.lanes ?? r.roadLayout?.lanesPerDirection ?? 3;
  const laneW = width / lanes;
  const laneOffsets = r.laneOffsetsM ?? Array.from({ length: lanes }, (_, i) => (i - (lanes - 1) / 2) * laneW);
  const ys = r.spline.points.map((p) => p[1]);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const hasElevation = maxY - minY > 0.5;
  // Stretches with their own width / texture: Map 3's frontage road, Cat Lai's gate, yard and quay apron.
  const widthProfile: TrackDef['widthProfile'] = [];
  const section = (test: (x: { id: string; name: string }) => boolean) => r.sections?.find(test);
  const front = r.roadLayout?.frontageRoad;
  const frontSection = front ? section((x) => /frontage/i.test(x.name)) : undefined;
  if (front && frontSection) {
    widthProfile.push({
      fromT: frontSection.fromT,
      toT: frontSection.toT,
      widthM: front.widthM,
      texture: 'textures/day_road_3lane.png',
    });
  }
  const port = r.roadLayout?.portLanes;
  if (port) {
    for (const id of ['B', 'C', 'D']) {
      const sec = section((x) => x.id === id);
      if (!sec) continue;
      const widthM = id === 'C' ? (r.roadLayout?.yardLanes?.widthM ?? port.widthM) : port.widthM;
      widthProfile.push({ fromT: sec.fromT, toT: sec.toT, widthM, texture: port.texture });
    }
  }
  return {
    id: r.id,
    name: r.name,
    timeOfDay: r.timeOfDay ?? 'night',
    laps: r.laps,
    lapLengthM: r.lapLengthM,
    roadWidthM: width,
    spline: r.spline,
    startLine: r.startLine,
    checkpoints: r.checkpoints,
    ramps: r.ramps ?? [],
    pickups: r.pickups,
    laneOffsetsM: laneOffsets,
    roadTexture: main?.texture ?? r.roadLayout?.roadTexture ?? 'textures/road_lanes.png',
    roadTextureRepeatM: r.roadLayout ? (main ? 16 : 12) : raceJson.track.roadTextureRepeatM,
    hasElevation,
    groundY: minY < -1 ? Math.floor(minY) - 3 : 0,
    widthProfile,
    daylight: r.dressing?.lighting ?? null,
    raw: json as Record<string, unknown>,
  };
}

/** Carriageway width at along-track `t`: `roadWidthM`, or the narrower profile stretch with a short blend at each end. */
export function roadWidthAt(def: TrackDef, t: number): number {
  const blendT = 40 / def.lapLengthM;
  let w = def.roadWidthM;
  const tt = t - Math.floor(t);
  for (const p of def.widthProfile) {
    const k = Math.min(1, Math.max(0, Math.min(tt - p.fromT, p.toT - tt) / blendT + 0.0));
    const f = k * k * (3 - 2 * k);
    w = w + (p.widthM - w) * f;
  }
  return w;
}

export const RACE = raceJson;
export const AI = aiJson;
export const UI_SOUNDS = uiSoundsJson;
export const LIGHTING = lightingJson;
export const COMBAT = combatJson;
export const AUDIO = audioJson;
export const CAT_LAI = loadTrack(catLaiJson);
export const CONG_HOA = loadTrack(congHoaJson);
/** Every map, in menu order. */
export const XA_LO = loadTrack(xaLoJson);
export const TRACKS: readonly TrackDef[] = [CAT_LAI, CONG_HOA, XA_LO];

export function getTrack(id: string): TrackDef {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown track "${id}"`);
  return t;
}

export const CARS = carsJson as unknown as CarDef[];
export const WEAPONS = weaponsJson;
export const HANDLING: HandlingDef = structuredClone(handlingJson);

export function getCarDef(id: string): CarDef {
  const def = CARS.find((c) => c.id === id);
  if (!def) throw new Error(`Unknown car "${id}"`);
  return def;
}
