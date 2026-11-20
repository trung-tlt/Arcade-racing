import { CARS, type CarDef } from '../../core/Data';
import { TOUCH } from '../../core/TouchInput';
import { type PadButton, enableMenuNav, focusFirst } from '../nav';
import { uiAudio } from '../uiAudio';
import { digitIndex, kc, keyBar, labelWithKeys, wrapStep } from '../hotkeys';
import { type CarThumbs, selectedCardColors } from '../carThumbs';
import type { CarPreview, PreviewFactory, Screen } from '../types';
import './menus.css';

export interface CarSelectDeps {
  createPreview: PreviewFactory;
  /** Renders each vehicle's picture for the cards along the bottom; without it the cards show a neutral tile. */
  createThumbs?: () => CarThumbs;
  initialCarId: string;
  onBack(): void;
  onConfirm(carId: string): void;
}

const INFO: Record<string, { role: string; blurb: string; weapon: string }> = {
  kestrel_gt: {
    role: 'BALANCED · STARTER',
    blurb: 'Sleek grand-tourer. Forgiving drift, average everything.',
    weapon: 'Twin Pulse MG · 10 shots/s · 8° assist',
  },
  rhino_x4: {
    role: 'HEAVY · BRAWLER',
    blurb: 'Armored muscle coupe. Wins every collision, ram damage ×2.',
    weapon: 'Heavy twin cannon · same MG stats, ram ×2',
  },
  wisp_r: {
    role: 'LIGHT · HYPER',
    blurb: 'Low carbon wedge. Fastest car, twitchy at the limit, fragile.',
    weapon: 'Single nose-line Pulse MG · 8° assist',
  },
  // Copy for the second garage wave (design boards 20–21). Ids follow the .glb names in the design; the screen
  // only lists cars that exist in data/cars.json, so these stay unused until those models and stats are added.
  warden_px: {
    role: 'POLICE · RAMMER',
    blurb: 'Harbor Patrol interceptor. Push bar, light bar, ram damage ×1.5.',
    weapon: 'Twin Pulse MG behind the light bar',
  },
  bastion_m8: {
    role: 'MILITARY · TANK',
    blurb: 'Armored 4x4. Slowest car, hardest to wreck, ram damage ×2.5.',
    weapon: 'Heavy twin roof cannon',
  },
  sable_rs: {
    role: 'RALLY · DRIFTER',
    blurb: 'Rally hatch. Best drift and launch in the garage, light armor.',
    weapon: 'Twin Pulse MG on the roof',
  },
  hauler_ht: {
    role: 'UTILITY · 360° TURRET',
    blurb: 'Pickup with a shielded bed turret that can fire in any direction.',
    weapon: 'Bed turret · 360° yaw',
  },
  truongson_av8: {
    role: 'APC · 8x8',
    blurb: '8x8 armored carrier. 260 HP, ram ×3, slowest to turn.',
    weapon: 'Autocannon turret · 360°',
  },
  mantis_650r: {
    role: 'SPORT BIKE',
    blurb: '650-class sport bike. Fastest launch, fits any gap, very fragile.',
    weapon: 'Twin fairing guns · ±15°',
  },
  fulmine_fx: {
    role: 'OPEN-WHEEL · DOWNFORCE',
    blurb:
      'Open-wheel hybrid racer. Highest top speed and grip in the garage, but the thinnest hull: wheel contact hurts.',
    weapon: 'Compact Pulse MG on the roll hoop · ±10°',
  },
  mira_150: {
    role: 'RETRO SCOOTER · NIMBLE',
    blurb: 'Retro step-through scooter. Tightest turning circle, slips through traffic, very fragile.',
    weapon: 'Twin pulse pods on a crash bar · ±12°',
  },
};

const STATS: { label: string; pct: (c: CarDef) => number; value: (c: CarDef) => string }[] = [
  { label: 'Top speed', pct: (c) => Math.min(1, c.topSpeedKmh / 340), value: (c) => String(c.topSpeedKmh) },
  { label: 'Accel', pct: (c) => c.accel / 10, value: (c) => String(c.accel) },
  { label: 'Handling', pct: (c) => c.handling / 10, value: (c) => String(c.handling) },
  { label: 'Armor', pct: (c) => c.hp / 260, value: (c) => String(c.hp) },
];

/** Paint colours can be near-black (police car); text uses a light fallback for those. */
function readable(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum < 0.35 ? '#e8ecf2' : hex;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export class CarSelectScreen implements Screen {
  readonly el = document.createElement('section');
  private readonly preview: CarPreview;
  private readonly disposeNav: () => void;
  private selected: string;
  private readonly confirm: () => void;
  private readonly createThumbs: (() => CarThumbs) | undefined;
  private thumbs: CarThumbs | null = null;
  private thumbTimer = 0;
  private thumbQueue: string[] = [];
  private readonly cards = new Map<string, HTMLButtonElement>();

  constructor(root: HTMLElement, deps: CarSelectDeps) {
    this.selected = CARS.some((c) => c.id === deps.initialCarId) ? deps.initialCarId : CARS[0].id;
    this.el.className = 'mn mn-cars';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Car select');
    this.el.innerHTML = `
      <div class="mn-page">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px">
          <div><div class="mn-eyebrow">STEP 1 OF 2 · GARAGE</div><h2>Choose your ride</h2></div>
          <div class="cs-hint">${kc('←')} ${kc('→')} or ${kc('1')}–${kc('0')} ${kc('-')} to switch</div>
        </div>
        <div class="body">
          <div class="stage">
            <div class="host"></div>
            <div class="arrow l">${kc('←')}</div><div class="arrow r">${kc('→')}</div>
            <div class="ident"><div class="name"></div><div class="role"></div></div>
            <div class="pos mn-mono"></div>
            <div class="accent"></div>
            <div class="dots" aria-hidden="true">${CARS.map(() => '<i></i>').join('')}</div>
          </div>
          <div class="info">
            <div class="blurb"></div>
            <div class="stats"></div>
            <div class="weapon"><div class="mn-eyebrow">WEAPON</div><div class="wtext"></div></div>
            <div class="cs-actions">
              <button type="button" class="mn-btn primary cs-select" data-confirm data-autofocus data-hotkey="enter" data-sfx="none">${labelWithKeys('SELECT', ['Enter'], true, 'Next: race setup')}</button>
              <button type="button" class="mn-btn" data-back data-hotkey="esc">${labelWithKeys('BACK', ['Esc'])}</button>
            </div>
          </div>
        </div>
        <div class="cards" role="group" aria-label="All vehicles"></div>
        ${keyBar(
          [
            { keys: ['←', '→'], label: 'Switch' },
            { keys: ['1-0', '-'], label: 'Pick' },
            { keys: ['Enter'], label: 'Select' },
            { keys: ['Esc'], label: 'Back' },
          ],
          'Gamepad · LB/RB switch · A select · B back',
        )}
      </div>`;
    root.appendChild(this.el);
    const cards = this.el.querySelector('.cards') as HTMLElement;
    CARS.forEach((c, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick';
      b.dataset.sfx = 'none'; // setSelected() plays the vehicle sound
      b.dataset.id = c.id;
      b.setAttribute('aria-label', c.name);
      const sel = selectedCardColors(c.paint);
      b.style.setProperty('--card-bg', sel.bg);
      b.style.setProperty('--card-fg', sel.fg);
      b.style.setProperty('--card-bd', sel.border);
      b.innerHTML = `<span class="pk-img"><img alt="" aria-hidden="true" draggable="false" />${idx < 11 ? kc(idx < 9 ? String(idx + 1) : idx === 9 ? '0' : '-') : ''}</span><span class="pk-name"></span>`;
      (b.querySelector('.pk-name') as HTMLElement).textContent = c.name;
      b.addEventListener('click', () => this.setSelected(c.id));
      cards.appendChild(b);
      this.cards.set(c.id, b);
    });
    this.createThumbs = deps.createThumbs;
    // Touch: the ◀ ▶ buttons are tappable and the stage can be swiped (CSS shows them only on touch devices).
    this.el.querySelector('.arrow.l')?.addEventListener('click', () => this.step(-1));
    this.el.querySelector('.arrow.r')?.addEventListener('click', () => this.step(1));
    this.bindSwipe(this.el.querySelector('.stage') as HTMLElement);
    this.el.querySelector('[data-back]')?.addEventListener('click', deps.onBack);
    this.confirm = () => {
      uiAudio.play('vehicle_confirm', { vehicleType: this.selectedType() });
      deps.onConfirm(this.selected);
    };
    this.el.querySelector('[data-confirm]')?.addEventListener('click', this.confirm);
    this.preview = deps.createPreview(this.el.querySelector('.host') as HTMLElement, this.selected);
    this.disposeNav = enableMenuNav(this.el, {
      onKey: (token) => this.handleKey(token),
      onPad: (btn) => this.handlePad(btn),
    });
    this.render();
  }

  /** Horizontal swipe on the stage switches vehicle (threshold from data/touch.json). */
  private bindSwipe(stage: HTMLElement): void {
    let startX: number | null = null;
    let id = -1;
    stage.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest('.arrow')) return;
      startX = e.clientX;
      id = e.pointerId;
    });
    const end = (e: PointerEvent): void => {
      if (startX === null || e.pointerId !== id) return;
      const dx = e.clientX - startX;
      startX = null;
      if (Math.abs(dx) >= TOUCH.swipe.minPx) this.step(dx < 0 ? 1 : -1);
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', () => (startX = null));
  }

  getSelected(): string {
    return this.selected;
  }

  private selectedType(id: string = this.selected): CarDef['vehicleType'] {
    return CARS.find((c) => c.id === id)?.vehicleType ?? 'car';
  }

  /** Switch vehicle (plays the turntable sound, pitched by the new vehicle's type; `silent` for programmatic use). */
  setSelected(id: string, silent = false): void {
    if (!CARS.some((c) => c.id === id) || id === this.selected) return;
    if (!silent) uiAudio.play('vehicle_switch', { vehicleType: this.selectedType(id) });
    this.selected = id;
    this.preview.setCar(id);
    this.render();
  }

  private step(dir: 1 | -1): void {
    const i = CARS.findIndex((c) => c.id === this.selected);
    this.setSelected(CARS[wrapStep(i, dir, CARS.length)].id);
  }

  /** ←/→/A/D/↑/↓ cycle (wrapping), 1–9, 0 and - jump straight to vehicle N, Enter selects. */
  private handleKey(token: string): boolean {
    if (token === 'arrowright' || token === 'd' || token === 'arrowdown') this.step(1);
    else if (token === 'arrowleft' || token === 'a' || token === 'arrowup') this.step(-1);
    else if (token === 'enter') this.confirm();
    else {
      const i = digitIndex(token, CARS.length);
      if (i === null) {
        if (/^[0-9-]$/.test(token)) {
          uiAudio.play('blocked'); // a number with no vehicle behind it
          return true;
        }
        return false;
      }
      this.setSelected(CARS[i].id);
    }
    return true;
  }

  private handlePad(btn: PadButton): boolean {
    if (btn === 'lb' || btn === 'left' || btn === 'up') this.step(-1);
    else if (btn === 'rb' || btn === 'right' || btn === 'down') this.step(1);
    else if (btn === 'a') this.confirm();
    else return false;
    return true;
  }

  private render(): void {
    const car = CARS.find((c) => c.id === this.selected) as CarDef;
    const info = INFO[car.id];
    this.el.style.setProperty('--car', car.paint);
    this.el.style.setProperty('--car-text', readable(car.paint));
    this.el.querySelectorAll<HTMLElement>('.pick').forEach((b) => {
      const on = b.dataset.id === car.id;
      b.setAttribute('aria-pressed', String(on));
      if (on) b.scrollIntoView?.({ block: 'nearest' });
    });
    this.el.querySelectorAll('.dots i').forEach((d, i) => d.classList.toggle('on', i === CARS.indexOf(car)));
    (this.el.querySelector('.pos') as HTMLElement).textContent = `${CARS.indexOf(car) + 1} / ${CARS.length}`;
    (this.el.querySelector('.name') as HTMLElement).textContent = car.name;
    (this.el.querySelector('.role') as HTMLElement).textContent = info?.role ?? '';
    (this.el.querySelector('.blurb') as HTMLElement).textContent = info?.blurb ?? '';
    (this.el.querySelector('.wtext') as HTMLElement).textContent = info?.weapon ?? '';
    const stats = this.el.querySelector('.stats') as HTMLElement;
    stats.innerHTML = STATS.map(
      (s) =>
        `<div class="stat"><span class="lbl">${s.label}</span><div class="rail"><i style="width:${Math.round(clamp01(s.pct(car)) * 100)}%"></i></div><span class="mn-mono">${s.value(car)}</span></div>`,
    ).join('');
  }

  /** Render the card pictures one per tick so the screen appears immediately; the tile shows a placeholder until then. */
  private loadThumbs(): void {
    if (this.thumbs || !this.createThumbs) return;
    this.thumbs = this.createThumbs();
    // Selected car first, then the rest in order.
    this.thumbQueue = [this.selected, ...CARS.map((c) => c.id).filter((id) => id !== this.selected)];
    const next = (): void => {
      this.thumbTimer = 0;
      const id = this.thumbQueue.shift();
      if (!id || !this.thumbs) return;
      const url = this.thumbs.get(id);
      const img = this.cards.get(id)?.querySelector('img');
      if (img && url) {
        img.src = url;
        img.closest('.pk-img')?.classList.add('ready');
      }
      this.thumbTimer = window.setTimeout(next, 16);
    };
    this.thumbTimer = window.setTimeout(next, 60);
  }

  show(): void {
    this.el.hidden = false;
    this.preview.show();
    this.loadThumbs();
    focusFirst(this.el);
  }

  hide(): void {
    this.el.hidden = true;
    this.preview.hide();
  }

  dispose(): void {
    window.clearTimeout(this.thumbTimer);
    this.thumbs?.dispose();
    this.disposeNav();
    this.preview.dispose();
    this.el.remove();
  }
}
