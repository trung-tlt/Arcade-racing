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

/** Boot screen: logo, progress bar and a tip. The title screen follows by itself once everything is loaded. */
export class LoadingScreen implements Screen {
  readonly el = document.createElement('section');
  private readonly fill: HTMLElement;
  private readonly label: HTMLElement;
  private readonly pct: HTMLElement;
  private readonly bar: HTMLElement;

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
        <h1 class="wordmark"><img src="/branding/voltline_logo_horizontal_on_dark.svg" alt="VOLTLINE" width="596" height="120" draggable="false" /></h1>
        <img class="endorse" src="/assets/brand/endorsement_craftmann_app_on_dark.svg" alt="a CraftMann app" width="130" height="24" draggable="false" />
      </div>
      <div class="bar">
        <div class="track" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="fill"></div></div>
        <div class="meta mn-mono"><span class="label">Loading…</span><span class="pct">0%</span></div>
      </div>
      <div class="tip"><span class="tiptext"></span><span class="mn-mono">v0.1 MVP</span></div>`;
    root.appendChild(this.el);
    const q = <T extends HTMLElement>(s: string): T => this.el.querySelector(s) as T;
    this.fill = q('.fill');
    this.label = q('.label');
    this.pct = q('.pct');
    this.bar = q('.bar');
    q('.tiptext').textContent = `TIP · ${TIPS[Math.floor(Math.random() * TIPS.length)]}`;
  }

  setProgress(fraction: number, label?: string): void {
    const p = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    this.fill.style.width = `${p}%`;
    this.pct.textContent = `${p}%`;
    this.bar.querySelector('.track')?.setAttribute('aria-valuenow', String(p));
    if (label !== undefined) this.label.textContent = label;
  }

  /** The loading screen is visible as soon as it is built. */
  show(): void {
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }

  dispose(): void {
    this.el.remove();
  }
}
