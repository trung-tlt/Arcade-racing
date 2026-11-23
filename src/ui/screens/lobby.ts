import { TRACKS } from '../../core/Data';
import type { RoomView } from '../../net/LobbyClient';
import { uiAudio } from '../uiAudio';
import { keyBar, kc } from '../hotkeys';
import { enableMenuNav, focusFirst } from '../nav';
import type { Screen } from '../types';
import {
  ONLINE,
  carName,
  esc,
  formatRoomCode,
  icon,
  lapOptions,
  pingHtml,
  str,
  trackOf,
  trackPreview,
} from './onlineCommon';
import './online.css';

export interface LobbyDeps {
  onReady(ready: boolean): void;
  onStart(): void;
  onSettings(track?: string, laps?: number): void;
  onChangeCar(): void;
  onLeave(): void;
  /** Picture URL for a car (a cached data URL, '' when it cannot be rendered); omitted in tests. */
  thumb?(carId: string): string;
}

const COPIED_MS = 1600;
const HOST_NOTICE_MS = 8000;

/** Who the host is still waiting on, and whether START is allowed (the lobby rule in data/online_ui.json). */
export function startStatus(view: Pick<RoomView, 'roster'>): { ok: boolean; text: string } {
  const humans = view.roster.filter((r) => !r.bot);
  const ready = humans.filter((r) => r.ready);
  if (humans.length < 2) return { ok: false, text: str('lobby.needTwo') };
  if (humans.length >= 2 && ready.length === humans.length) return { ok: true, text: str('lobby.start.ok') };
  const missing = humans.filter((r) => !r.ready).map((r) => r.name);
  const total = Math.max(2, humans.length);
  return {
    ok: false,
    text: str('lobby.start.wait', {
      n: ready.length,
      total,
      missing: missing.join(', '),
    }),
  };
}

export class LobbyScreen implements Screen {
  readonly el = document.createElement('section');
  private readonly disposeNav: () => void;
  private view: RoomView | null = null;
  private copiedTimer: number | null = null;
  private prev: { ids: string[]; allReady: boolean; ready: boolean; track: string } | null = null;
  /** The previous host, to word "X left · Y is now host" when the host changes. */
  private lastHost: { id: string; name: string } | null = null;
  private notice: { html: string; until: number } | null = null;
  /** One image element per car, cloned into each rebuilt row so the lobby redraw never re-renders or re-encodes a picture. */
  private readonly thumbImgs = new Map<string, HTMLImageElement | null>();

  constructor(
    root: HTMLElement,
    private readonly deps: LobbyDeps,
  ) {
    this.el.className = 'mn mn-lobby';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', str('lobby.title'));
    root.appendChild(this.el);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.disposeNav = enableMenuNav(this.el, {
      onKey: (token) => {
        const v = this.view;
        if (!v) return false;
        if (token === 'space' || token === 'r') return (this.toggleReady(), true);
        if (token === 'k') return (this.copy(), true);
        if (token === 'v') return (deps.onChangeCar(), true);
        if (v.isHost && (token === 'arrowleft' || token === 'arrowright'))
          return (this.stepTrack(token === 'arrowright' ? 1 : -1), true);
        if (v.isHost && token === 'l') return (this.stepLaps(), true);
        if (token === 'enter' && v.isHost && !(document.activeElement instanceof HTMLButtonElement))
          return (this.start(), true);
        return false;
      },
    });
  }

  private thumbImg(carId: string): HTMLImageElement | null {
    let img = this.thumbImgs.get(carId);
    if (img === undefined) {
      const url = this.deps.thumb?.(carId) ?? '';
      img = null;
      if (url) {
        img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.decoding = 'async';
      }
      this.thumbImgs.set(carId, img);
    }
    return img;
  }

  /** Fill the `[data-thumb]` slots of the freshly built DOM with the cached pictures. */
  private fillThumbs(): void {
    for (const slot of this.el.querySelectorAll<HTMLElement>('[data-thumb]')) {
      const img = this.thumbImg(slot.dataset.thumb ?? '');
      if (img) slot.appendChild(img.cloneNode());
    }
  }

  private me(): RoomView['roster'][number] | undefined {
    return this.view?.roster.find((r) => r.id === this.view?.selfId);
  }

  private toggleReady(): void {
    const me = this.me();
    if (me) this.deps.onReady(!me.ready);
  }

  private start(): void {
    if (!this.view?.isHost) return;
    if (!startStatus(this.view).ok) {
      uiAudio.play('blocked');
      return;
    }
    uiAudio.play('start_race');
    this.deps.onStart();
  }

  private stepTrack(dir: 1 | -1): void {
    const v = this.view;
    if (!v) return;
    const i = TRACKS.findIndex((t) => t.id === v.track);
    const next = TRACKS[(i + dir + TRACKS.length) % TRACKS.length];
    this.deps.onSettings(next.id, lapOptions(next).includes(v.laps) ? v.laps : next.laps);
  }

  private stepLaps(): void {
    const v = this.view;
    if (!v) return;
    const opts = lapOptions(trackOf(v.track));
    this.deps.onSettings(undefined, opts[(opts.indexOf(v.laps) + 1) % opts.length]);
  }

  private copy(): void {
    const v = this.view;
    if (!v) return;
    void navigator.clipboard?.writeText(v.code).catch(() => undefined);
    uiAudio.play('toggle_on');
    const label = this.el.querySelector('.ol-copy-label');
    if (label) label.textContent = str('lobby.copied');
    if (this.copiedTimer !== null) window.clearTimeout(this.copiedTimer);
    this.copiedTimer = window.setTimeout(() => {
      const l = this.el.querySelector('.ol-copy-label');
      if (l) l.textContent = str('lobby.copy');
    }, COPIED_MS);
  }

  private onClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el) return;
    switch (el.dataset.act) {
      case 'ready':
        return this.toggleReady();
      case 'start':
        return this.start();
      case 'copy':
        return this.copy();
      case 'car':
        return this.deps.onChangeCar();
      case 'leave':
        return this.deps.onLeave();
      case 'prev':
        return this.stepTrack(-1);
      case 'next':
        return this.stepTrack(1);
      case 'laps':
        return this.deps.onSettings(undefined, Number(el.dataset.n));
    }
  }

  /** Draw the room. Call on every `state` message while the lobby is up. */
  update(view: RoomView): void {
    this.noteFocus();
    this.view = view;
    this.sounds(view);
    this.hostChange(view);
    const me = this.me();
    const t = trackOf(view.track);
    const humans = view.roster.length;
    const st = startStatus(view);
    const slots = Array.from({ length: ONLINE.maxPlayers }, (_, i) => view.roster[i]);
    const rows = slots
      .map((p, i) => {
        if (!p) {
          return `<div class="ol-row empty" role="listitem"><span class="n">${i + 1}</span><span class="ol-open">${str('lobby.open', { code: formatRoomCode(view.code) })}</span></div>`;
        }
        const you = p.id === view.selfId;
        return `<div class="ol-row${you ? ' you' : ''}" role="listitem">
          <span class="n">${i + 1}</span>
          <span class="who"><i class="chip" style="background:${you ? ONLINE.colors.own : ONLINE.colors.enemy}"></i><b>${esc(p.name)}</b>${you ? '<em class="badge">YOU</em>' : ''}${p.host ? `<span class="host" title="Host">${icon('host')}HOST</span>` : ''}</span>
          <span class="car"><i class="ol-thumb" data-thumb="${esc(p.car)}"></i><span class="cn">${esc(carName(p.car))}</span></span>
          <span class="ping">${pingHtml(p.ping)}</span>
          <span class="status ${p.ready ? 'ready' : 'wait'}">${icon(p.ready ? 'ready' : 'waiting')}${p.ready ? str('lobby.ready') : str('lobby.notready')}</span>
        </div>`;
      })
      .join('');
    const lapPills = lapOptions(t)
      .map(
        (n) =>
          `<button type="button" class="pill${n === view.laps ? ' on' : ''}" data-act="laps" data-n="${n}" data-sfx="toggle_on" aria-pressed="${n === view.laps}"${view.isHost ? '' : ' disabled'}>${n}</button>`,
      )
      .join('');
    const hostBtns = view.isHost
      ? `<button type="button" class="ol-arrow l" data-act="prev" data-sfx="track_switch" aria-label="Previous track">←</button><button type="button" class="ol-arrow r" data-act="next" data-sfx="track_switch" aria-label="Next track">→</button>`
      : '';
    this.el.innerHTML = `
      <div class="ol-page">
        <header class="ol-head">
          <div class="ol-title">
            <div class="mn-eyebrow">${esc(view.isHost ? str('lobby.host') : str('lobby.guest', { host: view.hostName }))}</div>
            <h2>${esc(str('lobby.title'))} <span class="sub">· ${humans}/${ONLINE.maxPlayers} racers</span></h2>
          </div>
          <div class="ol-codebox"><div><span class="mn-eyebrow">${esc(str('lobby.code'))}</span><span class="ol-code-val mn-mono">${formatRoomCode(view.code)}</span></div>
            <button type="button" class="ol-copybtn" data-act="copy" data-sfx="none" aria-label="Copy room code">${icon('copy', 20)}<span class="ol-copy-label">${esc(str('lobby.copy'))}</span>${kc('K')}</button></div>
        </header>
        ${this.notice && this.notice.until > performance.now() ? `<div class="ol-notice" role="status">${this.notice.html}</div>` : ''}
        <div class="ol-lobby">
          <div class="ol-players" role="list" aria-label="Players">
            <div class="ol-cols"><span>#</span><span>RACER</span><span>CAR</span><span>PING</span><span>STATUS</span></div>
            ${rows}
            <p class="ol-note">${esc(str('lobby.sameCar'))}</p>
          </div>
          <div class="ol-side">
            <div class="ol-track">
              <div class="ol-trackimg"><img src="${trackPreview(t.id)}" alt="${esc(t.name)} preview" />${hostBtns}</div>
              <div class="ol-trackbody">
                <div class="ol-trackname"><b>${esc(t.name)}</b><span>${esc(t.timeOfDay)} · ${(t.lapLengthM / 1000).toFixed(1)} km</span></div>
                <div class="ol-laps"><span class="mn-eyebrow">LAPS</span>${lapPills}${view.isHost ? `<span class="keys">${kc('←')}${kc('→')}${kc('L')}</span>` : ''}</div>
                ${view.isHost ? '' : `<div class="ol-lock">${icon('lock', 16)}${esc(str('lobby.hostonly'))}</div>`}
              </div>
            </div>
            <button type="button" class="ol-mycar" data-act="car" data-hotkey="v" data-sfx="vehicle_switch">
              <i class="ol-thumb big" data-thumb="${esc(me?.car ?? '')}"></i><span class="lbl2"><small>YOUR CAR</small><b>${esc(carName(me?.car ?? ''))}</b></span><span class="chg">Change ${kc('V')}</span>
            </button>
            <button type="button" class="ol-ready${me?.ready ? ' on' : ''}" data-act="ready" data-hotkey="space r" data-sfx="none">
              <span class="lbl2"><span>${esc(me?.ready ? str('lobby.ready') : str('lobby.readyup'))}</span><small>${esc(me?.ready ? str('lobby.unready.sub') : str('lobby.readyup.sub'))}</small></span>${kc('Space', !me?.ready)}
            </button>
            ${
              view.isHost
                ? `<button type="button" class="ol-start${st.ok ? ' go' : ''}" data-act="start" data-hotkey="enter" data-sfx="none" aria-disabled="${!st.ok}">
              <span class="lbl2"><span>${esc(str('lobby.start'))}</span><small>${esc(st.text)}</small></span>${kc('Enter', st.ok)}</button>`
                : `<div class="ol-wait">${icon('host', 18)}${esc(str('lobby.waitHost', { host: view.hostName }))}</div>`
            }
            <button type="button" class="ol-leave" data-act="leave" data-hotkey="esc" data-back>${esc(str('lobby.leave'))} ${kc('Esc')}</button>
          </div>
        </div>
        ${keyBar(
          [
            { keys: ['Space'], label: 'Ready' },
            ...(view.isHost
              ? [
                  { keys: ['Enter'], label: 'Start (host)' },
                  { keys: ['←', '→'], label: 'Track' },
                  { keys: ['L'], label: 'Laps' },
                ]
              : []),
            { keys: ['V'], label: 'Change car' },
            { keys: ['Esc'], label: 'Leave' },
          ],
          'Gamepad · D-pad navigate · A select · B back',
        )}
      </div>`;
    this.fillThumbs();
    // The rebuilt DOM drops focus: give it back to the same control (or the first, when the screen just opened).
    const same = this.focusKey ? (this.el.querySelector(`[data-act="${this.focusKey}"]`) as HTMLElement | null) : null;
    if (same) same.focus();
    else if (!this.el.hidden) focusFirst(this.el);
  }

  private focusKey = '';

  /** When the host seat changed hands because the old host left, say so for a few seconds. */
  private hostChange(v: RoomView): void {
    const host = v.roster.find((r) => r.host);
    const was = this.lastHost;
    if (was && host && host.id !== was.id && !v.roster.some((r) => r.id === was.id)) {
      const html =
        host.id === v.selfId
          ? str('lobby.youAreHost', { name: was.name })
          : str('lobby.newHost', { name: was.name, host: host.name });
      this.notice = { html, until: performance.now() + HOST_NOTICE_MS };
    }
    this.lastHost = host ? { id: host.id, name: host.name } : null;
  }

  private sounds(v: RoomView): void {
    const ids = v.roster.map((r) => r.id);
    const humans = v.roster;
    const allReady = humans.length >= 2 && humans.every((r) => r.ready);
    const ready = !!this.me()?.ready;
    const p = this.prev;
    if (p) {
      if (ids.length > p.ids.length) uiAudio.play('confirm');
      else if (ids.length < p.ids.length) uiAudio.play('back');
      if (ready !== p.ready) uiAudio.play(ready ? 'toggle_on' : 'toggle_off');
      if (allReady && !p.allReady) uiAudio.play('vehicle_confirm');
      if (v.track !== p.track) uiAudio.play('track_switch');
    }
    this.prev = { ids, allReady, ready, track: v.track };
  }

  show(): void {
    this.el.hidden = false;
    this.prev = null;
    this.view = null;
    this.focusKey = '';
    this.lastHost = null;
    this.notice = null;
  }

  /** Remember which control had focus so a redraw can give it back. */
  noteFocus(): void {
    this.focusKey = (document.activeElement as HTMLElement | null)?.dataset?.act ?? '';
  }

  hide(): void {
    this.el.hidden = true;
  }

  dispose(): void {
    this.disposeNav();
    this.el.remove();
  }
}
