import type { Rival } from '../../ai/Roster';
import { CARS, TRACKS, type TrackDef } from '../../core/Data';
import { clampStep, kc, keyBar, keyChips, labelWithKeys, wrapStep } from '../hotkeys';
import { type PadButton, enableMenuNav, focusFirst } from '../nav';
import { uiAudio } from '../uiAudio';
import { buildOutline } from '../trackOutline';
import type { Difficulty, RaceSetup, Screen } from '../types';
import './menus.css';

export interface RaceSetupDeps {
  getCarId(): string;
  /** The five rivals for the coming race (random names and cars), so the grid preview matches the race. */
  getRoster(trackId: string): Rival[];
  /** Best-lap text for one map (records are per map). */
  bestLapText(trackId: string): string;
  onBack(): void;
  onStart(setup: RaceSetup): void;
}

/** Lap choices on a map: 1, 3 and 5, plus the map's own default when it is something else (Map 4 runs 2). */
const lapOptions = (t: TrackDef): number[] => [...new Set([1, t.laps, 3, 5])].sort((a, b) => a - b);
const DIFFS: { id: Difficulty; label: string; note: string }[] = [
  { id: 'easy', label: 'Easy', note: 'Rivals brake early and rarely shoot. Rubber-banding helps you.' },
  { id: 'normal', label: 'Normal', note: 'Rivals race clean and fight back. Wins about half the time.' },
  { id: 'hard', label: 'Hard', note: 'Rivals take the shortcut, chase takedowns and hold their line.' },
];

type RowId = 'track' | 'laps' | 'diff';

const shortName = (t: TrackDef): string => t.name.replace('Boulevard', 'Blvd');
/** Phone labels: four buttons share ~430 px. */
const MOBILE_NAMES: Record<string, string> = {
  cat_lai: 'Cat Lai',
  cong_hoa: 'Cong Hoa',
  xa_lo_ha_noi: 'Hanoi Hwy',
  pham_van_dong: 'P.V. Đồng',
  monte_carlo: 'Monaco',
  ardennes: 'Ardennes',
};

/** In-game renders of each map (from the design canvas), shown on the track card. */
const previewUrl = (t: TrackDef): string => `/assets/ui/previews/${t.id}.jpg`;
const kmText = (t: TrackDef): string => `${(t.lapLengthM / 1000).toFixed(1)} km`;

interface Section {
  id: string;
  name: string;
}

const NOTES: Record<string, { sub: string; note: string; feature: { v: string; l: string } }> = {
  cat_lai: {
    sub: 'Night · Thủ Đức, HCMC',
    note: 'Night · container port · cranes + reefer-lane shortcut',
    feature: { v: '6 cranes', l: '+ shortcut' },
  },
  cong_hoa: {
    sub: 'Day · Tân Bình, HCMC',
    note: 'Day · HCMC boulevard · roundabout + traffic',
    feature: { v: '2 × 3', l: 'lanes + median' },
  },
  xa_lo_ha_noi: {
    sub: 'Dusk · Thủ Đức, HCMC',
    note: 'Dusk · highway · river bridge, underpass + metro viaduct',
    feature: { v: '+11 m', l: 'bridge crest' },
  },
  pham_van_dong: {
    sub: 'Storm · Gò Vấp to Thủ Đức, HCMC',
    note: 'Storm · wet grip · puddles, flooded dip + lightning',
    feature: { v: '12 lanes', l: '+ flooded dip' },
  },
  monte_carlo: {
    sub: 'Day · Circuit du Port',
    note: 'Day · harbour street circuit · tunnel, 12 m wide, no-fire zones',
    feature: { v: '+42 m', l: 'Casino climb' },
  },
  ardennes: {
    sub: 'Day · Circuit des Ardennes',
    note: 'Day · 6.9 km forest circuit · Eau Rouge climb, 102 m of elevation, no-fire zones',
    feature: { v: '+30 m', l: 'Raidillon climb' },
  },
};

const TIME_OF_DAY: Record<TrackDef['timeOfDay'], string> = { night: 'Night', day: 'Day', dusk: 'Dusk', storm: 'Storm' };

/** Subtitle, note and headline feature for a map; falls back to data for maps without hand-written copy. */
function trackCopy(t: TrackDef): { sub: string; note: string; feature: { v: string; l: string } } {
  const known = NOTES[t.id];
  if (known) return known;
  const tod = TIME_OF_DAY[t.timeOfDay];
  const sections = (t.raw.sections as Section[] | undefined)?.length ?? 0;
  return { sub: tod, note: `${tod} · ${sections} sections`, feature: { v: String(sections), l: 'sections' } };
}

const carName = (id: string): string => CARS.find((c) => c.id === id)?.name ?? id;

export class RaceSetupScreen implements Screen {
  readonly el = document.createElement('section');
  private readonly disposeNav: () => void;
  private trackIndex = 0;
  private laps = TRACKS[0].laps;
  /** Once the player picks a lap count, switching maps keeps it (when the new map offers it). */
  private lapsChosen = false;
  private difficulty: Difficulty = 'normal';

  constructor(
    root: HTMLElement,
    private readonly deps: RaceSetupDeps,
  ) {
    this.el.className = 'mn mn-setup';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Race setup');
    this.el.innerHTML = `
      <div class="mn-page">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px">
          <div><div class="mn-eyebrow">STEP 2 OF 2 · RACE SETUP</div><h2>Set up the race</h2></div>
          <div class="cs-hint">${kc('↑')} ${kc('↓')} choose row · ${kc('←')} ${kc('→')} change</div>
        </div>
        <div class="body">
          <div class="track-card">
            <div class="head"><b class="tname"></b><span class="tsub"></span></div>
            <div class="preview">
              <img class="shot" alt="" width="960" height="540" draggable="false" />
              <svg class="outline" viewBox="0 0 760 740" role="img"></svg>
            </div>
            <div class="sections" aria-label="Sections"></div>
            <div class="facts">
              <div><b class="tlen"></b>lap</div>
              <div><b class="mn-mono best" style="font-size:18px"></b>your best lap</div>
              <div><b class="tfeat"></b><span class="tfeatl"></span></div>
            </div>
          </div>
          <div class="opts">
            <div class="group row" data-row="track" data-nav tabindex="0" data-autofocus role="group" aria-label="Track">
              <div class="rowhead"><div class="mn-eyebrow">TRACK</div>${keyChips(['T'])}</div>
              <div class="pills" data-group="track"></div>
              <div class="note tracknote" aria-live="polite"></div>
            </div>
            <div class="group row" data-row="laps" data-nav tabindex="0" role="group" aria-label="Laps">
              <div class="rowhead"><div class="mn-eyebrow">LAPS</div>${keyChips(['L'])}</div>
              <div class="pills" data-group="laps"></div>
            </div>
            <div class="group row" data-row="diff" data-nav tabindex="0" role="group" aria-label="AI difficulty">
              <div class="rowhead"><div class="mn-eyebrow">AI DIFFICULTY</div>${keyChips(['D'])}</div>
              <div class="pills" data-group="diff"></div>
              <div class="note diffnote" aria-live="polite"></div>
            </div>
            <div class="group"><div class="mn-eyebrow">GRID</div><div class="grid"></div></div>
          </div>
        </div>
        <div class="mn-foot">
          <button type="button" class="mn-btn" data-back data-hotkey="esc">${labelWithKeys('BACK', ['Esc'])}</button>
          <button type="button" class="mn-btn primary" data-start data-hotkey="enter" data-sfx="none">${labelWithKeys('START RACE', ['Enter'], true)}</button>
        </div>
        ${keyBar(
          [
            { keys: ['↑', '↓'], label: 'Row' },
            { keys: ['←', '→'], label: 'Change' },
            { keys: ['T'], label: 'Track' },
            { keys: ['L'], label: 'Laps' },
            { keys: ['D'], label: 'Difficulty' },
            { keys: ['Enter'], label: 'Start' },
            { keys: ['Esc'], label: 'Back' },
          ],
          'Gamepad · D-pad navigate · A select · B back',
        )}
      </div>`;
    root.appendChild(this.el);
    this.el.querySelector('[data-back]')?.addEventListener('click', () => {
      uiAudio.setMusicForTrack(null);
      deps.onBack();
    });
    this.el.querySelector('[data-start]')?.addEventListener('click', () => this.start());
    this.disposeNav = enableMenuNav(this.el, {
      horizontal: false,
      moveSelector: '[data-row]',
      onKey: (token, e) => this.handleKey(token, e),
      onPad: (btn) => this.handlePad(btn),
    });
    // Warm the cache so switching maps never shows an empty frame.
    for (const t of TRACKS) new Image().src = previewUrl(t);
    this.render();
  }

  private rowOf(e: Element | null): RowId {
    const r = (e?.closest('[data-row]') as HTMLElement | null)?.dataset.row;
    return r === 'diff' || r === 'laps' || r === 'track' ? r : 'track';
  }

  private focusRow(row: RowId): void {
    (this.el.querySelector(`[data-row="${row}"]`) as HTMLElement | null)?.focus();
  }

  /** Move a row's value: ±1 clamps (arrows), cycling wraps (T / L / D). Plays the matching sound. */
  private change(row: RowId, dir: 1 | -1, wrap: boolean): void {
    const step = wrap ? wrapStep : clampStep;
    const before = `${this.trackIndex}|${this.laps}|${this.difficulty}`;
    if (row === 'track') this.setTrack(step(this.trackIndex, dir, TRACKS.length));
    else if (row === 'laps') {
      const opts = lapOptions(TRACKS[this.trackIndex]);
      this.laps = opts[step(opts.indexOf(this.laps), dir, opts.length)];
      this.lapsChosen = true;
    } else {
      const i = DIFFS.findIndex((d) => d.id === this.difficulty);
      this.difficulty = DIFFS[step(i, dir, DIFFS.length)].id;
    }
    const changed = before !== `${this.trackIndex}|${this.laps}|${this.difficulty}`;
    uiAudio.play(!changed ? 'blocked' : row === 'track' ? 'track_switch' : 'toggle_on');
    this.render();
  }

  /** Select a map. Laps follow the map's own count until the player picks one, and always stay a valid choice. */
  private setTrack(i: number): void {
    this.trackIndex = i;
    const t = TRACKS[i];
    if (!this.lapsChosen || !lapOptions(t).includes(this.laps)) this.laps = t.laps;
  }

  private start(): void {
    uiAudio.play('start_race'); // its `then` fades the menu music out over 1.2 s
    this.deps.onStart({
      carId: this.deps.getCarId(),
      trackId: TRACKS[this.trackIndex].id,
      laps: this.laps,
      difficulty: this.difficulty,
    });
  }

  private handleKey(token: string, e: KeyboardEvent): boolean {
    const ae = document.activeElement;
    if (token === 'arrowleft' || token === 'arrowright') {
      this.change(this.rowOf(ae), token === 'arrowright' ? 1 : -1, false);
      this.focusRow(this.rowOf(ae));
      return true;
    }
    if (token === 't' || token === 'l' || token === 'd') {
      if (e.repeat) return true;
      const row: RowId = token === 't' ? 'track' : token === 'l' ? 'laps' : 'diff';
      this.change(row, 1, true);
      this.focusRow(row);
      return true;
    }
    // Enter always starts the race — unless Back has the focus.
    if (token === 'enter' && !ae?.closest('[data-back]')) {
      this.start();
      return true;
    }
    return false;
  }

  private handlePad(btn: PadButton): boolean {
    if (btn === 'left' || btn === 'right') {
      const row = this.rowOf(document.activeElement);
      this.change(row, btn === 'right' ? 1 : -1, false);
      this.focusRow(row);
      return true;
    }
    if (btn === 'a' && !document.activeElement?.closest('[data-back]')) {
      this.start();
      return true;
    }
    return false;
  }

  private pills<T>(
    group: string,
    opts: { v: T; label: string; short?: string }[],
    current: T,
    pick: (v: T) => void,
  ): void {
    const host = this.el.querySelector(`[data-group="${group}"]`) as HTMLElement;
    host.replaceChildren(
      ...opts.map((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pill';
        b.dataset.sfx = 'none';
        b.tabIndex = -1;
        b.textContent = o.label;
        // Phones show the short label from CSS (`::after`), so the DOM text stays the full name.
        if (o.short) b.dataset.short = o.short;
        b.setAttribute('aria-pressed', String(o.v === current));
        b.addEventListener('click', () => {
          if (o.v !== current) uiAudio.play(group === 'track' ? 'track_switch' : 'toggle_on');
          pick(o.v);
          if (group === 'laps') this.lapsChosen = true;
          this.render();
          (this.el.querySelector(`[data-row="${group}"]`) as HTMLElement | null)?.focus();
        });
        return b;
      }),
    );
  }

  /** Left panel: outline, sections and facts of the selected map. */
  private renderTrack(t: TrackDef): void {
    const copy = trackCopy(t);
    (this.el.querySelector('.tname') as HTMLElement).textContent = t.name;
    (this.el.querySelector('.tsub') as HTMLElement).textContent = copy.sub;
    (this.el.querySelector('.tracknote') as HTMLElement).textContent = copy.note;
    (this.el.querySelector('.tlen') as HTMLElement).textContent = kmText(t);
    (this.el.querySelector('.tfeat') as HTMLElement).textContent = copy.feature.v;
    (this.el.querySelector('.tfeatl') as HTMLElement).textContent = copy.feature.l;

    const shot = this.el.querySelector('.shot') as HTMLImageElement;
    shot.hidden = false;
    shot.alt = `${t.name} preview`;
    const frame = this.el.querySelector('.preview') as HTMLElement;
    frame.classList.remove('no-shot');
    shot.onerror = () => {
      // no render for this map: the outline alone remains
      shot.hidden = true;
      frame.classList.add('no-shot');
    };
    if (!shot.src.endsWith(previewUrl(t))) shot.src = previewUrl(t);

    const o = buildOutline(t.spline.points);
    const asphalt = Math.max(6, Math.min(34, t.roadWidthM * o.scale * 1.8));
    const line = asphalt > 20 ? 4 : 2.5;
    const water = (t.raw.dressing as { water?: { xFromM: number } } | undefined)?.water;
    const waterRect = water
      ? `<rect x="${o.project(water.xFromM, 0).x.toFixed(1)}" y="0" width="760" height="740" fill="#0F2236"/>`
      : '';
    const svg = this.el.querySelector('.outline') as SVGElement;
    svg.setAttribute('aria-label', `${t.name} track outline`);
    svg.innerHTML = `${waterRect}
      <path d="${o.d}" fill="none" stroke="#2A3240" stroke-width="${asphalt.toFixed(1)}" stroke-linejoin="round"/>
      <path d="${o.d}" fill="none" stroke="#FF6A1A" stroke-width="${line}" stroke-linejoin="round"/>
      <line x1="${o.start.x1.toFixed(1)}" y1="${o.start.y1.toFixed(1)}" x2="${o.start.x2.toFixed(1)}" y2="${o.start.y2.toFixed(1)}" stroke="#E8ECF2" stroke-width="6"/>`;

    const sections = (t.raw.sections as Section[] | undefined) ?? [];
    (this.el.querySelector('.sections') as HTMLElement).replaceChildren(
      ...sections.map((sec) => {
        const d = document.createElement('span');
        d.className = 'sec';
        const k = document.createElement('b');
        k.textContent = sec.id;
        d.append(k, ` ${sec.name}`);
        return d;
      }),
    );
    (this.el.querySelector('.best') as HTMLElement).textContent = this.deps.bestLapText(t.id);
  }

  private render(): void {
    this.pills(
      'track',
      TRACKS.map((t, i) => ({ v: i, label: shortName(t), short: MOBILE_NAMES[t.id] ?? shortName(t) })),
      this.trackIndex,
      (v) => this.setTrack(v),
    );
    this.renderTrack(TRACKS[this.trackIndex]);
    if (!this.el.hidden) uiAudio.setMusicForTrack(TRACKS[this.trackIndex].id); // maps with their own menu loop
    this.pills(
      'laps',
      lapOptions(TRACKS[this.trackIndex]).map((v) => ({ v, label: `${v} ${v === 1 ? 'lap' : 'laps'}` })),
      this.laps,
      (v) => (this.laps = v),
    );
    this.pills(
      'diff',
      DIFFS.map((d) => ({ v: d.id, label: d.label })),
      this.difficulty,
      (v) => (this.difficulty = v),
    );
    (this.el.querySelector('.diffnote') as HTMLElement).textContent =
      DIFFS.find((d) => d.id === this.difficulty)?.note ?? '';

    const grid = this.el.querySelector('.grid') as HTMLElement;
    const slot = (pos: number, name: string, car: string, you: boolean): HTMLElement => {
      const d = document.createElement('div');
      d.className = you ? 'slot you' : 'slot';
      const b = document.createElement('b');
      b.textContent = `P${pos} · ${name}`;
      const s = document.createElement('span');
      s.textContent = car;
      d.append(b, document.createElement('br'), s);
      return d;
    };
    const rivals = this.deps.getRoster(TRACKS[this.trackIndex].id);
    const slots = rivals.map((r, i) => slot(i + 1, r.name, carName(r.car), false));
    slots.push(slot(rivals.length + 1, 'YOU', carName(this.deps.getCarId()), true));
    grid.replaceChildren(...slots);
  }

  show(): void {
    this.el.hidden = false;
    this.render(); // the chosen car may have changed
    focusFirst(this.el);
  }

  hide(): void {
    this.el.hidden = true;
  }

  dispose(): void {
    this.disposeNav();
    this.el.remove();
  }
}
