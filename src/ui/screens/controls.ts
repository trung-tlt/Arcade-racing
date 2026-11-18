import { onSettingsChange, updateSettings, userSettings, type UserSettings } from '../../core/Settings';
import { keyBar, kc, labelWithKeys } from '../hotkeys';
import { enableMenuNav, focusFirst } from '../nav';
import type { Screen } from '../types';
import { requestTiltPermission } from '../touch/touchHud';
import './menus.css';

export interface ControlsDeps {
  onBack(): void;
}

/** Real bindings (mirror of the action map in core/Input.ts). `keys` groups are alternatives. */
const ROWS: { action: string; keys: string[][]; pad: string }[] = [
  {
    action: 'Throttle / Brake',
    keys: [
      ['W', 'S'],
      ['↑', '↓'],
    ],
    pad: 'RT / LT',
  },
  {
    action: 'Steer',
    keys: [
      ['A', 'D'],
      ['←', '→'],
    ],
    pad: 'Left stick',
  },
  { action: 'Drift', keys: [['Space']], pad: 'X' },
  { action: 'Nitro', keys: [['Shift']], pad: 'A' },
  { action: 'Fire Pulse MG', keys: [['J'], ['Left mouse']], pad: 'RB' },
  { action: 'Fire rocket', keys: [['K'], ['Right mouse']], pad: 'LB' },
  { action: 'Reset to track', keys: [['R']], pad: 'Y' },
  { action: 'Pause', keys: [['Esc', 'P']], pad: 'Start' },
  { action: 'Restart race', keys: [['Enter']], pad: 'Back' },
];

const MENU_ROWS: { action: string; keys: string[] }[] = [
  { action: 'Move', keys: ['↑', '↓', '←', '→'] },
  { action: 'Select', keys: ['Enter', 'Space'] },
  { action: 'Back', keys: ['Esc', 'Backspace'] },
  { action: 'Button hotkey', keys: ['letter on chip'] },
  { action: 'Pick vehicle', keys: ['1', '…', '9'] },
];

/** Touch-controls panel (design artboard 32): three steering styles plus auto-gas, vibration and the mirrored layout. */
const TOUCH_STYLES: { id: UserSettings['touchScheme']; name: string; note: string; icon: string }[] = [
  { id: 'buttons', name: 'Buttons', note: 'Steer with the ◀ ▶ pads', icon: '◀ ▶' },
  { id: 'tilt', name: 'Tilt', note: 'Tilt the phone like a wheel', icon: '⟲' },
  { id: 'wheel', name: 'Swipe wheel', note: 'Slide one thumb left or right', icon: '⇆' },
];
const TOUCH_TOGGLES: { key: 'touchAutoGas' | 'touchVibration' | 'touchLeftHanded'; name: string; note: string }[] = [
  { key: 'touchAutoGas', name: 'Auto-gas', note: 'Throttle is always on; BRAKE slows you' },
  { key: 'touchVibration', name: 'Vibration', note: 'Buzz on hits, wrecks and nitro' },
  { key: 'touchLeftHanded', name: 'Left-handed layout', note: 'Mirror: steering right, buttons left' },
];

function touchPanel(): string {
  const styles = TOUCH_STYLES.map(
    (t) =>
      `<button type="button" class="tc-style" data-scheme="${t.id}" data-sfx="toggle_on" aria-pressed="false"><span class="ico">${t.icon}</span><b>${t.name}</b><small>${t.note}</small></button>`,
  ).join('');
  const toggles = TOUCH_TOGGLES.map(
    (t) =>
      `<button type="button" class="tc-toggle" data-key="${t.key}" role="switch" aria-checked="false"><span><b>${t.name}</b><small>${t.note}</small></span><i class="sw"></i></button>`,
  ).join('');
  return `<div class="ctl-touch"><div class="tc-styles" role="group" aria-label="Control style">${styles}</div><div class="tc-toggles">${toggles}</div></div>`;
}

export class ControlsScreen implements Screen {
  readonly el = document.createElement('section');
  private readonly disposeNav: () => void;
  private offSettings: (() => void) | null = null;

  constructor(root: HTMLElement, deps: ControlsDeps) {
    this.el.className = 'mn mn-controls';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Controls');
    const keyGroup = (g: string[][]): string =>
      g.map((alt) => alt.map((k) => kc(k)).join('')).join('<span class="or">or</span>');
    const rows = ROWS.map(
      (r) =>
        `<tr><td>${r.action}</td><td><span class="keys">${keyGroup(r.keys)}</span></td><td><span class="pad">${r.pad}</span></td></tr>`,
    ).join('');
    const menuRows = MENU_ROWS.map(
      (r) => `<tr><td>${r.action}</td><td><span class="keys">${r.keys.map((k) => kc(k)).join('')}</span></td></tr>`,
    ).join('');
    this.el.innerHTML = `
      <div class="mn-page">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px">
          <div><div class="mn-eyebrow">CONTROLS</div><h2>Controls</h2></div>
          <div class="hint">Plug in a gamepad any time — it works as soon as you press a button.</div>
        </div>
        ${document.body.classList.contains('is-touch') ? touchPanel() : ''}
        <div class="ctl-grid">
          <div class="table">
            <table>
              <thead><tr><th scope="col">IN RACE</th><th scope="col">KEYBOARD &amp; MOUSE</th><th scope="col">GAMEPAD</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <div class="ctl-side">
            <div class="table">
              <table>
                <thead><tr><th scope="col">MENUS</th><th scope="col">KEYS</th></tr></thead>
                <tbody>${menuRows}</tbody>
              </table>
            </div>
            <div class="hint">Every button in every menu shows its own hotkey chip. Rebinding keys is post-MVP. Guns don't fire while airborne.</div>
            <button type="button" class="mn-btn primary ctl-back" data-back data-autofocus data-hotkey="esc">${labelWithKeys('BACK', ['Esc'], true)}</button>
          </div>
        </div>
        ${keyBar(
          [
            { keys: ['Esc'], label: 'Back' },
            { keys: ['Backspace'], label: 'Back' },
          ],
          'Gamepad · D-pad navigate · A select · B back',
        )}
      </div>`;
    root.appendChild(this.el);
    this.el.querySelector('[data-back]')?.addEventListener('click', deps.onBack);
    this.disposeNav = enableMenuNav(this.el);
    if (this.el.querySelector('.ctl-touch')) this.bindTouchPanel();
  }

  private bindTouchPanel(): void {
    const render = (): void => {
      for (const b of this.el.querySelectorAll<HTMLElement>('.tc-style')) {
        b.setAttribute('aria-pressed', String(b.dataset.scheme === userSettings.touchScheme));
      }
      for (const b of this.el.querySelectorAll<HTMLElement>('.tc-toggle')) {
        const key = b.dataset.key as 'touchAutoGas' | 'touchVibration' | 'touchLeftHanded';
        b.setAttribute('aria-checked', String(userSettings[key]));
      }
    };
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const style = t.closest<HTMLElement>('.tc-style');
      if (style) {
        const scheme = style.dataset.scheme as UserSettings['touchScheme'];
        updateSettings({ touchScheme: scheme });
        // iOS only shows the motion-sensor prompt from inside a tap, so ask right here.
        if (scheme === 'tilt') void requestTiltPermission();
        return;
      }
      const tog = t.closest<HTMLElement>('.tc-toggle');
      if (tog) {
        const key = tog.dataset.key as 'touchAutoGas' | 'touchVibration' | 'touchLeftHanded';
        updateSettings({ [key]: !userSettings[key] });
        if (key === 'touchVibration' && userSettings.touchVibration) navigator.vibrate?.(30);
      }
    });
    this.offSettings = onSettingsChange(render);
    render();
  }

  show(): void {
    this.el.hidden = false;
    focusFirst(this.el);
  }

  hide(): void {
    this.el.hidden = true;
  }

  dispose(): void {
    this.disposeNav();
    this.offSettings?.();
    this.el.remove();
  }
}
