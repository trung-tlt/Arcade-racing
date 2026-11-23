import { hasChord, hotkeyMatches, normalizeKey } from './hotkeys';
import { type UiEvent, uiAudio } from './uiAudio';
import './screens/keys.css';

/**
 * ONE input system for every menu screen (keyboard + gamepad).
 *
 * A single global key listener (capture phase) and a single gamepad poll serve every registered screen, and only the
 * topmost VISIBLE screen reacts — so keys never leak between screens, a key that opens another screen is not handled
 * twice, and nothing reaches the in-race `Input` while a menu is open (handled keys are stopped).
 *
 * Built in: arrows / D-pad / stick move focus, Escape (and Backspace) click `[data-back]`, any element with
 * `data-hotkey="enter r"` is clicked by those keys, Enter/Space activate a focused button natively.
 *
 * Sound: every activation ends in a click, so ONE capture-phase click listener plays the menu sound — `back` for
 * `[data-back]` / Esc buttons, `confirm` otherwise, or whatever `data-sfx="<event>"` says (`none` = the screen plays
 * its own sound). Focus moves play `focus_move`; M (when no screen claims it) toggles the menu music.
 */
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [data-nav]:not([disabled])';
const STICK = 0.6;

export type PadButton = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'start';

export interface NavOptions {
  /** Left/Right (and D-pad left/right) move focus like Up/Down. Default true. */
  horizontal?: boolean;
  /** Arrow keys move focus only between elements matching this selector (default: everything focusable). */
  moveSelector?: string;
  /** Backspace acts as Back. Default true. */
  backspaceBack?: boolean;
  /** Screen-specific keys, before the built-ins. Return true to consume the key. `token` is a normalised key. */
  onKey?: (token: string, e: KeyboardEvent) => boolean;
  /** Screen-specific gamepad buttons, before the built-ins. Return true to consume. */
  onPad?: (button: PadButton) => boolean;
}

interface Instance {
  root: HTMLElement;
  opts: NavOptions;
  lastFocus: HTMLElement | null;
  onFocusIn: (e: FocusEvent) => void;
}

/** True when the element is rendered (offsetParent is null for position:fixed overlays, so don't use it). */
const isRendered = (e: HTMLElement): boolean => !e.hidden && e.getClientRects().length > 0;

const instances: Instance[] = [];
let listening = false;
let raf = 0;
const padPrev: Record<PadButton, boolean> = {
  up: false,
  down: false,
  left: false,
  right: false,
  a: false,
  b: false,
  x: false,
  y: false,
  lb: false,
  rb: false,
  start: false,
};

const focusables = (inst: Instance): HTMLElement[] =>
  Array.from(inst.root.querySelectorAll<HTMLElement>(inst.opts.moveSelector ?? FOCUSABLE)).filter(isRendered);

/** The topmost visible screen (the last one registered wins when several are rendered). */
function top(): Instance | null {
  for (let i = instances.length - 1; i >= 0; i--) if (isRendered(instances[i].root)) return instances[i];
  return null;
}

function move(inst: Instance, dir: 1 | -1): void {
  const list = focusables(inst);
  if (!list.length) return;
  const ae = document.activeElement as HTMLElement | null;
  let i = ae ? list.findIndex((el) => el === ae || el.contains(ae)) : -1;
  if (i < 0) i = dir === 1 ? -1 : 0;
  list[(i + dir + list.length) % list.length].focus();
  if (list.length > 1) uiAudio.play('focus_move');
}

/** Selection must never be lost: if focus fell out of the screen, put it back on the last item (or the first). */
function ensureFocus(inst: Instance): void {
  const ae = document.activeElement as HTMLElement | null;
  if (ae && inst.root.contains(ae) && isRendered(ae)) return;
  const target =
    inst.lastFocus && inst.root.contains(inst.lastFocus) && isRendered(inst.lastFocus)
      ? inst.lastFocus
      : (inst.root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(inst)[0]);
  target?.focus();
}

function back(inst: Instance): boolean {
  const el = inst.root.querySelector<HTMLElement>('[data-back]');
  el?.click();
  return !!el;
}

function activate(inst: Instance): void {
  const ae = document.activeElement as HTMLElement | null;
  if (ae && inst.root.contains(ae) && ae.matches('a,button,input')) ae.click();
  else inst.root.querySelector<HTMLElement>('[data-hotkey~="enter"]')?.click();
}

/** Keys a focused text field still lets the menu handle: Enter submits, Esc leaves, up/down move focus. */
const TEXT_FIELD_PASS = new Set(['enter', 'escape', 'arrowup', 'arrowdown']);

function onKeyDown(e: KeyboardEvent): void {
  const inst = top();
  if (!inst || hasChord(e)) return;
  const token = normalizeKey(e);
  const ae = document.activeElement as HTMLElement | null;
  const stop = (): void => {
    e.preventDefault();
    e.stopPropagation();
  };

  ensureFocus(inst);
  // Auto-repeat only makes sense for the arrows; anything else would double-fire (and a held Enter / Space / P
  // must never re-activate whatever got focus after the screen changed).
  if (e.repeat && !token.startsWith('arrow')) return stop();

  // Typing in a text field (the room code): letters, Backspace and the caret keys belong to the field.
  if (ae && inst.root.contains(ae) && ae.matches('input[type="text"]') && !TEXT_FIELD_PASS.has(token)) return;
  if (inst.opts.onKey?.(token, e)) return stop();

  const onActivator = !!ae && inst.root.contains(ae) && ae.matches('a,button');
  if ((token === 'enter' || token === 'space') && onActivator) {
    return; // native activation on the focused button
  }

  if (token === 'arrowup' || token === 'arrowdown') {
    stop();
    return move(inst, token === 'arrowdown' ? 1 : -1);
  }
  if (token === 'arrowleft' || token === 'arrowright') {
    if (inst.opts.horizontal === false) return;
    if ((ae as HTMLInputElement | null)?.type === 'range') return; // native slider step
    stop();
    return move(inst, token === 'arrowright' ? 1 : -1);
  }
  if (token === 'escape' || (token === 'backspace' && inst.opts.backspaceBack !== false)) {
    stop();
    if (!back(inst) && token === 'escape') inst.root.querySelector<HTMLElement>('[data-hotkey~="esc"]')?.click();
    return;
  }
  if (token === 'backspace') return stop(); // handled by the screen (e.g. reset) or ignored — never browser-back

  const hit = Array.from(inst.root.querySelectorAll<HTMLElement>('[data-hotkey]')).find(
    (el) => isRendered(el) && !el.hasAttribute('disabled') && hotkeyMatches(el.getAttribute('data-hotkey'), token),
  );
  if (hit) {
    stop();
    hit.click();
  } else if (token === 'm') {
    stop();
    uiAudio.toggleMusicMute();
  }
}

/** The sound for an activated control: its data-sfx, else `back` for back/Esc buttons, else `confirm`. */
export function sfxFor(el: HTMLElement): UiEvent | 'none' {
  const explicit = el.getAttribute('data-sfx');
  if (explicit) return explicit as UiEvent | 'none';
  return el.hasAttribute('data-back') || hotkeyMatches(el.getAttribute('data-hotkey'), 'escape') ? 'back' : 'confirm';
}

function onClickCapture(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  const el = target?.closest<HTMLElement>('button, a[href]');
  if (!el) return;
  const inst = instances.find((i) => i.root.contains(el) && isRendered(i.root));
  if (!inst) return;
  const sfx = sfxFor(el);
  if (sfx !== 'none') uiAudio.play(sfx);
}

function pollPad(): void {
  raf = requestAnimationFrame(pollPad);
  const inst = top();
  const pad = navigator.getGamepads?.().find((p) => p && p.connected);
  if (!pad) return;
  const b = pad.buttons;
  if (b.some((x) => x.pressed)) uiAudio.unlock(); // a gamepad press is an input too
  const now: Record<PadButton, boolean> = {
    up: !!b[12]?.pressed || pad.axes[1] < -STICK,
    down: !!b[13]?.pressed || pad.axes[1] > STICK,
    left: !!b[14]?.pressed || pad.axes[0] < -STICK,
    right: !!b[15]?.pressed || pad.axes[0] > STICK,
    a: !!b[0]?.pressed,
    b: !!b[1]?.pressed,
    x: !!b[2]?.pressed,
    y: !!b[3]?.pressed,
    lb: !!b[4]?.pressed,
    rb: !!b[5]?.pressed,
    start: !!b[9]?.pressed,
  };
  for (const k of Object.keys(now) as PadButton[]) {
    const pressed = now[k] && !padPrev[k];
    padPrev[k] = now[k];
    if (!pressed || !inst) continue;
    ensureFocus(inst);
    if (inst.opts.onPad?.(k)) continue;
    if (k === 'up') move(inst, -1);
    else if (k === 'down') move(inst, 1);
    else if (k === 'left' && inst.opts.horizontal !== false) move(inst, -1);
    else if (k === 'right' && inst.opts.horizontal !== false) move(inst, 1);
    else if (k === 'a') activate(inst);
    else if (k === 'b') back(inst);
  }
}

function startListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onClickCapture, true);
  raf = requestAnimationFrame(pollPad);
}

function stopListening(): void {
  if (!listening || instances.length > 0) return;
  listening = false;
  window.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('click', onClickCapture, true);
  cancelAnimationFrame(raf);
}

/** Register a screen. Returns the disposer. */
export function enableMenuNav(root: HTMLElement, opts: NavOptions = {}): () => void {
  const inst: Instance = {
    root,
    opts,
    lastFocus: null,
    onFocusIn: (e) => {
      inst.lastFocus = e.target as HTMLElement;
    },
  };
  root.addEventListener('focusin', inst.onFocusIn);
  instances.push(inst);
  startListening();
  return () => {
    root.removeEventListener('focusin', inst.onFocusIn);
    const i = instances.indexOf(inst);
    if (i >= 0) instances.splice(i, 1);
    stopListening();
  };
}

/** Focus the item marked [data-autofocus] (or the first focusable) of a screen that was just shown. */
export function focusFirst(root: HTMLElement): void {
  const list = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isRendered);
  (root.querySelector<HTMLElement>('[data-autofocus]') ?? list[0])?.focus();
}
