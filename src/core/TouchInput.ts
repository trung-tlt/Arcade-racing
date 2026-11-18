import touchJson from '../../data/touch.json';

/** Tuning for the touch layer: every number lives in data/touch.json. */
export type TouchConfig = typeof touchJson;
export type TouchScheme = 'buttons' | 'tilt' | 'wheel';
export type TouchButton = 'left' | 'right' | 'drift' | 'fire' | 'rocket' | 'nitro' | 'brake' | 'gas';
export type TouchEdge = 'pause' | 'reset';

/** What the player chose in the touch-controls screen (persisted through Settings). */
export interface TouchPrefs {
  scheme: TouchScheme;
  autoGas: boolean;
  vibration: boolean;
  leftHanded: boolean;
}

/** The actions touch produces: the same shape the keyboard and gamepad feed into Input. */
export interface TouchActions {
  throttle: number;
  brake: number;
  steer: number;
  drift: boolean;
  nitro: boolean;
  fire: boolean;
  fireSecondary: boolean;
}

export const TOUCH: TouchConfig = touchJson;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Schema check for data/touch.json (same style as the other data validators). */
export function validateTouchConfig(json: unknown): string[] {
  const errors: string[] = [];
  const t = json as Partial<Record<keyof TouchConfig, Record<string, unknown>>> | null;
  if (!t || typeof t !== 'object') return ['touch config must be an object'];
  const need = (group: keyof TouchConfig, keys: string[]): void => {
    const g = t[group];
    if (!g || typeof g !== 'object') {
      errors.push(`touch.${group} missing`);
      return;
    }
    for (const k of keys) if (!isNum(g[k])) errors.push(`touch.${group}.${k} must be a number`);
  };
  need('layout', [
    'marginXPx',
    'marginYPx',
    'padPx',
    'firePx',
    'rocketPx',
    'nitroPx',
    'brakePx',
    'driftPx',
    'gasPx',
    'pausePx',
    'gapPx',
    'minTargetPx',
  ]);
  need('steer', ['wheelRadiusPx', 'wheelDeadzone']);
  need('tilt', ['deadzoneDeg', 'maxDeg', 'smoothing']);
  need('vibration', ['hitMs', 'nitroMs', 'wreckMs']);
  need('swipe', ['minPx']);
  need('performance', ['dprCap', 'minFps']);
  const l = t.layout;
  if (l) {
    // The design's rule: nothing a thumb has to hit is smaller than 48 px, and no margin under the 44 px notch inset.
    for (const k of ['padPx', 'firePx', 'rocketPx', 'nitroPx', 'brakePx', 'driftPx', 'gasPx', 'pausePx']) {
      if (isNum(l[k]) && isNum(l.minTargetPx) && l[k] < l.minTargetPx)
        errors.push(`touch.layout.${k} below minTargetPx`);
    }
    if (isNum(l.marginXPx) && l.marginXPx < 44) errors.push('touch.layout.marginXPx must be at least 44');
  }
  const tilt = t.tilt;
  if (tilt && isNum(tilt.deadzoneDeg) && isNum(tilt.maxDeg) && tilt.deadzoneDeg >= tilt.maxDeg) {
    errors.push('touch.tilt.deadzoneDeg must be below maxDeg');
  }
  const d = t.defaults;
  if (!d || !['buttons', 'tilt', 'wheel'].includes(String(d.scheme))) errors.push('touch.defaults.scheme invalid');
  return errors;
}

/** Steering from a device roll angle: deadzone, linear to `maxDeg`, optional invert. */
export function steerFromTilt(rollDeg: number, cfg: TouchConfig['tilt'] = TOUCH.tilt): number {
  const a = Math.abs(rollDeg);
  if (a <= cfg.deadzoneDeg) return 0;
  const v = Math.min(1, (a - cfg.deadzoneDeg) / (cfg.maxDeg - cfg.deadzoneDeg));
  return Math.sign(rollDeg) * v * (cfg.invert ? -1 : 1);
}

/**
 * Roll about the screen's normal from DeviceOrientation angles, for the current screen rotation
 * (`screen.orientation.angle`): landscape swaps the roles of beta and gamma.
 */
export function rollFromOrientation(beta: number, gamma: number, screenAngle: number): number {
  const a = ((Math.round(screenAngle / 90) % 4) + 4) % 4;
  if (a === 1) return beta;
  if (a === 3) return -beta;
  if (a === 2) return -gamma;
  return gamma;
}

/** Steering from how far a thumb dragged from where the swipe wheel started. */
export function steerFromWheel(dxPx: number, cfg: TouchConfig['steer'] = TOUCH.steer): number {
  const v = clamp(dxPx / cfg.wheelRadiusPx, -1, 1);
  return Math.abs(v) < cfg.wheelDeadzone ? 0 : v;
}

/** Which side of the screen each cluster sits on: the steering cluster follows the "steering hand". */
export function clusterSides(leftHanded: boolean): { steer: 'left' | 'right'; actions: 'left' | 'right' } {
  return leftHanded ? { steer: 'right', actions: 'left' } : { steer: 'left', actions: 'right' };
}

/** Pointer-id → button bookkeeping plus the steering sources; pure state, no DOM. */
export class TouchInput {
  /** True on touch devices (or `?touch=1`): only then does Input merge these actions in. */
  enabled = false;
  prefs: TouchPrefs = { ...TOUCH.defaults, scheme: TOUCH.defaults.scheme as TouchScheme };
  private readonly held = new Map<number, TouchButton>();
  private wheelId: number | null = null;
  private wheelStartX = 0;
  private wheelValue = 0;
  private tiltTarget = 0;
  private tiltSmooth = 0;
  private readonly edges = new Set<TouchEdge>();
  private readonly out: TouchActions = {
    throttle: 0,
    brake: 0,
    steer: 0,
    drift: false,
    nitro: false,
    fire: false,
    fireSecondary: false,
  };

  constructor(private readonly cfg: TouchConfig = TOUCH) {}

  press(pointerId: number, button: TouchButton): void {
    this.held.set(pointerId, button);
  }

  release(pointerId: number): void {
    this.held.delete(pointerId);
    if (this.wheelId === pointerId) this.endWheel(pointerId);
  }

  isDown(button: TouchButton): boolean {
    for (const b of this.held.values()) if (b === button) return true;
    return false;
  }

  startWheel(pointerId: number, x: number): void {
    if (this.wheelId !== null) return;
    this.wheelId = pointerId;
    this.wheelStartX = x;
    this.wheelValue = 0;
  }

  moveWheel(pointerId: number, x: number): void {
    if (this.wheelId !== pointerId) return;
    this.wheelValue = steerFromWheel(x - this.wheelStartX, this.cfg.steer);
  }

  endWheel(pointerId: number): void {
    if (this.wheelId !== pointerId) return;
    this.wheelId = null;
    this.wheelValue = 0;
  }

  /** Feed the device roll angle in degrees (already screen-rotation corrected). */
  setTilt(rollDeg: number): void {
    this.tiltTarget = steerFromTilt(rollDeg, this.cfg.tilt);
  }

  /** One-shot actions (pause, reset) the game reads like keyboard edges. */
  edge(e: TouchEdge): void {
    this.edges.add(e);
  }

  hasEdge(e: TouchEdge): boolean {
    return this.edges.has(e);
  }

  endFrame(): void {
    this.edges.clear();
  }

  releaseAll(): void {
    this.held.clear();
    this.wheelId = null;
    this.wheelValue = 0;
    this.tiltSmooth = 0;
    this.tiltTarget = 0;
  }

  read(): TouchActions {
    const o = this.out;
    const p = this.prefs;
    const brake = this.isDown('brake');
    o.brake = brake ? 1 : 0;
    // Auto-gas: the throttle is on unless the brake is held; with it off, the GAS button drives it.
    o.throttle = brake ? 0 : p.autoGas || this.isDown('gas') ? 1 : 0;
    let steer = 0;
    if (p.scheme === 'buttons') steer = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    else if (p.scheme === 'wheel') steer = this.wheelValue;
    else {
      this.tiltSmooth += (this.tiltTarget - this.tiltSmooth) * this.cfg.tilt.smoothing;
      steer = this.tiltSmooth;
    }
    o.steer = clamp(steer, -1, 1);
    o.drift = this.isDown('drift');
    o.nitro = this.isDown('nitro');
    o.fire = this.isDown('fire');
    o.fireSecondary = this.isDown('rocket');
    return o;
  }
}

/** The one touch state the game reads (like `settings`, a module-level singleton). */
export const touchInput = new TouchInput();

/** Phone / tablet detection: coarse pointer + touch points, with `?touch=1` / `?touch=0` overrides for desktop testing. */
export function detectTouch(
  search: string = typeof location !== 'undefined' ? location.search : '',
  win: Pick<Window, 'matchMedia'> | undefined = typeof window !== 'undefined' ? window : undefined,
  nav: Pick<Navigator, 'maxTouchPoints'> | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
): boolean {
  const q = new URLSearchParams(search).get('touch');
  if (q === '1') return true;
  if (q === '0') return false;
  return !!win?.matchMedia?.('(pointer: coarse)').matches && (nav?.maxTouchPoints ?? 0) > 0;
}
