import { TOUCH, touchInput, type TouchScheme } from './TouchInput';

export type QualityName = 'low' | 'med' | 'high';

export interface QualityPreset {
  pixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  bloom: boolean;
  particleScale: number;
}

export const QUALITY_PRESETS: Record<QualityName, QualityPreset> = {
  low: { pixelRatio: 1, shadows: false, shadowMapSize: 1024, bloom: false, particleScale: 0.4 },
  med: { pixelRatio: 1.5, shadows: true, shadowMapSize: 1024, bloom: true, particleScale: 0.7 },
  high: { pixelRatio: 2, shadows: true, shadowMapSize: 2048, bloom: true, particleScale: 1 },
};

/** What the player chose in the settings screen (persisted). */
export interface UserSettings {
  preset: QualityName;
  /** 50..100, step 5. */
  resolutionScale: number;
  shadows: boolean;
  bloom: boolean;
  showFps: boolean;
  /** 0..100 each. */
  volumeMaster: number;
  volumeEffects: number;
  volumeEngine: number;
  /** Menu music, 0..100. */
  volumeMusic: number;
  aimAssist: boolean;
  cameraShake: boolean;
  fovKick: boolean;
  speedUnit: 'kmh' | 'mph';
  /** Touch controls (phones): steering style, auto-gas, haptics and the mirrored layout. */
  touchScheme: TouchScheme;
  touchAutoGas: boolean;
  touchVibration: boolean;
  touchLeftHanded: boolean;
  /** Phone defaults (Low preset) were applied once on the first run on a touch device. */
  mobileDefaultsApplied: boolean;
}

/** Derived values the game reads every frame. Volumes are 0..1. */
export interface RuntimeSettings {
  pixelRatio: number;
  shadows: boolean;
  bloom: boolean;
  shadowMapSize: number;
  particleScale: number;
  aimAssist: boolean;
  cameraShake: boolean;
  fovKick: boolean;
  showFps: boolean;
  speedUnit: 'kmh' | 'mph';
  volumeMaster: number;
  volumeEffects: number;
  volumeEngine: number;
  volumeMusic: number;
}

const STORAGE_KEY = 'voltline.settings';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaults(): UserSettings {
  const p = QUALITY_PRESETS.med;
  return {
    preset: 'med',
    resolutionScale: 100,
    shadows: p.shadows,
    bloom: p.bloom,
    showFps: false,
    volumeMaster: 80,
    volumeEffects: 90,
    volumeEngine: 70,
    volumeMusic: 80,
    aimAssist: true,
    cameraShake: true,
    fovKick: true,
    speedUnit: 'kmh',
    touchScheme: TOUCH.defaults.scheme as TouchScheme,
    touchAutoGas: TOUCH.defaults.autoGas,
    touchVibration: TOUCH.defaults.vibration,
    touchLeftHanded: TOUCH.defaults.leftHanded,
    mobileDefaultsApplied: false,
  };
}

export const userSettings: UserSettings = defaults();

const dpr = (): number => (typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1);

export const settings: RuntimeSettings = {
  pixelRatio: Math.min(dpr(), 2),
  shadows: true,
  bloom: true,
  shadowMapSize: QUALITY_PRESETS.med.shadowMapSize,
  particleScale: QUALITY_PRESETS.med.particleScale,
  aimAssist: true,
  cameraShake: true,
  fovKick: true,
  showFps: false,
  speedUnit: 'kmh',
  volumeMaster: 0.8,
  volumeEffects: 0.9,
  volumeEngine: 0.7,
  volumeMusic: 0.8,
};

const listeners = new Set<() => void>();
let store: StorageLike | null = null;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const isPreset = (v: unknown): v is QualityName => v === 'low' || v === 'med' || v === 'high';

/** Clamp / repair every field; unknown or wrong-typed values fall back to `base`. */
function sanitize(raw: Partial<Record<keyof UserSettings, unknown>>, base: UserSettings): UserSettings {
  const num = (v: unknown, fb: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fb;
  const bool = (v: unknown, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb);
  return {
    preset: isPreset(raw.preset) ? raw.preset : base.preset,
    resolutionScale: Math.round(num(raw.resolutionScale, base.resolutionScale, 50, 100) / 5) * 5,
    shadows: bool(raw.shadows, base.shadows),
    bloom: bool(raw.bloom, base.bloom),
    showFps: bool(raw.showFps, base.showFps),
    volumeMaster: Math.round(num(raw.volumeMaster, base.volumeMaster, 0, 100)),
    volumeEffects: Math.round(num(raw.volumeEffects, base.volumeEffects, 0, 100)),
    volumeEngine: Math.round(num(raw.volumeEngine, base.volumeEngine, 0, 100)),
    volumeMusic: Math.round(num(raw.volumeMusic, base.volumeMusic, 0, 100)),
    aimAssist: bool(raw.aimAssist, base.aimAssist),
    cameraShake: bool(raw.cameraShake, base.cameraShake),
    fovKick: bool(raw.fovKick, base.fovKick),
    speedUnit: raw.speedUnit === 'mph' || raw.speedUnit === 'kmh' ? raw.speedUnit : base.speedUnit,
    touchScheme:
      raw.touchScheme === 'buttons' || raw.touchScheme === 'tilt' || raw.touchScheme === 'wheel'
        ? raw.touchScheme
        : base.touchScheme,
    touchAutoGas: bool(raw.touchAutoGas, base.touchAutoGas),
    touchVibration: bool(raw.touchVibration, base.touchVibration),
    touchLeftHanded: bool(raw.touchLeftHanded, base.touchLeftHanded),
    mobileDefaultsApplied: bool(raw.mobileDefaultsApplied, base.mobileDefaultsApplied),
  };
}

function recompute(): void {
  const u = userSettings;
  const p = QUALITY_PRESETS[u.preset];
  // Phones cap the render scale: their screens are dense and the GPU is the bottleneck.
  const cap = touchInput.enabled ? TOUCH.performance.dprCap : Infinity;
  settings.pixelRatio = Math.min(dpr(), p.pixelRatio, cap) * (u.resolutionScale / 100);
  settings.shadows = u.shadows;
  settings.bloom = u.bloom;
  settings.shadowMapSize = p.shadowMapSize;
  settings.particleScale = p.particleScale;
  settings.aimAssist = u.aimAssist;
  settings.cameraShake = u.cameraShake;
  settings.fovKick = u.fovKick;
  settings.showFps = u.showFps;
  settings.speedUnit = u.speedUnit;
  settings.volumeMaster = u.volumeMaster / 100;
  settings.volumeEffects = u.volumeEffects / 100;
  settings.volumeEngine = u.volumeEngine / 100;
  settings.volumeMusic = u.volumeMusic / 100;
}

function persist(): void {
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(userSettings));
  } catch {
    /* storage may be blocked (private mode); settings still apply for this session */
  }
}

function notify(): void {
  listeners.forEach((cb) => cb());
}

/** Read saved settings. Pass a storage in tests; defaults to localStorage when available. */
export function loadSettings(storage?: StorageLike): void {
  try {
    store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  } catch {
    store = null;
  }
  let raw: unknown = null;
  try {
    const text = store?.getItem(STORAGE_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<Record<keyof UserSettings, unknown>>) : {};
  Object.assign(userSettings, sanitize(obj, defaults()));
  recompute();
  notify();
}

export function updateSettings(patch: Partial<UserSettings>): void {
  const next = { ...userSettings, ...patch };
  if (patch.preset !== undefined && isPreset(patch.preset)) {
    // Choosing a preset sets shadows + bloom, unless the same patch overrides them explicitly.
    const p = QUALITY_PRESETS[patch.preset];
    if (patch.shadows === undefined) next.shadows = p.shadows;
    if (patch.bloom === undefined) next.bloom = p.bloom;
  }
  Object.assign(userSettings, sanitize(next, userSettings));
  recompute();
  persist();
  notify();
}

export function resetSettings(): void {
  Object.assign(userSettings, defaults());
  recompute();
  persist();
  notify();
}

export function onSettingsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Legacy helper: apply a quality preset to the runtime flags (also updates the saved choice). */
export function applyPreset(name: QualityName): void {
  updateSettings({ preset: name });
}

recompute();

/**
 * First run on a phone: Low preset (no shadows or bloom, DPR capped at 1, ambient traffic off) so it holds 30 fps.
 * Applied once; after that the player's own choices stick.
 */
export function applyMobileDefaults(isTouch: boolean): void {
  if (!isTouch || userSettings.mobileDefaultsApplied) return;
  updateSettings({ preset: 'low', mobileDefaultsApplied: true });
}
