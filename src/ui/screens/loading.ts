import { keyBar, kc } from '../hotkeys';
import { enableMenuNav } from '../nav';
import type { Screen } from '../types';
import './menus.css';

const TIPS = [
  'Every button shows its hotkey. You never need the mouse.',
  'Drift through the container chicane to fill nitro before the bridge jump.',
  'Guns are disabled while airborne — land first, then shoot.',
  'Every MG hit charges a little nitro. Takedowns give a full bar.',
  'Rockets home gently: line up the shot, then fire.',
  'Grab repair pickups before you hit 30% hull.',
  'Press R to reset to the last checkpoint if you get stuck.',
];

/** Boot screen: progress bar, then a "press any key" prompt that also unlocks audio. */
export class LoadingScreen implements Screen {
  readonly el = document.createElement('section');
  private readonly fill: HTMLElement;
  private readonly label: HTMLElement;
  private readonly pct: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly prompt: HTMLButtonElement;
  private readonly disposeNav: () => void;
  private cleanup: (() => void) | null = null;
  private raf = 0;

  constructor(root: HTMLElement) {
    this.el.className = 'mn mn-loading';
    this.el.setAttribute('aria-label', 'Loading');
    this.el.innerHTML = `
      <svg class="roads" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <path d="M540 720 L630 420 L650 420 L740 720 Z" fill="#161B23"/>
        <path d="M636 420 L644 420 L652 720 L628 720 Z" fill="#FF6A1A" opacity="0.35"/>
        <path d="M0 720 L620 420 L622 420 L40 720 Z" fill="#2EC5FF" opacity="0.25"/>
        <path d="M1280 720 L660 420 L658 420 L1240 720 Z" fill="#2EC5FF" opacity="0.25"/>
      </svg>
      <div class="logo">
        <div class="mn-eyebrow">ARCADE COMBAT RACING</div>
        <h1>VOLTLINE</h1>
      </div>
      <div class="bar">
        <div class="track" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="fill"></div></div>
        <div class="meta mn-mono"><span class="label">Loading…</span><span class="pct">0%</span></div>
      </div>
      <button type="button" class="anykey" hidden data-autofocus data-hotkey="enter space">${kc('Enter')}<span>PRESS ENTER TO START</span></button>
      <div class="tip"><span class="tiptext"></span><span class="mn-mono">v0.1 MVP</span></div>
      ${keyBar(
        [
          { keys: ['Enter'], label: 'Start' },
          { keys: ['Space'], label: 'Start' },
        ],
        'Gamepad · press A or Start',
      )}`;
    root.appendChild(this.el);
    const q = <T extends HTMLElement>(s: string): T => this.el.querySelector(s) as T;
    this.fill = q('.fill');
    this.label = q('.label');
    this.pct = q('.pct');
    this.bar = q('.bar');
    this.prompt = q('.anykey');
    q('.tiptext').textContent = `TIP · ${TIPS[Math.floor(Math.random() * TIPS.length)]}`;
    this.disposeNav = enableMenuNav(this.el);
  }

  setProgress(fraction: number, label?: string): void {
    const p = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    this.fill.style.width = `${p}%`;
    this.pct.textContent = `${p}%`;
    this.bar.querySelector('.track')?.setAttribute('aria-valuenow', String(p));
    if (label !== undefined) this.label.textContent = label;
  }

  /** Swap the bar for a prompt; `onAnyKey` fires once on the first key, pointer press or gamepad button. */
  ready(onAnyKey: () => void): void {
    this.cleanup?.();
    this.setProgress(1, 'Ready');
    this.prompt.hidden = false;
    if (document.body.classList.contains('is-touch')) {
      const label = this.prompt.querySelector('span');
      if (label) label.textContent = 'TAP TO START';
      this.prompt.querySelector('.kc')?.remove();
    }
    let done = false;
    const fire = (): void => {
      if (done) return;
      done = true;
      this.cleanup?.();
      onAnyKey();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (
        e.repeat ||
        ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'AltLeft'].includes(e.code)
      )
        return;
      fire();
    };
    const poll = (): void => {
      this.raf = requestAnimationFrame(poll);
      const pad = navigator.getGamepads?.().find((p) => p && p.connected);
      if (pad?.buttons.some((b) => b.pressed)) fire();
    };
    // Capture phase: the menu input system stops propagation of the keys it handles (Enter / Space).
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', fire);
    this.prompt.addEventListener('click', fire);
    this.raf = requestAnimationFrame(poll);
    this.cleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', fire);
      this.prompt.removeEventListener('click', fire);
      cancelAnimationFrame(this.raf);
      this.cleanup = null;
    };
  }

  /** The loading screen is visible as soon as it is built. */
  show(): void {
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }

  dispose(): void {
    this.cleanup?.();
    this.disposeNav();
    this.el.remove();
  }
}
