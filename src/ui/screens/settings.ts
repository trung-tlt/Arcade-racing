import {
  type QualityName,
  type UserSettings,
  onSettingsChange,
  resetSettings,
  updateSettings,
  userSettings,
} from '../../core/Settings';
import { type PadButton, enableMenuNav, focusFirst } from '../nav';
import { clampStep, kc, keyBar, labelWithKeys, stepValue, wrapStep } from '../hotkeys';
import type { Screen } from '../types';
import { uiAudio } from '../uiAudio';
import './settings.css';

const PRESETS: { id: QualityName; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'med', label: 'Medium' },
  { id: 'high', label: 'High' },
];

const PRESET_NOTES: Record<QualityName, string> = {
  low: 'No shadows, no bloom, 1× pixel ratio, fewer particles',
  med: 'Shadows 1024, bloom, up to 1.5× pixel ratio',
  high: 'Shadows 2048, bloom, up to 2× pixel ratio, full particles',
};

type BoolKey = 'shadows' | 'bloom' | 'showFps' | 'aimAssist' | 'cameraShake' | 'fovKick';
type RangeKey = 'resolutionScale' | 'volumeMaster' | 'volumeEffects' | 'volumeEngine' | 'volumeMusic';

/** One keyboard-selectable setting. `adjust` is ←/→, `toggle` is Space. */
interface Row {
  group: 'Graphics' | 'Audio' | 'Gameplay';
  label: string;
  note?: string;
  adjust(dir: 1 | -1): void;
  toggle(): void;
  /** Re-render the row's value. */
  sync(): void;
  el: HTMLElement;
}

export interface SettingsDeps {
  onBack(): void;
  /** Semi-opaque background, for opening over a paused race. */
  translucent?: boolean;
}

/** Graphics / audio / gameplay settings. Every change applies immediately and is saved. */
export class SettingsScreen implements Screen {
  readonly el: HTMLElement;
  private stopNav: (() => void) | null = null;
  private offSettings: (() => void) | null = null;
  private readonly rows: Row[] = [];

  constructor(
    root: HTMLElement,
    private readonly deps: SettingsDeps,
  ) {
    this.el = document.createElement('section');
    this.el.className = `settings-screen${deps.translucent ? ' screen-overlay' : ''}`;
    this.el.setAttribute('aria-label', 'Settings');
    this.el.hidden = true;
    this.build();
    root.appendChild(this.el);
  }

  private build(): void {
    const head = document.createElement('div');
    head.className = 'st-head';
    head.innerHTML = `<div><div class="st-eyebrow">SETTINGS</div><h2>Settings</h2></div>
      <div class="st-hint">${kc('↑')} ${kc('↓')} choose · ${kc('←')} ${kc('→')} adjust · ${kc('Space')} toggle</div>`;

    const sections = new Map<Row['group'], HTMLElement>();
    for (const g of ['Graphics', 'Audio', 'Gameplay'] as const) {
      const s = document.createElement('section');
      s.className = 'st-section';
      const t = document.createElement('div');
      t.className = 'st-title';
      t.textContent = g.toUpperCase();
      s.appendChild(t);
      sections.set(g, s);
    }

    this.addEnum(
      'Graphics',
      'Quality',
      PRESET_NOTES,
      () => PRESETS.findIndex((p) => p.id === userSettings.preset),
      PRESETS.map((p) => p.label),
      (i) => updateSettings({ preset: PRESETS[i].id }),
    );
    this.addRange('Graphics', 'Resolution', 'resolutionScale', 50, 100, 5, '%');
    this.addBool('Graphics', 'Shadows', 'shadows');
    this.addBool('Graphics', 'Bloom glow', 'bloom');
    this.addBool('Graphics', 'Show FPS', 'showFps');
    this.addRange('Audio', 'Master', 'volumeMaster', 0, 100, 10, '');
    this.addRange('Audio', 'Effects', 'volumeEffects', 0, 100, 10, '');
    this.addRange('Audio', 'Engine', 'volumeEngine', 0, 100, 10, '');
    this.addRange('Audio', 'Music', 'volumeMusic', 0, 100, 10, '');
    this.addBool('Gameplay', 'Aim assist', 'aimAssist', '8° soft lock on the Pulse MG');
    this.addBool('Gameplay', 'Camera shake', 'cameraShake', 'On hits, wrecks and explosions');
    this.addBool('Gameplay', 'Nitro FOV kick', 'fovKick', 'Widens the view while boosting');
    this.addEnum(
      'Gameplay',
      'Speed unit',
      {},
      () => (userSettings.speedUnit === 'kmh' ? 0 : 1),
      ['KM/H', 'MPH'],
      (i) => updateSettings({ speedUnit: i === 0 ? 'kmh' : 'mph' }),
    );

    for (const r of this.rows) sections.get(r.group)?.appendChild(r.el);
    const grid = document.createElement('div');
    grid.className = 'st-grid';
    grid.append(...sections.values());
    this.el.append(head, grid, this.footer());
    (this.rows[0].el as HTMLElement).setAttribute('data-autofocus', '');
  }

  private makeRow(label: string, note: string | undefined): { el: HTMLElement; right: HTMLElement } {
    const el = document.createElement('div');
    el.className = 'st-row';
    el.tabIndex = 0;
    el.setAttribute('data-row', '');
    el.setAttribute('data-nav', '');
    el.setAttribute('role', 'group');
    const text = document.createElement('div');
    text.className = 'st-row-text';
    const b = document.createElement('b');
    b.textContent = label;
    text.appendChild(b);
    if (note) {
      const n = document.createElement('span');
      n.className = 'st-note';
      n.textContent = note;
      text.appendChild(n);
    }
    const right = document.createElement('div');
    right.className = 'st-right';
    el.append(text, right);
    return { el, right };
  }

  private addBool(group: Row['group'], label: string, key: BoolKey, note?: string): void {
    const { el, right } = this.makeRow(label, note);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'st-toggle';
    btn.tabIndex = -1;
    btn.setAttribute('aria-label', label);
    btn.dataset.sfx = 'none';
    const flip = (): void => {
      const next = !userSettings[key];
      uiAudio.play(next ? 'toggle_on' : 'toggle_off');
      updateSettings({ [key]: next } as Partial<UserSettings>);
    };
    btn.addEventListener('click', () => {
      flip();
      el.focus();
    });
    right.appendChild(btn);
    this.rows.push({
      group,
      label,
      note,
      el,
      adjust: (dir) => {
        const next = dir === 1;
        if (next === userSettings[key]) {
          uiAudio.play('blocked');
          return;
        }
        uiAudio.play(next ? 'toggle_on' : 'toggle_off');
        updateSettings({ [key]: next } as Partial<UserSettings>);
      },
      toggle: flip,
      sync: () => {
        btn.textContent = userSettings[key] ? 'ON' : 'OFF';
        btn.setAttribute('aria-pressed', String(userSettings[key]));
        el.setAttribute('aria-label', `${label}: ${userSettings[key] ? 'on' : 'off'}`);
      },
    });
  }

  private addRange(
    group: Row['group'],
    label: string,
    key: RangeKey,
    min: number,
    max: number,
    step: number,
    unit: string,
  ): void {
    const { el, right } = this.makeRow(label, undefined);
    const bar = document.createElement('span');
    bar.className = 'st-bar';
    const fill = document.createElement('i');
    bar.appendChild(fill);
    const val = document.createElement('span');
    val.className = 'st-value';
    // Mouse: click the bar to set the value.
    bar.addEventListener('click', (e) => {
      const r = bar.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const snapped = Math.round((min + f * (max - min)) / step) * step;
      const v = Math.max(min, Math.min(max, snapped));
      if (v !== userSettings[key]) uiAudio.play('slider_step');
      updateSettings({ [key]: v } as Partial<UserSettings>);
      el.focus();
    });
    right.append(bar, val);
    const set = (v: number): void => {
      uiAudio.play(v === userSettings[key] ? 'blocked' : 'slider_step');
      updateSettings({ [key]: v } as Partial<UserSettings>);
    };
    this.rows.push({
      group,
      label,
      el,
      adjust: (dir) => set(stepValue(userSettings[key], dir, step, min, max)),
      toggle: () => undefined,
      sync: () => {
        const v = userSettings[key];
        fill.style.width = `${Math.round(((v - min) / (max - min)) * 100)}%`;
        val.textContent = `${v}${unit}`;
        el.setAttribute('aria-label', `${label}: ${v}${unit}`);
      },
    });
  }

  private addEnum(
    group: Row['group'],
    label: string,
    notes: Partial<Record<QualityName, string>>,
    index: () => number,
    options: string[],
    set: (i: number) => void,
  ): void {
    const hasNotes = Object.keys(notes).length > 0;
    const rawSet = set;
    set = (i: number): void => {
      uiAudio.play(i === index() ? 'blocked' : 'slider_step');
      rawSet(i);
    };
    const { el, right } = this.makeRow(label, undefined);
    const pills = document.createElement('div');
    pills.className = 'st-pills';
    const btns = options.map((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'st-pill';
      b.tabIndex = -1;
      b.textContent = o;
      b.dataset.sfx = 'none';
      b.addEventListener('click', () => {
        set(i);
        el.focus();
      });
      pills.appendChild(b);
      return b;
    });
    right.appendChild(pills);
    const note = document.createElement('div');
    note.className = 'st-note st-row-note';
    if (hasNotes) el.appendChild(note);
    this.rows.push({
      group,
      label,
      el,
      adjust: (dir) => set(clampStep(index(), dir, options.length)),
      toggle: () => set(wrapStep(index(), 1, options.length)),
      sync: () => {
        btns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === index())));
        if (hasNotes) note.textContent = notes[userSettings.preset] ?? '';
        el.setAttribute('aria-label', `${label}: ${options[index()]}`);
      },
    });
  }

  private footer(): HTMLElement {
    const f = document.createElement('div');
    f.className = 'st-footer';
    const left = document.createElement('div');
    left.className = 'st-footer-left';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'st-reset';
    reset.setAttribute('data-hotkey', 'backspace');
    reset.dataset.sfx = 'none';
    reset.innerHTML = `${kc('Backspace')}<span>Reset to defaults</span>`;
    reset.addEventListener('click', () => this.reset());
    const note = document.createElement('div');
    note.className = 'st-footer-note';
    note.innerHTML = '<span>Saved to this browser automatically.</span><span>Sound effects by elevenlabs.io</span>';
    left.append(reset, note);
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'st-done';
    done.setAttribute('data-back', '');
    done.setAttribute('data-hotkey', 'esc');
    done.innerHTML = labelWithKeys('DONE', ['Esc'], true, 'Saved automatically');
    done.addEventListener('click', () => this.deps.onBack());
    f.append(left, done);
    const bar = document.createElement('div');
    bar.innerHTML = keyBar(
      [
        { keys: ['↑', '↓'], label: 'Choose' },
        { keys: ['←', '→'], label: 'Adjust' },
        { keys: ['Space'], label: 'Toggle' },
        { keys: ['Backspace'], label: 'Reset' },
        { keys: ['Esc'], label: 'Done' },
      ],
      'Gamepad · D-pad adjust · A toggle · B done',
    );
    f.appendChild(bar.firstElementChild as HTMLElement);
    return f;
  }

  private reset(): void {
    uiAudio.play('toggle_off');
    resetSettings();
    this.refresh();
  }

  private current(): Row {
    const ae = document.activeElement;
    return this.rows.find((r) => r.el === ae || r.el.contains(ae)) ?? this.rows[0];
  }

  private refresh(): void {
    for (const r of this.rows) r.sync();
  }

  private handleKey(token: string): boolean {
    if (token === 'arrowleft' || token === 'arrowright') {
      const row = this.current();
      row.adjust(token === 'arrowright' ? 1 : -1);
      row.el.focus();
      return true;
    }
    if (token === 'space') {
      const row = this.current();
      row.toggle();
      row.el.focus();
      return true;
    }
    if (token === 'backspace') {
      this.reset();
      return true;
    }
    return false;
  }

  private handlePad(btn: PadButton): boolean {
    if (btn === 'left' || btn === 'right') {
      this.current().adjust(btn === 'right' ? 1 : -1);
      return true;
    }
    if (btn === 'a') {
      this.current().toggle();
      return true;
    }
    return false;
  }

  show(): void {
    this.refresh();
    this.offSettings ??= onSettingsChange(() => this.refresh());
    this.el.hidden = false;
    this.stopNav ??= enableMenuNav(this.el, {
      horizontal: false,
      moveSelector: '[data-row]',
      backspaceBack: false,
      onKey: (token) => this.handleKey(token),
      onPad: (btn) => this.handlePad(btn),
    });
    focusFirst(this.el);
  }

  hide(): void {
    this.el.hidden = true;
    this.offSettings?.();
    this.offSettings = null;
  }

  dispose(): void {
    this.offSettings?.();
    this.stopNav?.();
    this.stopNav = null;
    this.el.remove();
  }
}
