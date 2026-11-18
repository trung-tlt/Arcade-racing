import type { CarControls } from '../vehicle/CarPhysics';
import { touchInput, type TouchInput } from './TouchInput';

type Edge = 'reset' | 'pause' | 'restart';

/** The one action map: every binding lives here. */
const KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  drift: ['Space'],
  nitro: ['ShiftLeft', 'ShiftRight'],
  fire: ['KeyJ'],
  fireSecondary: ['KeyK'],
  reset: ['KeyR'],
  pause: ['Escape', 'KeyP'],
  restart: ['Enter'],
} as const;
const MOUSE = { fire: 0, fireSecondary: 2 } as const;
const PAD = {
  throttle: 7,
  brake: 6,
  drift: 2,
  nitro: 0,
  fire: 5,
  fireSecondary: 4,
  reset: 3,
  pause: 9,
  restart: 8,
} as const;
const STICK_DEADZONE = 0.15;
const TRIGGER_DEADZONE = 0.05;
const PREVENT = new Set<string>(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class Input {
  private readonly down = new Set<string>();
  private readonly mouse = new Set<number>();
  private readonly pressed = new Set<Edge>();
  private readonly padPrev: Record<Edge, boolean> = { reset: false, pause: false, restart: false };
  private readonly controls: CarControls = {
    throttle: 0,
    brake: 0,
    steer: 0,
    drift: false,
    nitro: false,
    fire: false,
    fireSecondary: false,
  };

  constructor(
    private readonly target: Window,
    private readonly touch: TouchInput = touchInput,
  ) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('mousedown', this.onMouseDown);
    target.addEventListener('mouseup', this.onMouseUp);
    target.addEventListener('contextmenu', this.onContext);
    target.addEventListener('blur', this.clear);
  }

  private anyKey(codes: readonly string[]): boolean {
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  read(): CarControls {
    const c = this.controls;
    const pad = this.pad();
    const trig = (i: number): number => {
      const v = pad?.buttons[i]?.value ?? 0;
      return v > TRIGGER_DEADZONE ? v : 0;
    };
    const btn = (i: number): boolean => pad?.buttons[i]?.pressed ?? false;

    c.throttle = Math.max(this.anyKey(KEYS.throttle) ? 1 : 0, trig(PAD.throttle));
    c.brake = Math.max(this.anyKey(KEYS.brake) ? 1 : 0, trig(PAD.brake));
    let steer = (this.anyKey(KEYS.right) ? 1 : 0) - (this.anyKey(KEYS.left) ? 1 : 0);
    const axis = pad?.axes[0] ?? 0;
    if (Math.abs(axis) > STICK_DEADZONE) steer = axis;
    c.steer = Math.max(-1, Math.min(1, steer));
    c.drift = this.anyKey(KEYS.drift) || btn(PAD.drift);
    c.nitro = this.anyKey(KEYS.nitro) || btn(PAD.nitro);
    c.fire = this.anyKey(KEYS.fire) || this.mouse.has(MOUSE.fire) || btn(PAD.fire);
    c.fireSecondary = this.anyKey(KEYS.fireSecondary) || this.mouse.has(MOUSE.fireSecondary) || btn(PAD.fireSecondary);

    // Touch writes the same actions: it adds to whatever keyboard / gamepad / mouse already set.
    if (this.touch.enabled) {
      const t = this.touch.read();
      c.throttle = Math.max(c.throttle, t.throttle);
      c.brake = Math.max(c.brake, t.brake);
      if (t.steer !== 0) c.steer = t.steer;
      c.drift ||= t.drift;
      c.nitro ||= t.nitro;
      c.fire ||= t.fire;
      c.fireSecondary ||= t.fireSecondary;
    }

    // Gamepad edges are detected here since there are no events for them.
    this.padEdge('reset', btn(PAD.reset));
    this.padEdge('pause', btn(PAD.pause));
    this.padEdge('restart', btn(PAD.restart));
    return c;
  }

  wasPressed(a: Edge): boolean {
    return this.pressed.has(a) || (a !== 'restart' && this.touch.hasEdge(a));
  }

  endFrame(): void {
    this.pressed.clear();
    this.touch.endFrame();
  }

  dispose(): void {
    const t = this.target;
    t.removeEventListener('keydown', this.onKeyDown);
    t.removeEventListener('keyup', this.onKeyUp);
    t.removeEventListener('mousedown', this.onMouseDown);
    t.removeEventListener('mouseup', this.onMouseUp);
    t.removeEventListener('contextmenu', this.onContext);
    t.removeEventListener('blur', this.clear);
  }

  private pad(): Gamepad | null {
    if (!navigator.getGamepads) return null;
    for (const p of navigator.getGamepads()) if (p && p.connected) return p;
    return null;
  }

  private padEdge(a: Edge, now: boolean): void {
    if (now && !this.padPrev[a]) this.pressed.add(a);
    this.padPrev[a] = now;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (PREVENT.has(e.code)) e.preventDefault();
    if (!e.repeat) {
      if ((KEYS.reset as readonly string[]).includes(e.code)) this.pressed.add('reset');
      if ((KEYS.pause as readonly string[]).includes(e.code)) this.pressed.add('pause');
      if ((KEYS.restart as readonly string[]).includes(e.code)) this.pressed.add('restart');
    }
    this.down.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };
  private onMouseDown = (e: MouseEvent): void => {
    this.mouse.add(e.button);
  };
  private onMouseUp = (e: MouseEvent): void => {
    this.mouse.delete(e.button);
  };
  private onContext = (e: Event): void => e.preventDefault();
  private clear = (): void => {
    this.down.clear();
    this.mouse.clear();
  };
}
