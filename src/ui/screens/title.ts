import { keyBar, labelWithKeys } from '../hotkeys';
import { enableMenuNav, focusFirst } from '../nav';
import type { CarPreview, PreviewFactory, Screen } from '../types';
import './menus.css';

export interface TitleDeps {
  createPreview: PreviewFactory;
  bestLapText: () => string;
  onRace(): void;
  onGarage(): void;
  onSettings(): void;
  onControls(): void;
}

export class TitleScreen implements Screen {
  readonly el = document.createElement('section');
  private readonly preview: CarPreview;
  private readonly best: HTMLElement;
  private readonly disposeNav: () => void;

  constructor(
    root: HTMLElement,
    private readonly deps: TitleDeps,
  ) {
    this.el.className = 'mn mn-title';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Main menu');
    this.el.innerHTML = `
      <div class="left">
        <div>
          <div class="mn-eyebrow">ARCADE COMBAT RACING</div>
          <h1>VOLTLINE</h1>
          <img class="endorse" src="/assets/brand/endorsement_craftmann_app_on_dark.svg" alt="a CraftMann app" width="130" height="24" draggable="false" />
        </div>
        <nav aria-label="Main menu">
          <button type="button" class="item primary" data-act="race" data-hotkey="enter r" data-autofocus>${labelWithKeys('RACE', ['Enter', 'R'], true, 'Harbor Loop · 3 laps')}</button>
          <button type="button" class="item" data-act="garage" data-hotkey="g">${labelWithKeys('GARAGE', ['G'])}</button>
          <button type="button" class="item" data-act="settings" data-hotkey="s">${labelWithKeys('SETTINGS', ['S'])}</button>
          <button type="button" class="item" data-act="controls" data-hotkey="c">${labelWithKeys('CONTROLS', ['C'])}</button>
        </nav>
        <div class="info">
          <div>Best lap · <span class="mn-mono best"></span></div>
          <div>Keyboard or gamepad — no mouse needed.</div>
          <div class="credit">Sound effects by elevenlabs.io</div>
        </div>
      </div>
      <div class="right">
        <div class="stage"></div>
        <div class="stripe"></div>
        <div class="tonight">
          <span class="mn-eyebrow">TONIGHT</span>
          <b>Cat Lai Port</b>
          <span>6 racers · guns hot · 2.8 km</span>
        </div>
      </div>
      ${keyBar(
        [
          { keys: ['↑', '↓'], label: 'Navigate' },
          { keys: ['Enter'], label: 'Select' },
          { keys: ['R'], label: 'Race' },
          { keys: ['G'], label: 'Garage' },
          { keys: ['S'], label: 'Settings' },
          { keys: ['C'], label: 'Controls' },
        ],
        'Gamepad · D-pad navigate · A select · B back',
      )}`;
    root.appendChild(this.el);
    this.best = this.el.querySelector('.best') as HTMLElement;
    this.preview = deps.createPreview(this.el.querySelector('.stage') as HTMLElement, 'kestrel_gt');
    const act: Record<string, () => void> = {
      race: deps.onRace,
      garage: deps.onGarage,
      settings: deps.onSettings,
      controls: deps.onControls,
    };
    this.el
      .querySelectorAll<HTMLElement>('[data-act]')
      .forEach((b) => b.addEventListener('click', () => act[b.dataset.act as string]()));
    this.disposeNav = enableMenuNav(this.el);
    this.refresh();
  }

  /** Show the selected map on the RACE button and the side card. */
  setTrackName(name: string): void {
    const sub = this.el.querySelector('[data-act="race"] small');
    if (sub) sub.textContent = `${name} · 3 laps`;
    const card = this.el.querySelector('.tonight b');
    if (card) card.textContent = name;
  }

  /** Re-read the best-lap text (call after a race). */
  refresh(): void {
    this.best.textContent = this.deps.bestLapText();
  }

  show(): void {
    this.el.hidden = false;
    this.refresh();
    this.preview.show();
    focusFirst(this.el);
  }

  hide(): void {
    this.el.hidden = true;
    this.preview.hide();
  }

  dispose(): void {
    this.disposeNav();
    this.preview.dispose();
    this.el.remove();
  }
}
