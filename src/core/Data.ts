import carsJson from '../../data/cars.json';
import weaponsJson from '../../data/weapons.json';
import handlingJson from '../../data/handling.json';
import fpvJson from '../../data/fpv.json';
import aiJson from '../../data/ai.json';
import audioJson from '../../data/audio.json';
import combatJson from '../../data/combat.json';
import lightingJson from '../../data/lighting.json';
import raceJson from '../../data/race.json';
import uiSoundsJson from '../../data/ui_sounds.json';
import congHoaJson from '../../data/tracks/cong_hoa.json';
import catLaiJson from '../../data/tracks/cat_lai.json';
import phamVanDongJson from '../../data/tracks/pham_van_dong.json';
import xaLoJson from '../../data/tracks/xa_lo_ha_noi.json';
import monteCarloJson from '../../data/tracks/monte_carlo.json';
import ardennesJson from '../../data/tracks/ardennes.json';

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
  /** The real-world vehicle class the speed and acceleration are matched to (documentation only). */
  realWorld?: string;
  /** Gun mount yaw limit in degrees (25 cars, 360 hauler/APC, 15 bike). */
  turretYawDeg: number;
  /** Bike only: max visual lean in degrees. */
  maxLeanDeg?: number;
  file: string;
  paint: string;
  collider: { halfExtents: [number, number, number]; center: [number, number, number] };
  wheels: WheelDef[];
  gunMount: [number, number, number];
  /** Real-world top speed of the vehicle class this car is modelled on (km/h). */
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
  /** Pulse MG damage per hit and heat per shot, relative to weapons.json (fast cars shoot weak, slow ones hit hard). */
  gunDamageMul: number;
  gunHeatMul: number;
  /** Open-wheel racer (Fulmine FX): speed-squared downforce, high-speed grip, fragile wheels. */
  openWheel?: boolean;
  /** Downforce coefficient (see handling.json `openWheel`). */
  downforce?: number;
  /** Driver first-person view: `cockpit` shows the shared rig at `eye`; `helmet` keeps the vehicle's own fairing/halo. */
  fpv?: {
    mode: 'cockpit' | 'helmet';
    eye: [number, number, number];
    fovDeg: number;
    /** Cockpit only: the rig model and the colours for its bonnet (`paint`) and accent lights. */
    rig?: string;
    tint?: { paint: string; accent: string };
  };
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
      'gunDamageMul',
      'gunHeatMul',
    ]) {
      if (!isNum(c[k]) || (c[k] as number) <= 0) errors.push(`${at}.${k} must be a positive number`);
    }
    const col = c.collider as { halfExtents?: unknown; center?: unknown } | undefined;
    if (!col || !isVec3(col.halfExtents) || !isVec3(col.center)) errors.push(`${at}.collider invalid`);
    if (!isVec3(c.gunMount)) errors.push(`${at}.gunMount must be vec3`);
    if (c.openWheel !== undefined && typeof c.openWheel !== 'boolean') errors.push(`${at}.openWheel must be a boolean`);
    if (c.downforce !== undefined && (!isNum(c.downforce) || c.downforce <= 0))
      errors.push(`${at}.downforce must be a positive number`);
    if (c.openWheel === true && c.downforce === undefined) errors.push(`${at}.downforce required for openWheel`);
    const fpv = c.fpv as { mode?: unknown; eye?: unknown; fovDeg?: unknown } | undefined;
    if (
      fpv !== undefined &&
      (!['cockpit', 'helmet'].includes(String(fpv.mode)) || !isVec3(fpv.eye) || !isNum(fpv.fovDeg))
    )
      errors.push(`${at}.fpv needs mode cockpit | helmet, eye vec3 and fovDeg`);
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
  if (!Array.isArray(cps) || cps.length < 8 || cps.length > 9)
    errors.push('track needs 8 checkpoints (9 on Maps 4 and 5)');
  else if (cps.some((c, i) => i > 0 && c.t <= cps[i - 1].t)) errors.push('checkpoint t must increase');
  const layout = t.roadLayout as
    | { carriagewayWidthM?: unknown; mainCarriageway?: { widthM?: unknown }; truckRoad?: { widthM?: unknown } }
    | undefined;
  const streetW = (t.road as { widthM?: unknown } | undefined)?.widthM;
  const layoutW = layout?.carriagewayWidthM ?? layout?.mainCarriageway?.widthM ?? layout?.truckRoad?.widthM;
  if (!isNum(t.laps) || !(isNum(t.roadWidthM) || isNum(layoutW) || isNum(streetW)))
    errors.push('laps and a road width must be numbers');
  const grid = (t.startLine as { grid?: unknown[] } | undefined)?.grid;
  if (!Array.isArray(grid) || grid.length !== 6) errors.push('startLine.grid needs 6 slots');
  return errors;
}

export type TimeOfDay = 'night' | 'day' | 'dusk' | 'storm';

export interface DayLighting {
  sun: { dir: [number, number, number]; color: string; intensity: number };
  hemi: { sky: string; ground: string; intensity: number };
  fog: { color: string; density: number };
  /** Gradient texture used as the scene background. */
  sky: string;
  bloom: { strength: number; threshold: number };
  toneMappingExposure: number;
  /** Wet maps: the road material's look (low roughness so lamps and lights streak on it). */
  road?: { roughness: number; metalness: number };
  /** Map 5: sun glitter on the harbour water. */
  water?: { sunGlint: boolean };
}

/** A stretch where weapons can't fire (Map 5's tunnel and chicane). `fromT` < `toT`, both in [0, 1). */
export interface NoFireZone {
  name: string;
  fromT: number;
  toT: number;
}

/** Map 5's gantry start: 5 red lamps, one per second, then a random hold, then all out = GO. */
export interface StartLightsDef {
  model: string;
  position: [number, number, number];
  sfx: string;
}

/** Map 4's storm (`weather` in its JSON). Every other map has none. */
export interface WeatherDef {
  rain: {
    /** Per lap (the last value holds for later laps). */
    intensity: number[];
    particles: {
      texture: string;
      countDesktop: number;
      countMobile: number;
      fallSpeedMps: number;
      windSlant: number;
      boxAroundCameraM: [number, number, number];
    };
  };
  grip: { wetMul: number; puddleMul: number; floodMul: number; brakeDistanceMul: number };
  puddles: {
    decal: string;
    material: { roughness: number; metalness: number; polygonOffset: number };
    items: { t: number; lateralM: number; radiusM: number }[];
  };
  flood: { fromT: number; toT: number; waterY: number; waterColor: string; dragMul: number; sprayFx: string };
  spray: { texture: string; fromRearWheelsAboveKmh: number };
  lightning: {
    everySec: [number, number];
    flash: { durationSec: number; double: boolean; hemiBoost: number };
    thunder: { sfx: string; delaySec: [number, number] };
  };
  audio: { loop: string; volumeFromIntensity: boolean; underBridgeMute: number };
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
  /** Rain, puddles, flood and lightning: Map 4 only. */
  weather: WeatherDef | null;
  /** Stretches where weapons are locked (empty on maps without any). */
  noFireZones: NoFireZone[];
  /** Light-sequence start (replaces the 3-2-1 countdown); null = the classic countdown. */
  startLights: StartLightsDef | null;
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
  /** Map 5: a single-carriageway street circuit. */
  road?: { widthM: number; texture: string };
  roadLayout?: {
    carriagewayWidthM?: number;
    lanesPerDirection?: number;
    roadTexture?: string;
    mainCarriageway?: { widthM: number; lanes: number; texture: string };
    frontageRoad?: { widthM: number; lanes: number; texture: string };
    truckRoad?: { widthM: number; lanes: number; texture: string };
    portLanes?: { widthM: number; texture: string };
    yardLanes?: { widthM: number };
    /** Map 4: median, car lanes (outbound racing), separator, motorbike lanes (inbound racing), sidewalk. */
    crossSectionFromCentre?: { part: string; widthM: number; texture?: string }[];
  };
  sections?: { id: string; name: string; fromT: number; toT: number }[];
  laneOffsetsM?: number[];
  spline: { points: [number, number, number][] };
  startLine: { grid: [number, number][]; lights?: StartLightsDef };
  noFireZones?: NoFireZone[];
  checkpoints: { id: number; t: number }[];
  ramps?: TrackDef['ramps'];
  pickups: TrackDef['pickups'];
  dressing?: { lighting?: DayLighting };
  /** Map 4 keeps its lighting at the top level. */
  lighting?: DayLighting;
  weather?: WeatherDef;
}

/** Day maps keep `lighting` at the top level; Map 6 ships no sky texture, so it borrows the day gradient. */
function dayLighting(r: RawTrack): DayLighting | null {
  const l = r.dressing?.lighting ?? (r.timeOfDay === 'storm' || r.timeOfDay === 'day' ? (r.lighting ?? null) : null);
  return l ? { ...l, sky: l.sky ?? 'textures/day_sky_gradient.png' } : null;
}

export function loadTrack(json: unknown): TrackDef {
  const r = json as RawTrack;
  // Map 4: outbound runs on the 3 car lanes, inbound on the 2 motorbike lanes (the narrower, textured stretch).
  const cross = r.roadLayout?.crossSectionFromCentre;
  const carLanes = cross?.find((x) => /car lanes/i.test(x.part));
  const motoLanes = cross?.find((x) => /motorbike/i.test(x.part));
  const main =
    r.roadLayout?.mainCarriageway ??
    r.roadLayout?.truckRoad ??
    (carLanes
      ? {
          widthM: carLanes.widthM,
          lanes: Number(/x(\d)/.exec(carLanes.part)?.[1] ?? 3),
          texture: carLanes.texture ?? '',
        }
      : undefined);
  const width = main?.widthM ?? r.roadLayout?.carriagewayWidthM ?? r.road?.widthM ?? r.roadWidthM ?? 18;
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
  const returnSection = motoLanes ? section((x) => x.id === 'H') : undefined;
  if (motoLanes && returnSection) {
    // From the U-turn flyover to the final U-turn: the 7 m motorbike lanes.
    const flyover = section((x) => x.id === 'F');
    widthProfile.push({
      fromT: flyover?.toT ?? returnSection.fromT,
      toT: returnSection.toT,
      widthM: motoLanes.widthM,
      texture: motoLanes.texture ?? '',
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
    roadTexture: main?.texture ?? r.roadLayout?.roadTexture ?? r.road?.texture ?? 'textures/road_lanes.png',
    roadTextureRepeatM: r.roadLayout ? (main ? 16 : 12) : r.road ? r.road.widthM : raceJson.track.roadTextureRepeatM,
    hasElevation,
    groundY: minY < -1 ? Math.floor(minY) - 3 : 0,
    widthProfile,
    daylight: dayLighting(r),
    // Map 6's 'changeable' block is a visual / audio brief, not Map 4's storm: the shared sim must not see it.
    weather: r.weather && (r.weather as { type?: string }).type !== 'changeable' ? r.weather : null,
    noFireZones: r.noFireZones ?? [],
    startLights: r.startLine.lights ?? null,
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
/** Driver first-person view: camera feel, cockpit mirror and dash numbers (data/fpv.json). */
export const FPV = fpvJson;
export const AUDIO = audioJson;
export const CAT_LAI = loadTrack(catLaiJson);
export const CONG_HOA = loadTrack(congHoaJson);
/** Every map, in menu order. */
export const XA_LO = loadTrack(xaLoJson);
export const PHAM_VAN_DONG = loadTrack(phamVanDongJson);
export const MONTE_CARLO = loadTrack(monteCarloJson);
export const ARDENNES = loadTrack(ardennesJson);
export const TRACKS: readonly TrackDef[] = [CAT_LAI, CONG_HOA, XA_LO, PHAM_VAN_DONG, MONTE_CARLO, ARDENNES];

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
