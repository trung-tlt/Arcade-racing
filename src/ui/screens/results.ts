import { keyBar, labelWithKeys } from '../hotkeys';
import { ordinal } from '../nameTags';
import { type PadButton, enableMenuNav, focusFirst } from '../nav';
import type { ResultRow, ResultsData, Screen } from '../types';
import './overlays.css';

export interface ResultsDeps {
  onRaceAgain(): void;
  onChangeCar(): void;
  onMainMenu(): void;
}

/** 2140 → '2,140'. */
export function formatScore(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function rowClass(r: ResultRow): string {
  const state = r.total === 'RACING' ? ' racing' : r.total === 'DNF' ? ' dnf' : '';
  return (r.isPlayer ? 'me' : '') + state;
}

function rowHtml(r: ResultRow): string {
  return `<td class="pos">${r.pos}</td><td class="driver">${esc(r.name)}</td><td class="car">${esc(r.car)}</td>
    <td class="mono total">${esc(r.total)}</td><td class="mono">${esc(r.best)}</td><td>${r.takedowns}</td>
    <td class="mono">${formatScore(r.score)}</td>`;
}

/** Final standings. `update` is cheap to call every frame: it only writes DOM that changed. */
export class ResultsScreen implements Screen {
  readonly el = document.createElement('div');
  private readonly sub: HTMLElement;
  private readonly title: HTMLElement;
  private readonly chips: HTMLElement;
  private readonly body: HTMLTableSectionElement;
  private readonly note: HTMLElement;
  private readonly stopNav: () => void;
  private last: { sub: string; title: string; chips: string; note: string } = {
    sub: '',
    title: '',
    chips: '',
    note: '',
  };
  private rowKeys: string[] = [];

  constructor(
    root: HTMLElement,
    private readonly deps: ResultsDeps,
  ) {
    this.el.className = 'ov ov-results';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Race results');
    this.el.innerHTML = `
      <div class="res">
        <div class="res-head">
          <div>
            <div class="res-sub"></div>
            <h2 class="res-title"></h2>
          </div>
          <div class="res-chips"></div>
        </div>
        <div class="res-table-wrap">
          <table class="res-table">
            <thead><tr>
              <th scope="col">POS</th><th scope="col">DRIVER</th><th scope="col">CAR</th><th scope="col">TOTAL</th>
              <th scope="col">BEST LAP</th><th scope="col">TAKEDOWNS</th><th scope="col">SCORE</th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="res-foot">
          <div class="res-note"></div>
          <div class="res-actions">
            <button type="button" class="ov-btn" data-act="menu" data-hotkey="m">${labelWithKeys('Main menu', ['M'])}</button>
            <button type="button" class="ov-btn" data-act="car" data-hotkey="c" data-sfx="screen_transition">${labelWithKeys('Change car', ['C'])}</button>
            <button type="button" class="ov-btn primary" data-act="again" data-autofocus data-hotkey="enter r" data-sfx="start_race">${labelWithKeys('RACE AGAIN', ['Enter', 'R'], true)}</button>
          </div>
        </div>
      </div>
      ${keyBar(
        [
          { keys: ['Enter'], label: 'Race again' },
          { keys: ['C'], label: 'Change car' },
          { keys: ['M'], label: 'Main menu' },
          { keys: ['↑', '↓'], label: 'Navigate' },
        ],
        'Gamepad · A race again · Y change car · B menu',
      )}`;
    root.appendChild(this.el);
    const q = (s: string): HTMLElement => this.el.querySelector(s) as HTMLElement;
    this.sub = q('.res-sub');
    this.title = q('.res-title');
    this.chips = q('.res-chips');
    this.body = q('tbody') as HTMLTableSectionElement;
    this.note = q('.res-note');
    this.el.addEventListener('click', this.onClick);
    this.stopNav = enableMenuNav(this.el, {
      onPad: (btn: PadButton) => {
        const act = btn === 'a' ? 'again' : btn === 'y' ? 'car' : btn === 'b' ? 'menu' : null;
        if (!act) return false;
        this.el.querySelector<HTMLElement>(`[data-act="${act}"]`)?.click();
        return true;
      },
    });
  }

  private readonly onClick = (e: Event): void => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'again') this.deps.onRaceAgain();
    else if (act === 'car') this.deps.onChangeCar();
    else if (act === 'menu') this.deps.onMainMenu();
  };

  update(d: ResultsData): void {
    if (d.subtitle !== this.last.sub) {
      this.last.sub = d.subtitle;
      this.sub.textContent = d.subtitle;
    }
    const title = ordinal(d.position);
    if (title !== this.last.title) {
      this.last.title = title;
      this.title.innerHTML = `You finished <span>${title}</span>`;
    }
    const chips = `${d.bestLap}|${d.newBest}|${d.takedowns}|${d.score}`;
    if (chips !== this.last.chips) {
      this.last.chips = chips;
      this.chips.innerHTML = `
        <div class="res-chip${d.newBest ? ' new' : ''}"><b>${esc(d.bestLap)}</b><span>${d.newBest ? 'new best lap' : 'best lap'}</span></div>
        <div class="res-chip"><b>${d.takedowns}</b><span>takedowns</span></div>
        <div class="res-chip"><b>${formatScore(d.score)}</b><span>score</span></div>`;
    }
    if (d.footnote !== this.last.note) {
      this.last.note = d.footnote;
      this.note.textContent = d.footnote;
    }
    this.syncRows(d.rows);
  }

  private syncRows(rows: readonly ResultRow[]): void {
    while (this.body.rows.length > rows.length) this.body.deleteRow(-1);
    while (this.body.rows.length < rows.length) this.body.insertRow();
    rows.forEach((r, i) => {
      const key = JSON.stringify(r);
      if (this.rowKeys[i] === key) return;
      this.rowKeys[i] = key;
      const tr = this.body.rows[i];
      tr.className = rowClass(r);
      tr.innerHTML = rowHtml(r);
    });
    this.rowKeys.length = rows.length;
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
