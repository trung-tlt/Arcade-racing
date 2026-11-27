import { uiAudio } from '../uiAudio';
import { keyBar, kc } from '../hotkeys';
import { enableMenuNav, focusFirst } from '../nav';
import {
  NAME_INPUT_MAX,
  NAME_MAX,
  checkName,
  removeAccents,
  suggestName,
  tagText,
  type NameCheck,
} from '../onlineName';
import type { Screen } from '../types';
import { ONLINE, esc, icon, str, trackPreview } from './onlineCommon';
import './online.css';
import './onlineMobile.css';

export interface OnlineNameDeps {
  /** The pre-filled name: the server-style `RACER-###`, or the saved one when editing. */
  suggestion(): string;
  onSave(name: string, first: boolean): void;
  /** Esc / Cancel when editing; Skip when it is the first time (the suggestion is kept). */
  onCancel(first: boolean): void;
}

/** Name entry (boards 49 and 52): the first ONLINE with no saved name, or Edit name in the hub. */
export class OnlineNameScreen implements Screen {
  readonly el = document.createElement('section');
  private readonly disposeNav: () => void;
  private first = true;
  private input!: HTMLInputElement;
  private saved = false;

  constructor(
    root: HTMLElement,
    private readonly deps: OnlineNameDeps,
  ) {
    this.el.className = 'mn mn-name';
    this.el.hidden = true;
    root.appendChild(this.el);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.disposeNav = enableMenuNav(this.el, {
      onKey: (token) => {
        if (document.activeElement === this.input) {
          if (token === 'enter') return (this.save(), true);
          return false;
        }
        if (token === 's') return (this.suggest(), true);
        return false;
      },
    });
  }

  /** Open for the first time (`first`) or to change the saved name. */
  open(first: boolean): void {
    this.first = first;
    this.saved = false;
    this.render();
    this.input.value = this.deps.suggestion();
    this.paint();
    this.input.focus();
    this.input.select();
  }

  private render(): void {
    const f = this.first;
    this.el.innerHTML = `
      <div class="ol-page">
        <img class="ol-bgimg" src="${trackPreview('monte_carlo')}" alt="" aria-hidden="true" />
        <header class="ol-head">
          <button type="button" class="ol-mback" data-act="cancel" aria-label="Back"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
          <div class="ol-title">
            <div class="mn-eyebrow">${esc(str(f ? 'name.step.first' : 'name.step.edit'))}</div>
            <h2>${esc(str(f ? 'name.title.first' : 'name.title.edit'))}</h2>
          </div>
        </header>
        <div class="ol-namebody">
          <div class="ol-namecard">
            <label class="mn-eyebrow" for="ol-name-in">${esc(str('name.label'))}</label>
            <div class="ol-inwrap"><input id="ol-name-in" class="ol-namein mn-mono" type="text" maxlength="${NAME_INPUT_MAX}" autocomplete="off" spellcheck="false" /><span class="ol-count mn-mono"></span></div>
            <div class="ol-namemsg" role="status" aria-live="polite"></div>
            <p class="ol-help">${esc(str('name.help'))}</p>
            <ul class="ol-rules">
              <li>${esc(str('name.rule.length'))}</li><li>${esc(str('name.rule.chars'))}</li><li>${esc(str('name.rule.accents'))}</li>
            </ul>
            <div class="ol-nameacts">
              <button type="button" class="ol-act primary" data-act="save" data-sfx="none">${esc(str(f ? 'name.continue' : 'name.save'))} ${kc('Enter', true)}</button>
              <button type="button" class="ol-act" data-act="suggest">${esc(str('name.suggest'))} ${kc('S')}</button>
              <button type="button" class="ol-act" data-act="fix" hidden>${esc(str('name.removeAccents'))}</button>
              <button type="button" class="ol-act" data-act="cancel" data-back data-hotkey="esc">${esc(f ? str('name.skip', { suggestion: this.deps.suggestion() }) : str('name.cancel'))} ${kc('Esc')}</button>
            </div>
            <p class="ol-note">${esc(str('name.changeLater'))}</p>
          </div>
          <div class="ol-namepreview" aria-hidden="true">
            <div class="mn-eyebrow">PREVIEW</div>
            <div class="ol-tagprev"><span class="ol-tagchip"><b></b></span></div>
            <p class="ol-note tagnote"></p>
            <p class="ol-savedmsg" hidden>${icon('ready', 16)}Saved on this device</p>
            <div class="ol-row you"><span class="n">1</span><span class="who"><i class="chip" style="background:${ONLINE.colors.own}"></i><b class="pname"></b><em class="badge">YOU</em></span></div>
            <p class="ol-note">${esc(str('name.sameName'))}</p>
          </div>
        </div>
        ${keyBar(
          [
            { keys: ['Enter'], label: 'Save' },
            { keys: ['S'], label: 'Suggest another' },
            { keys: ['Esc'], label: f ? 'Skip' : 'Cancel' },
          ],
          'Gamepad · D-pad navigate · A select · B back',
        )}
      </div>`;
    this.input = this.el.querySelector('.ol-namein') as HTMLInputElement;
    this.input.addEventListener('input', () => {
      this.saved = false;
      this.paint();
    });
  }

  private words(c: NameCheck): { text: string; tone: 'ok' | 'bad' | 'dim' } {
    switch (c.kind) {
      case 'empty':
        return { text: str('name.empty', { suggestion: this.deps.suggestion() }), tone: 'dim' };
      case 'tooLong':
        return { text: str('name.tooLong', { n: c.n }), tone: 'bad' };
      case 'accents':
        return { text: str('name.accents', { chars: c.chars.join(' ') }), tone: 'bad' };
      case 'badChars':
        return { text: str('name.badChars', { chars: c.chars.join(' ') }), tone: 'bad' };
      case 'ok':
        return { text: this.saved ? str('name.saved') : str('name.ok'), tone: 'ok' };
    }
  }

  private paint(): void {
    const c = checkName(this.input.value);
    const w = this.words(c);
    const msg = this.el.querySelector('.ol-namemsg') as HTMLElement;
    msg.className = `ol-namemsg ${w.tone}`;
    msg.innerHTML = `${w.tone === 'ok' ? icon('ready', 16) : ''}${w.text}`;
    this.input.classList.toggle('bad', w.tone === 'bad');
    const len = this.input.value.trim().length;
    const count = this.el.querySelector('.ol-count') as HTMLElement;
    count.textContent = `${len} / ${NAME_MAX}`;
    count.classList.toggle('bad', c.kind === 'tooLong');
    // One tick per rule, live: length, allowed characters, no accents.
    const rules = this.el.querySelectorAll('.ol-rules li');
    const okLen = c.kind !== 'empty' && c.kind !== 'tooLong';
    [okLen, c.kind !== 'badChars', c.kind !== 'accents'].forEach((ok, i) => {
      rules[i]?.classList.toggle('ok', ok);
      rules[i]?.classList.toggle('no', !ok);
    });
    (this.el.querySelector('.ol-savedmsg') as HTMLElement).hidden = !(this.saved && c.kind === 'ok');
    (this.el.querySelector('[data-act="fix"]') as HTMLElement).hidden = c.kind !== 'accents';
    (this.el.querySelector('[data-act="save"]') as HTMLElement).setAttribute('aria-disabled', String(c.kind !== 'ok'));
    const shown = c.kind === 'ok' ? c.name : c.kind === 'empty' ? this.deps.suggestion() : this.input.value.trim();
    (this.el.querySelector('.ol-tagchip b') as HTMLElement).textContent = tagText(shown);
    (this.el.querySelector('.pname') as HTMLElement).textContent = shown;
    (this.el.querySelector('.tagnote') as HTMLElement).textContent =
      shown.length > ONLINE.name.tagCut
        ? str('name.cutNote', { tag: tagText(shown) }).replace(/&amp;/g, '&')
        : str('name.capsNote');
  }

  private save(): void {
    const c = checkName(this.input.value);
    if (c.kind === 'empty') {
      this.input.value = this.deps.suggestion();
      this.paint();
      return;
    }
    if (c.kind !== 'ok') {
      uiAudio.play('blocked');
      return;
    }
    uiAudio.play('confirm');
    this.saved = true;
    this.deps.onSave(c.name, this.first);
  }

  private suggest(): void {
    this.input.value = suggestName();
    this.saved = false;
    this.paint();
    this.input.focus();
  }

  private onClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el) return;
    switch (el.dataset.act) {
      case 'save':
        return this.save();
      case 'suggest':
        return this.suggest();
      case 'fix':
        this.input.value = removeAccents(this.input.value.trim());
        this.paint();
        return this.input.focus();
      case 'cancel':
        return this.deps.onCancel(this.first);
    }
  }

  show(): void {
    this.el.hidden = false;
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
