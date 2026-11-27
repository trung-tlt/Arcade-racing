import type { RoomView } from '../net/LobbyClient';
import { clock, finishedStatus, loadingStatus, type FinishedStatus, type LoadingStatus } from './onlineRaceStatus';
import { esc, formatRoomCode, icon, str } from './screens/onlineCommon';
import online from '../../data/online_ui.json';
import type { ResultsData } from './types';
import './onlineRaceOverlay.css';

const RING_R = 22;
const RING_LEN = 2 * Math.PI * RING_R;

/** A countdown ring: `frac` of the way round is what is left. Amber under 10 s. */
const ring = (secLeft: number, total: number): string => {
  const frac = Math.max(0, Math.min(1, secLeft / total));
  const warn = secLeft <= 10 ? ' warn' : '';
  return `<svg class="orr-ring${warn}" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="${RING_R}" class="bg"/><circle cx="26" cy="26" r="${RING_R}" class="fg" stroke-dasharray="${(RING_LEN * frac).toFixed(1)} ${RING_LEN.toFixed(1)}" transform="rotate(-90 26 26)"/></svg><span class="orr-sec mn-mono">${secLeft}</span>`;
};

/**
 * The two DOM layers an online race shows on top of the game: "getting everyone ready" until the countdown starts
 * (boards 50, 53) and "finished, waiting" once this player crossed the line (boards 51, 54). They never take input,
 * so the pause menu (Esc) stays reachable.
 */
export class OnlineRaceOverlay {
  private readonly el = document.createElement('div');
  private loadingStart = 0;
  private view: RoomView | null = null;
  private laps = 0;
  private firstFinishAt: number | null = null;
  private timer = 0;
  private mode: 'none' | 'loading' | 'finished' = 'none';
  private lastResults: ResultsData | null = null;

  constructor() {
    this.el.className = 'orr';
    this.el.hidden = true;
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.el);
  }

  /** The grid was announced: show the loading layer until the room leaves `loading`. */
  startLoading(view: RoomView | null, laps: number): void {
    this.clear();
    this.mode = 'loading';
    this.view = view;
    this.laps = laps;
    this.loadingStart = performance.now();
    this.firstFinishAt = null;
    this.paint();
    this.timer = window.setInterval(() => this.paint(), 500);
  }

  /** A room state arrived: keep the loading rows current and drop the layer once the countdown starts. */
  onView(view: RoomView): void {
    this.view = view;
    if (this.mode === 'loading') {
      if (view.phase === 'loading') this.paint();
      else this.clear();
    }
  }

  /** This player's own finished-race summary, about 4 times a second (`final`: standings can no longer change). */
  onFinished(data: ResultsData): void {
    if (this.mode === 'loading') this.clear();
    if (this.mode !== 'finished') {
      this.mode = 'finished';
      this.firstFinishAt = null;
      this.timer = window.setInterval(() => this.paint(), 500);
    }
    this.lastResults = data;
    if (this.firstFinishAt === null && data.rows.some((r) => r.total !== 'RACING' && r.total !== 'DNF')) {
      this.firstFinishAt = performance.now();
    }
    this.paint();
  }

  clear(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.mode = 'none';
    this.lastResults = null;
    this.el.hidden = true;
    this.el.innerHTML = '';
  }

  private paint(): void {
    if (this.mode === 'loading' && this.view) {
      this.el.hidden = false;
      this.el.className = 'orr orr-loading';
      this.el.innerHTML = this.loadingHtml(
        loadingStatus(this.view.roster, this.view.selfId, (performance.now() - this.loadingStart) / 1000),
        this.view,
      );
    } else if (this.mode === 'finished' && this.lastResults) {
      const since = this.firstFinishAt === null ? null : (performance.now() - this.firstFinishAt) / 1000;
      this.el.hidden = false;
      this.el.className = 'orr orr-finished';
      this.el.innerHTML = this.finishedHtml(finishedStatus(this.lastResults, this.laps || 1, since));
    }
  }

  private loadingHtml(s: LoadingStatus, view: RoomView): string {
    const rows = s.rows
      .map((r) => {
        const tag =
          r.state === 'ready'
            ? `<span class="orr-st ready">${icon('ready', 16)}${esc(str('loading.ready'))}</span>`
            : r.state === 'slow'
              ? `<span class="orr-st slow">${esc(online.strings['loading.slow'].split(' ·')[0])}</span>`
              : `<span class="orr-st">${icon('waiting', 16)}…</span>`;
        return `<li class="${r.isMe ? 'me' : ''}"><b>${esc(r.name)}</b>${r.isMe ? '<em class="badge">YOU</em>' : ''}${tag}<span class="orr-bar ${r.state}"><i></i></span></li>`;
      })
      .join('');
    const meLine = str(
      s.me === 'ready' ? 'loading.me.ready' : s.me === 'slow' ? 'loading.me.slow' : 'loading.me.loading',
    );
    const f = s.footer;
    const foot =
      f.kind === 'all'
        ? str('loading.all')
        : f.kind === 'anyway'
          ? str('loading.anyway.join', { names: f.late.join(', ') })
          : f.kind === 'youSlow'
            ? str('loading.youSlow', { 'mm:ss': clock(f.secLeft) })
            : str('loading.wait', { 'mm:ss': clock(f.secLeft) });
    return `<div class="orr-card">
      <div class="mn-eyebrow">${str('loading.room', { code: formatRoomCode(view.code), laps: view.laps })}</div>
      <h2>${esc(str('loading.title'))}</h2>
      <div class="orr-meblock"><div class="orr-me">${meLine}</div><div class="orr-mebar ${s.me}"><i></i></div></div>
      <ul class="orr-list">${rows}</ul>
      <div class="orr-foot">${f.kind === 'wait' || f.kind === 'youSlow' ? ring(s.secLeft, online.loading.timeoutSec) : ''}<span>${foot}</span></div>
      <div class="orr-rule">${esc(str('loading.rule'))}</div>
    </div>`;
  }

  private finishedHtml(s: FinishedStatus): string {
    const waiting = s.racing.length;
    const rows = s.rows
      .map(
        (r) =>
          `<li class="${r.isMe ? 'me' : ''}${r.done ? '' : ' racing'}"><b>${esc(r.name)}</b><span class="mn-mono">${esc(r.text)}</span></li>`,
      )
      .join('');
    const head = s.closed
      ? `<b>${esc(str('finished.closed'))}</b> · ${str('finished.closedSub', { names: s.racing.join(', ') })}`
      : waiting === 0
        ? esc(str('finished.allIn'))
        : waiting === 1
          ? esc(str('finished.waiting1'))
          : str('finished.waiting', { n: waiting });
    return `<div class="orr-banner"><b>${esc(str('finished.label'))}</b> · ${s.place} · <span class="mn-mono">${esc(s.time)}</span><small>${str('finished.sub', { best: s.best })}</small></div>
      <div class="orr-auto">${esc(str('finished.autopilot'))}</div>
      <aside class="orr-side">
        <div class="orr-order"><div class="mn-eyebrow">FINISHING ORDER</div><ul class="orr-list">${rows}</ul></div>
        <div class="orr-foot">${s.secLeft !== null && !s.closed ? ring(s.secLeft, online.finished.closeAfterFirstSec) : ''}<span>${head}</span></div>
        <div class="orr-rule">${str('finished.rule', { 'mm:ss': clock(online.finished.closeAfterFirstSec) })}</div>
        <div class="orr-rule">${esc(str('finished.autopilot'))}</div>
      </aside>`;
  }

  dispose(): void {
    this.clear();
    this.el.remove();
  }
}
