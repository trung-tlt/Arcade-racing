import { ROOM_CODE_LENGTH, cleanRoomCode } from '../../shared/protocol';
import type { HubError } from '../../net/LobbyClient';
import { uiAudio } from '../uiAudio';
import { keyBar, kc } from '../hotkeys';
import { enableMenuNav, focusFirst } from '../nav';
import type { Screen } from '../types';
import { ONLINE, esc, formatRoomCode, icon, str, trackPreview } from './onlineCommon';
import './online.css';
import './onlineMobile.css';

/** What the hub's right-hand panel shows. Errors and waiting states appear in place, never as pop-ups. */
export type HubState =
  | { kind: 'idle' }
  | { kind: 'search'; startedAt: number }
  | { kind: 'found'; code: string; racers: number; trackName: string; laps: number }
  | { kind: 'error'; err: HubError; code?: string; roomV?: string; myV?: string; retryIn?: number }
  /** The connection dropped while in a room (`err.lost`): where the player was decides the wording. */
  | { kind: 'lost'; code: string; where: 'lobby' | 'race' | 'results' }
  /** The room emptied while the player was away (`err.closed`). */
  | { kind: 'closed'; code: string };

export interface OnlineHubDeps {
  playerName: () => string;
  onQuick(): void;
  onCreate(): void;
  onJoin(code: string): void;
  onEnterLobby(): void;
  onCancel(): void;
  onRetry(): void;
  onOffline(): void;
  onReload(): void;
  onBack(): void;
  onEditName(): void;
}

interface Action {
  label: string;
  key: string;
  hotkey: string;
  run: () => void;
  back?: boolean;
}

export class OnlineHubScreen implements Screen {
  readonly el = document.createElement('section');
  private readonly input: HTMLInputElement;
  private readonly panel: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly joinBtn: HTMLButtonElement;
  private readonly disposeNav: () => void;
  private timer: number | null = null;
  private state: HubState = { kind: 'idle' };

  constructor(
    root: HTMLElement,
    private readonly deps: OnlineHubDeps,
  ) {
    this.el.className = 'mn mn-online';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', str('hub.title'));
    this.el.innerHTML = `
      <div class="ol-page">
        <img class="ol-bgimg" src="${trackPreview('monte_carlo')}" alt="" aria-hidden="true" />
        <header class="ol-head">
          <button type="button" class="ol-back" data-back data-hotkey="esc" aria-label="Back"><span aria-hidden="true">←</span></button>
          <h2>${esc(str('hub.title'))}</h2>
          <div class="ol-as">as <b class="ol-name"></b><button type="button" class="ol-editname" data-act="name" data-hotkey="n" data-sfx="screen_transition">${esc(str('hub.editName'))} ${kc('N')}</button></div>
        </header>
        <div class="ol-hub">
          <div class="ol-hub-left">
            <button type="button" class="ol-big primary" data-act="quick" data-hotkey="q" data-autofocus data-sfx="screen_transition">
              <span class="lbl2"><span>${esc(str('hub.quick'))}</span><small>${esc(str('hub.quick.sub'))}</small></span>${kc('Q', true)}
            </button>
            <button type="button" class="ol-big" data-act="create" data-hotkey="c" data-sfx="screen_transition">
              <span class="lbl2"><span>${esc(str('hub.create'))}</span><small>${esc(str('hub.create.sub'))}</small></span>${kc('C')}
            </button>
            <div class="ol-join">
              <div class="mn-eyebrow">${esc(str('hub.join').toUpperCase())}</div>
              <div class="ol-join-row">
                <input class="ol-code mn-mono" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="······" aria-label="Room code, ${ROOM_CODE_LENGTH} characters" />
                <button type="button" class="ol-joinbtn" data-act="join" data-sfx="none">${esc(str('hub.join.button'))}</button>
              </div>
              <div class="ol-hint"></div>
              <div class="ol-key">${kc('J')} jump to the code box</div>
            </div>
          </div>
          <div class="ol-hub-right">
            <div class="ol-how"></div>
            <div class="ol-state" role="status" aria-live="polite" hidden></div>
          </div>
        </div>
        ${keyBar(
          [
            { keys: ['Q'], label: 'Quick match' },
            { keys: ['C'], label: 'Create room' },
            { keys: ['J'], label: 'Join with code' },
            { keys: ['Esc'], label: 'Back' },
          ],
          'Gamepad · D-pad navigate · A select · B back',
        )}
      </div>`;
    root.appendChild(this.el);
    this.input = this.el.querySelector('.ol-code') as HTMLInputElement;
    this.panel = this.el.querySelector('.ol-state') as HTMLElement;
    this.hint = this.el.querySelector('.ol-hint') as HTMLElement;
    this.joinBtn = this.el.querySelector('[data-act="join"]') as HTMLButtonElement;
    this.el.querySelector('.ol-how')!.innerHTML = `
      <div class="mn-eyebrow">HOW IT WORKS</div>
      <p><b>1</b> Quick match, or create a room and share the code.</p>
      <p><b>2</b> Pick your car, press READY. The host picks track and laps.</p>
      <p><b>3</b> Up to ${ONLINE.maxPlayers} racers. Rivals carry <span class="pink">pink</span> name tags when close.</p>`;

    (this.el.querySelector('[data-act="quick"]') as HTMLElement).addEventListener('click', () => deps.onQuick());
    (this.el.querySelector('[data-act="create"]') as HTMLElement).addEventListener('click', () => deps.onCreate());
    (this.el.querySelector('[data-back]') as HTMLElement).addEventListener('click', () => deps.onBack());
    (this.el.querySelector('[data-act="name"]') as HTMLElement).addEventListener('click', () => deps.onEditName());
    this.joinBtn.addEventListener('click', () => this.submit());
    this.input.addEventListener('input', () => {
      const v = cleanRoomCode(this.input.value);
      if (v !== this.input.value) this.input.value = v;
      this.paintJoin();
    });
    this.disposeNav = enableMenuNav(this.el, {
      onKey: (token) => {
        if (document.activeElement === this.input) {
          if (token === 'enter') {
            this.submit();
            return true;
          }
          return false;
        }
        if (token === 'n' && (this.state.kind === 'idle' || this.state.kind === 'error')) {
          deps.onEditName();
          return true;
        }
        if (token === 'j') {
          this.focusCode();
          return true;
        }
        const a = this.actions().find((x) => x.hotkey.split(' ').includes(token));
        if (a) {
          a.run();
          return true;
        }
        return false;
      },
    });
    this.paintJoin();
  }

  private submit(): void {
    const v = this.input.value;
    if (v.length < ROOM_CODE_LENGTH) {
      this.hint.textContent = str('hub.join.short');
      this.hint.classList.add('bad');
      uiAudio.play('blocked');
      return;
    }
    this.deps.onJoin(v);
  }

  private paintJoin(): void {
    const n = this.input.value.length;
    this.hint.classList.remove('bad');
    this.hint.textContent = n > 0 ? str('hub.join.count', { n }) : str('hub.join.hint');
    this.joinBtn.classList.toggle('ready', n === ROOM_CODE_LENGTH);
  }

  focusCode(): void {
    this.input.focus();
    this.input.select();
  }

  /** The actions the current state offers, with their keys (they double as the panel's buttons). */
  private actions(): Action[] {
    const d = this.deps;
    const s = this.state;
    if (s.kind === 'search')
      return [{ label: str('search.cancel'), key: 'Esc', hotkey: 'esc', run: d.onCancel, back: true }];
    if (s.kind === 'found') return [{ label: str('found.enter'), key: 'Enter', hotkey: 'enter', run: d.onEnterLobby }];
    if (s.kind === 'lost')
      return [
        { label: str('err.lost.back'), key: 'Enter', hotkey: 'enter', run: () => this.setState({ kind: 'idle' }) },
        { label: str('err.lost.offline'), key: 'O', hotkey: 'o', run: d.onOffline },
      ];
    if (s.kind === 'closed')
      return [
        { label: 'Create room', key: 'C', hotkey: 'c', run: d.onCreate },
        { label: 'Quick match', key: 'Q', hotkey: 'q', run: d.onQuick },
      ];
    if (s.kind === 'error') {
      switch (s.err) {
        case 'started':
          return [
            { label: 'Quick match', key: 'Q', hotkey: 'q', run: d.onQuick },
            { label: 'Try another code', key: 'J', hotkey: 'j', run: () => this.focusCode() },
          ];
        case 'full':
          return [
            { label: 'Quick match', key: 'Q', hotkey: 'q', run: d.onQuick },
            { label: 'Try another code', key: 'J', hotkey: 'j', run: () => this.focusCode() },
          ];
        case 'version':
        case 'data':
          return [
            { label: 'Reload', key: 'R', hotkey: 'r', run: d.onReload },
            { label: 'Back', key: 'Esc', hotkey: 'esc', run: () => this.setState({ kind: 'idle' }), back: true },
          ];
        case 'down':
          return [
            { label: 'Retry now', key: 'R', hotkey: 'r', run: d.onRetry },
            { label: 'Play offline', key: 'O', hotkey: 'o', run: d.onOffline },
          ];
        case 'notfound':
          return [{ label: 'Try again', key: 'J', hotkey: 'j', run: () => this.focusCode() }];
        case 'empty':
          return [
            { label: 'Create room', key: 'C', hotkey: 'c', run: d.onCreate },
            { label: 'Keep searching', key: 'Q', hotkey: 'q', run: d.onQuick },
          ];
      }
    }
    return [
      { label: 'Quick match', key: 'Q', hotkey: 'q', run: d.onQuick },
      { label: 'Create room', key: 'C', hotkey: 'c', run: d.onCreate },
    ];
  }

  setState(s: HubState): void {
    this.state = s;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const how = this.el.querySelector('.ol-how') as HTMLElement;
    if (s.kind === 'idle') {
      this.panel.hidden = true;
      how.hidden = false;
      return;
    }
    how.hidden = true;
    this.panel.hidden = false;
    const tone =
      s.kind === 'found'
        ? 'ok'
        : s.kind === 'search'
          ? 'wait'
          : s.kind === 'lost'
            ? 'bad'
            : s.kind === 'error' && (s.err === 'full' || s.err === 'down')
              ? 'bad'
              : 'warn';
    this.panel.dataset.tone = tone;
    const { title, msg } = this.words(s);
    const mark =
      s.kind === 'search'
        ? '<span class="ol-spin" aria-hidden="true"></span>'
        : s.kind === 'found'
          ? icon('ready', 40)
          : `<span class="ol-mark ${tone}" aria-hidden="true">${tone === 'bad' ? '!' : '?'}</span>`;
    const acts = this.actions();
    this.panel.innerHTML = `
      <div class="ol-state-head">${mark}<div class="ol-state-title">${title}</div></div>
      <div class="ol-state-msg">${msg}</div>
      ${s.kind === 'search' ? `<div class="ol-elapsed mn-mono">0:00</div><div class="ol-wait-note">${esc(str('search.wait'))}</div>` : ''}
      <div class="ol-state-acts">${acts
        .map(
          (a, i) =>
            `<button type="button" class="ol-act${i === 0 && !a.back ? ' primary' : ''}" data-i="${i}"${a.back ? ' data-back' : ''}>${esc(a.label)} ${kc(a.key, i === 0 && !a.back)}</button>`,
        )
        .join('')}</div>`;
    this.panel
      .querySelectorAll<HTMLElement>('.ol-act')
      .forEach((b) => b.addEventListener('click', () => acts[Number(b.dataset.i)].run()));
    if (s.kind === 'search') {
      const el = this.panel.querySelector('.ol-elapsed') as HTMLElement;
      this.timer = window.setInterval(() => {
        const t = Math.floor((performance.now() - s.startedAt) / 1000);
        el.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      }, 500);
    }
    (this.panel.querySelector('.ol-act') as HTMLElement | null)?.focus();
  }

  private words(s: Exclude<HubState, { kind: 'idle' }>): { title: string; msg: string } {
    if (s.kind === 'search') return { title: str('search.title'), msg: str('search.msg') };
    if (s.kind === 'found') {
      return {
        title: str('found.title', { code: formatRoomCode(s.code) }),
        msg: `${s.racers} racer${s.racers === 1 ? '' : 's'} waiting · ${esc(s.trackName)} · ${s.laps} lap${s.laps === 1 ? '' : 's'}`,
      };
    }
    if (s.kind === 'lost') {
      return {
        title: str('err.lost.title'),
        msg: str('err.lost.msg', { code: formatRoomCode(s.code), where: str(`err.lost.where.${s.where}`) }),
      };
    }
    if (s.kind === 'closed') {
      return { title: str('err.closed.title'), msg: str('err.closed.msg', { code: formatRoomCode(s.code) }) };
    }
    const code = s.code ? formatRoomCode(s.code) : '';
    switch (s.err) {
      case 'started':
        return { title: str('err.started.title'), msg: str('err.started.msg', { code }) };
      case 'full':
        return { title: str('err.full.title'), msg: str('err.full.msg', { code }) };
      case 'version':
        return {
          title: str('err.version.title'),
          msg: str('err.version.msg', { roomVersion: s.roomV ?? '?', myVersion: s.myV ?? '?' }),
        };
      case 'data':
        return { title: str('err.data.title'), msg: str('err.data.msg') };
      case 'down':
        return { title: str('err.down.title'), msg: str('err.down.msg', { s: s.retryIn ?? 5 }) };
      case 'notfound':
        return { title: str('err.notfound.title'), msg: str('err.notfound.msg') };
      case 'empty':
        return { title: str('err.empty.title'), msg: str('err.empty.msg') };
    }
  }

  show(): void {
    this.el.hidden = false;
    (this.el.querySelector('.ol-name') as HTMLElement).textContent = this.deps.playerName();
    this.paintJoin();
    focusFirst(this.el);
  }

  hide(): void {
    this.el.hidden = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.hide();
    this.disposeNav();
    this.el.remove();
  }
}
