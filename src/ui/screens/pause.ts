import { keyBar, labelWithKeys } from '../hotkeys';
import { type PadButton, enableMenuNav, focusFirst } from '../nav';
import type { Screen } from '../types';
import './overlays.css';

export interface PauseDeps {
  onResume(): void;
  onRestart(): void;
  onSettings(): void;
  onControls(): void;
  onQuit(): void;
}

/** Dim overlay over the frozen game with the pause menu. Esc (via data-back) resumes. */
export class PauseScreen implements Screen {
  readonly el = document.createElement('div');
  private readonly summary: HTMLElement;
  private readonly stopNav: () => void;
  private lastSummary = '';

  constructor(
    root: HTMLElement,
    private readonly deps: PauseDeps,
  ) {
    this.el.className = 'ov ov-pause';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', 'Paused');
    this.el.innerHTML = `
      <div class="pause-panel">
        <div class="pause-head">
          <h2>PAUSED</h2>
          <div class="pause-summary" aria-live="off"></div>
        </div>
        <nav class="pause-menu" aria-label="Pause menu">
          <button type="button" class="ov-btn primary" data-act="resume" data-back data-autofocus data-hotkey="esc p" data-sfx="screen_transition">${labelWithKeys('RESUME', ['Esc', 'P'], true)}</button>
          <button type="button" class="ov-btn" data-act="restart" data-hotkey="r">${labelWithKeys('Restart race', ['R'])}</button>
          <button type="button" class="ov-btn" data-act="settings" data-hotkey="s">${labelWithKeys('Settings', ['S'])}</button>
          <button type="button" class="ov-btn" data-act="controls" data-hotkey="c">${labelWithKeys('Controls', ['C'])}</button>
          <button type="button" class="ov-btn danger" data-act="quit" data-hotkey="q">${labelWithKeys('Quit to main menu', ['Q'])}</button>
        </nav>
        <p class="pause-foot">The race clock and physics are frozen.</p>
      </div>
      ${keyBar(
        [
          { keys: ['↑', '↓'], label: 'Navigate' },
          { keys: ['Enter'], label: 'Select' },
          { keys: ['Esc'], label: 'Resume' },
          { keys: ['R'], label: 'Restart' },
          { keys: ['Q'], label: 'Quit' },
        ],
        'Gamepad · Start resume · B resume',
      )}`;
    root.appendChild(this.el);
    this.summary = this.el.querySelector('.pause-summary') as HTMLElement;
    this.el.addEventListener('click', this.onClick);
    this.stopNav = enableMenuNav(this.el, {
      onPad: (btn: PadButton) => {
        if (btn !== 'start') return false;
        this.el.querySelector<HTMLElement>('[data-act="resume"]')?.click();
        return true;
      },
    });
  }

  private readonly onClick = (e: Event): void => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    const d = this.deps;
    if (act === 'resume') d.onResume();
    else if (act === 'restart') d.onRestart();
    else if (act === 'settings') d.onSettings();
    else if (act === 'controls') d.onControls();
    else if (act === 'quit') d.onQuit();
  };

  /** e.g. 'Lap 2/3 · P3 · 1:42.380' */
  setSummary(text: string): void {
    if (text === this.lastSummary) return;
    this.lastSummary = text;
    this.summary.textContent = text;
  }

  show(): void {
    this.el.hidden = false;
    focusFirst(this.el);
  }

  hide(): void {
    this.el.hidden = true;
  }

  dispose(): void {
    this.stopNav();
    this.el.removeEventListener('click', this.onClick);
    this.el.remove();
  }
}
