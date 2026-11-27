import type { RoomView } from '../../net/LobbyClient';
import type { ResultRow } from '../../shared/protocol';
import { formatTime } from '../format';
import { keyBar, kc } from '../hotkeys';
import { enableMenuNav, focusFirst } from '../nav';
import type { Screen } from '../types';
import { ONLINE, carName, esc, formatRoomCode, icon, str, trackOf } from './onlineCommon';
import './online.css';
import './onlineMobile.css';

export interface OnlineResultsDeps {
  onRematch(): void;
  /** Click REMATCH again: take the vote back. */
  onWithdraw(): void;
  onLobby(): void;
  onLeave(): void;
}

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

/** The time column: the winner's time, then each finisher's gap to it; DNF for anyone without a time. */
export function timeCell(row: ResultRow, winnerSec: number | null): string {
  if (row.timeSec === null) return str('results.dnf');
  if (winnerSec === null || row.timeSec === winnerSec) return formatTime(row.timeSec);
  return `+${(row.timeSec - winnerSec).toFixed(3)}`;
}

export class OnlineResultsScreen implements Screen {
  readonly el = document.createElement('section');
  private readonly disposeNav: () => void;
  private view: RoomView | null = null;
  private tick: number | null = null;

  constructor(
    root: HTMLElement,
    private readonly deps: OnlineResultsDeps,
  ) {
    this.el.className = 'mn mn-oresults';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Online results');
    root.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el) return;
      if (el.dataset.act === 'rematch') this.vote();
      else if (el.dataset.act === 'lobby') deps.onLobby();
      else if (el.dataset.act === 'leave') deps.onLeave();
    });
    this.disposeNav = enableMenuNav(this.el, {
      onKey: (token) => {
        if (token === 'r' || (token === 'enter' && !(document.activeElement instanceof HTMLButtonElement))) {
          this.vote();
          return true;
        }
        if (token === 'l') {
          deps.onLobby();
          return true;
        }
        return false;
      },
    });
  }

  private voted(): boolean {
    return !!this.view?.rematch?.yes.includes(this.view.selfId);
  }

  private vote(): void {
    if (this.voted()) this.deps.onWithdraw();
    else this.deps.onRematch();
  }

  update(view: RoomView): void {
    this.view = view;
    const rows = view.results ?? [];
    const t = trackOf(view.track);
    const winner = rows.find((r) => r.place === 1)?.timeSec ?? null;
    const mine = rows.find((r) => r.id === view.selfId);
    const fastest = rows.reduce<number | null>(
      (b, r) => (r.bestLapSec !== null && (b === null || r.bestLapSec < b) ? r.bestLapSec : b),
      null,
    );
    const fastestRow = rows.find((r) => r.bestLapSec !== null && r.bestLapSec === fastest);
    const humansHere = view.roster.length;
    const yes = view.rematch?.yes ?? [];
    const voted = this.voted();
    const pct = humansHere > 0 ? Math.round((yes.length / humansHere) * 100) : 0;
    const body = rows
      .map((r) => {
        const you = r.id === view.selfId;
        const left = r.leftLap !== null;
        const inRoom = view.roster.some((p) => p.id === r.id);
        const vote =
          r.bot || !inRoom ? '' : yes.includes(r.id) ? 'yes' : view.rematch?.no.includes(r.id) ? 'no' : 'wait';
        const place = left || r.timeSec === null ? '–' : String(r.place);
        return `<div class="ol-orow${you ? ' you' : ''}${left ? ' left' : ''}">
          <span class="pos${r.place === 1 ? ' first' : ''}">${place}</span>
          <span class="who"><i class="chip" style="background:${you ? ONLINE.colors.own : left ? ONLINE.colors.disconnected : ONLINE.colors.enemy}"></i><b>${esc(r.name)}</b>${you ? '<em class="badge">YOU</em>' : ''}${left ? `<span class="dc">${icon('disconnected', 16)}${esc(str('results.left', { lap: r.leftLap ?? 1 }))}</span>` : ''}</span>
          <span class="car">${esc(carName(r.car))}</span>
          <span class="mn-mono time">${esc(timeCell(r, winner))}</span>
          <span class="mn-mono best">${r.bestLapSec !== null ? `<span class="${r.bestLapSec === fastest ? 'fastest' : ''}">${formatTime(r.bestLapSec)}</span>` : '–'}</span>
          <span class="mn-mono ko">${r.takedowns}</span>
          <span class="vote ${vote}">${vote === 'yes' ? `${icon('ready', 16)}YES` : vote === 'wait' ? `${icon('waiting', 16)}DECIDING` : vote === 'no' ? 'LOBBY' : left ? 'LEFT' : '—'}</span>
        </div>`;
      })
      .join('');
    const title = mine && mine.timeSec !== null ? str('results.title', { place: ordinal(mine.place) }) : 'Race over';
    this.el.innerHTML = `
      <div class="ol-page">
        <header class="ol-head">
          <div class="ol-title">
            <div class="mn-eyebrow">ONLINE RESULTS · ${esc(t.name.toUpperCase())} · ${view.laps} LAP${view.laps === 1 ? '' : 'S'} · ROOM ${formatRoomCode(view.code)}</div>
            <h2>${title.replace(/(\d+(?:st|nd|rd|th))/, '<span class="own">$1</span>')}${mine ? ` <span class="sub">of ${rows.length}</span>` : ''}</h2>
          </div>
          <div class="ol-stats">
            <div><b class="mn-mono">${mine?.timeSec != null ? formatTime(mine.timeSec) : str('results.dnf')}</b><span>your time</span></div>
            <div><b class="mn-mono">${mine?.bestLapSec != null ? formatTime(mine.bestLapSec) : '–'}</b><span>your best lap</span></div>
            <div><b class="mn-mono own">${mine?.takedowns ?? 0}</b><span>takedowns</span></div>
          </div>
        </header>
        <div class="ol-results">
          <div class="ol-table">
            <div class="ol-ocols"><span>POS</span><span>RACER</span><span>CAR</span><span>TIME</span><span>BEST LAP</span><span>KO</span><span>REMATCH</span></div>
            ${body}
            <div class="ol-legend">${fastestRow ? `<b class="fl">${esc(str('results.fastest'))}</b> ${esc(fastestRow.name)} ${formatTime(fastestRow.bestLapSec)} · ` : ''}gaps are to the winner · ${esc(str('results.dnf'))} = left or wrecked out of the race</div>
          </div>
          <div class="ol-vote">
            <div class="ol-votebox">
              <div class="mn-eyebrow">REMATCH VOTE</div>
              <div class="big">${esc(str('results.votes', { n: yes.length, total: humansHere }))}</div>
              <div class="bar"><i style="width:${pct}%"></i></div>
              <div class="note">${esc(str('results.vote.rule'))}</div>
              <div class="back ol-backin mn-mono"></div>
            </div>
            <button type="button" class="ol-rematch${voted ? ' voted' : ''}" data-act="rematch" data-hotkey="enter r" data-sfx="toggle_on" data-autofocus${voted ? ' aria-pressed="true"' : ' aria-pressed="false"'}>
              <span class="lbl2"><span>${esc(str('results.rematch'))}${voted ? ' ✓' : ''}</span><small>${esc(str('results.rematch.sub'))}</small></span>${kc('Enter', true)}
            </button>
            <button type="button" class="ol-lobbybtn" data-act="lobby" data-hotkey="l" data-sfx="screen_transition"><span>${esc(str('results.lobby'))}</span>${kc('L')}</button>
            <button type="button" class="ol-leave" data-act="leave" data-hotkey="esc" data-back><span>${esc(str('results.leave'))}</span>${kc('Esc')}</button>
          </div>
        </div>
        ${keyBar(
          [
            { keys: ['Enter'], label: 'Rematch' },
            { keys: ['L'], label: 'Back to lobby' },
            { keys: ['Esc'], label: 'Leave room' },
          ],
          'Gamepad · D-pad navigate · A select · B back',
        )}
      </div>`;
    this.paintClock();
    if (!this.el.hidden && !this.el.contains(document.activeElement)) focusFirst(this.el);
  }

  private paintClock(): void {
    const el = this.el.querySelector('.ol-backin');
    if (!el || !this.view) return;
    const s = Math.max(0, Math.ceil((this.view.rematchEndsAt - performance.now()) / 1000));
    el.textContent = str('results.backIn', { 'mm:ss': `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` });
  }

  show(): void {
    this.el.hidden = false;
    if (this.tick === null) this.tick = window.setInterval(() => this.paintClock(), 250);
    focusFirst(this.el);
  }

  hide(): void {
    this.el.hidden = true;
    if (this.tick !== null) window.clearInterval(this.tick);
    this.tick = null;
  }

  dispose(): void {
    this.hide();
    this.disposeNav();
    this.el.remove();
  }
}
