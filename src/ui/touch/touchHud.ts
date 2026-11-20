import { onSettingsChange, userSettings } from '../../core/Settings';
import { TOUCH, rollFromOrientation, type TouchButton, type TouchInput } from '../../core/TouchInput';
import type { EventBus } from '../../core/Events';

/** Tilt-to-steer on iOS needs a permission prompt, and only a user gesture may trigger it. */
type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

export async function requestTiltPermission(): Promise<boolean> {
  const ctor = (
    typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : null
  ) as OrientationCtor | null;
  if (!ctor) return false;
  if (typeof ctor.requestPermission !== 'function') return true; // Android / desktop: no prompt
  try {
    return (await ctor.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

export function vibrate(ms: number | number[]): void {
  if (!userSettings.touchVibration) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* vibration is optional */
  }
}

/** Keep receiving this finger's events after it slides off the button (a synthetic pointer id may not be capturable). */
function capture(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* not an active pointer */
  }
}

interface ButtonDef {
  id: TouchButton;
  label: string;
  cls: string;
}

const STEER_BUTTONS: ButtonDef[] = [
  { id: 'left', label: '◀', cls: 'tb-left' },
  { id: 'right', label: '▶', cls: 'tb-right' },
];
const ACTION_BUTTONS: ButtonDef[] = [
  { id: 'fire', label: 'FIRE', cls: 'tb-fire' },
  { id: 'rocket', label: 'ROCKET', cls: 'tb-rocket' },
  { id: 'nitro', label: 'NITRO', cls: 'tb-nitro' },
  { id: 'brake', label: 'BRAKE', cls: 'tb-brake' },
  { id: 'gas', label: 'GAS', cls: 'tb-gas' },
  { id: 'drift', label: 'DRIFT', cls: 'tb-drift' },
];

/**
 * The in-race touch overlay (design artboard 29): steering under one thumb, FIRE / ROCKET / NITRO / BRAKE under the other,
 * PAUSE top-centre. Every control is a pointer-captured element feeding the shared TouchInput, so two thumbs work at once.
 */
export class TouchHud {
  readonly el = document.createElement('div');
  private active = false;
  private rocketTimer = 0;
  private readonly rocketLabel: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly tiltPrompt: HTMLElement;
  private unbindEvents: (() => void) | null = null;
  private readonly offSettings: () => void;

  constructor(
    root: HTMLElement,
    private readonly input: TouchInput,
  ) {
    const L = TOUCH.layout;
    this.el.id = 'touch-hud';
    this.el.hidden = true;
    this.el.style.setProperty('--tb-margin-x', `${L.marginXPx}px`);
    this.el.style.setProperty('--tb-margin-y', `${L.marginYPx}px`);
    this.el.style.setProperty('--tb-gap', `${L.gapPx}px`);
    this.el.style.setProperty('--tb-pad', `${L.padPx}px`);
    this.el.style.setProperty('--tb-fire', `${L.firePx}px`);
    this.el.style.setProperty('--tb-rocket', `${L.rocketPx}px`);
    this.el.style.setProperty('--tb-nitro', `${L.nitroPx}px`);
    this.el.style.setProperty('--tb-brake', `${L.brakePx}px`);
    this.el.style.setProperty('--tb-drift', `${L.driftPx}px`);
    this.el.style.setProperty('--tb-gas', `${L.gasPx}px`);
    this.el.style.setProperty('--tb-pause', `${L.pausePx}px`);
    this.el.style.setProperty('--tb-wheel', `${TOUCH.steer.wheelRadiusPx}px`);

    const btn = (d: ButtonDef): string =>
      `<div class="tb ${d.cls}" data-btn="${d.id}" role="button" aria-label="${d.label}"><span>${d.label}</span></div>`;
    this.el.innerHTML = `
      <div class="tc tc-steer">
        ${STEER_BUTTONS.map(btn).join('')}
        <div class="tb-wheel" data-wheel aria-label="Swipe to steer"><i class="knob"></i><span>SWIPE</span></div>
        <div class="tb-tilt" data-tilt role="button"><span>TILT TO STEER</span><small>tap to enable</small></div>
        ${btn(ACTION_BUTTONS[5])}
      </div>
      <div class="tc tc-actions">
        ${ACTION_BUTTONS.slice(0, 5).map(btn).join('')}
      </div>
      <div class="tb tb-pause" data-pause role="button" aria-label="Pause"><span>II</span></div>
      <div class="tb tb-reset" data-reset role="button" aria-label="Reset to track"><span>↺</span></div>`;
    root.appendChild(this.el);
    this.rocketLabel = this.el.querySelector('.tb-rocket span') as HTMLElement;
    this.knob = this.el.querySelector('.knob') as HTMLElement;
    this.tiltPrompt = this.el.querySelector('[data-tilt]') as HTMLElement;

    for (const b of this.el.querySelectorAll<HTMLElement>('[data-btn]'))
      this.bindButton(b, b.dataset.btn as TouchButton);
    this.bindWheel(this.el.querySelector('[data-wheel]') as HTMLElement);
    this.bindEdge(this.el.querySelector('[data-pause]') as HTMLElement, 'pause');
    this.bindEdge(this.el.querySelector('[data-reset]') as HTMLElement, 'reset');
    this.tiltPrompt.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      void requestTiltPermission().then((ok) => {
        this.tiltPrompt.classList.toggle('granted', ok);
        if (ok) window.addEventListener('deviceorientation', this.onTilt);
      });
    });
    // No context menu / selection / callout on long-press anywhere in the overlay.
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('visibilitychange', this.releaseAll);
    this.offSettings = onSettingsChange(() => this.applyPrefs());
    this.applyPrefs();
  }

  /** Show the overlay only while a race is running on a touch device. */
  setActive(on: boolean): void {
    this.active = on;
    this.el.hidden = !on;
    if (!on) this.releaseAll();
    window.clearInterval(this.rocketTimer);
    if (on) {
      this.applyPrefs();
      this.rocketTimer = window.setInterval(() => this.syncAmmo(), 200);
    }
  }

  /** Haptics for hits, wrecks and nitro for the player's car. */
  bindEvents(events: EventBus, playerId = 'player'): void {
    this.unbindEvents?.();
    const offs = [
      events.on('carHit', (e) => {
        if (e.carId === playerId) vibrate(TOUCH.vibration.hitMs);
      }),
      events.on('carWrecked', (e) => {
        if (e.carId === playerId) vibrate(TOUCH.vibration.wreckMs);
      }),
    ];
    this.unbindEvents = () => offs.forEach((o) => o());
  }

  private applyPrefs(): void {
    const p = userSettings;
    this.input.prefs = {
      scheme: p.touchScheme,
      autoGas: p.touchAutoGas,
      vibration: p.touchVibration,
      leftHanded: p.touchLeftHanded,
    };
    this.el.dataset.scheme = p.touchScheme;
    this.el.classList.toggle('lh', p.touchLeftHanded);
    this.el.classList.toggle('autogas', p.touchAutoGas);
    this.releaseAll();
    window.removeEventListener('deviceorientation', this.onTilt);
    if (p.touchScheme === 'tilt') {
      // Android / desktop need no prompt: listen straight away; iOS waits for the tap on the prompt.
      void requestTiltPermission().then((ok) => {
        const needsGesture = typeof (DeviceOrientationEvent as OrientationCtor).requestPermission === 'function';
        this.tiltPrompt.classList.toggle('granted', ok && !needsGesture);
        if (ok && !needsGesture) window.addEventListener('deviceorientation', this.onTilt);
      });
    }
  }

  private readonly onTilt = (e: DeviceOrientationEvent): void => {
    if (!this.active || e.beta === null || e.gamma === null) return;
    const angle = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 90;
    this.input.setTilt(rollFromOrientation(e.beta, e.gamma, angle));
  };

  private syncAmmo(): void {
    const n = document.querySelectorAll('.cb-rk.on').length;
    this.rocketLabel.innerHTML = `ROCKET<br><b>×${n}</b>`;
    this.el.querySelector('.tb-rocket')?.classList.toggle('empty', n === 0);
  }

  private readonly releaseAll = (): void => {
    this.input.releaseAll();
    for (const d of this.el.querySelectorAll('.down')) d.classList.remove('down');
    this.knob.style.transform = '';
  };

  private bindButton(el: HTMLElement, button: TouchButton): void {
    const up = (e: PointerEvent): void => {
      this.input.release(e.pointerId);
      el.classList.remove('down');
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(el, e.pointerId);
      this.input.press(e.pointerId, button);
      el.classList.add('down');
      if (button === 'nitro') vibrate(TOUCH.vibration.nitroMs);
    });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  private bindWheel(el: HTMLElement): void {
    const end = (e: PointerEvent): void => {
      this.input.release(e.pointerId);
      el.classList.remove('down');
      this.knob.style.transform = '';
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(el, e.pointerId);
      this.input.startWheel(e.pointerId, e.clientX);
      el.classList.add('down');
    });
    el.addEventListener('pointermove', (e) => {
      this.input.moveWheel(e.pointerId, e.clientX);
      const v = this.input.read().steer;
      this.knob.style.transform = `translateX(${v * TOUCH.steer.wheelRadiusPx}px)`;
    });
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  /** A one-shot button: pause, or put the car back on the track when it is stuck. */
  private bindEdge(el: HTMLElement, edge: 'pause' | 'reset'): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.classList.add('down');
      this.input.edge(edge);
    });
    const up = (): void => el.classList.remove('down');
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  dispose(): void {
    window.clearInterval(this.rocketTimer);
    window.removeEventListener('blur', this.releaseAll);
    document.removeEventListener('visibilitychange', this.releaseAll);
    window.removeEventListener('deviceorientation', this.onTilt);
    this.unbindEvents?.();
    this.offSettings();
    this.el.remove();
  }
}
