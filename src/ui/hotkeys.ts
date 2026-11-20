/**
 * Pure helpers for the keyboard-first menus: key normalisation, hotkey lookup and keycap / key-bar markup.
 * Nothing here touches the DOM, so it is unit-testable in node.
 */

const ALIASES: Record<string, string> = { esc: 'escape', ' ': 'space', spacebar: 'space', del: 'delete' };

/** Token for a key event: lower-case `key` ('enter', 'escape', 'space', 'backspace', 'arrowup', 'r', '1'). */
export function normalizeKey(e: { key: string; code?: string }): string {
  let k = e.key.toLowerCase();
  if (k === 'unidentified' && e.code) k = e.code.toLowerCase();
  // Numpad digits report their digit as `key` already; Numpad Enter reports 'Enter'.
  return ALIASES[k] ?? k;
}

/** Normalises one token from a `data-hotkey` attribute ('esc' → 'escape'). */
export function normalizeToken(t: string): string {
  const k = t.trim().toLowerCase();
  return ALIASES[k] ?? k;
}

/** True when `attr` (space-separated tokens, e.g. "enter r") contains the pressed key token. */
export function hotkeyMatches(attr: string | null | undefined, token: string): boolean {
  if (!attr) return false;
  return attr.split(/\s+/).some((t) => t !== '' && normalizeToken(t) === token);
}

/** Ctrl/Meta/Alt chords belong to the browser, never to the menus. */
export function hasChord(e: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  return !!(e.ctrlKey || e.metaKey || e.altKey);
}

/** Digit 1–9 → zero-based index 0–8, 0 → the tenth (index 9) and `-` → the eleventh (index 10); null when no such vehicle. */
export function digitIndex(token: string, max: number): number | null {
  if (!/^[0-9-]$/.test(token)) return null;
  const i = token === '-' ? 10 : token === '0' ? 9 : Number(token) - 1;
  return i < max ? i : null;
}

/** Wrap-around step of an index in [0, n). */
export function wrapStep(i: number, dir: 1 | -1, n: number): number {
  return n <= 0 ? 0 : (((i + dir) % n) + n) % n;
}

/** Clamp-step of an index in [0, n). */
export function clampStep(i: number, dir: 1 | -1, n: number): number {
  return Math.max(0, Math.min(n - 1, i + dir));
}

/** Nearest allowed value when stepping a slider by `step` within [min, max]. */
export function stepValue(v: number, dir: 1 | -1, step: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round((v + dir * step) / step) * step));
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** One keycap. `dark` is for keycaps on the orange primary button. */
export function kc(label: string, dark = false): string {
  return `<span class="kc${dark ? ' kc-dark' : ''}">${esc(label)}</span>`;
}

export function keyChips(labels: readonly string[], dark = false): string {
  return `<span class="kc-row">${labels.map((l) => kc(l, dark)).join('')}</span>`;
}

export interface KeyBarItem {
  keys: readonly string[];
  label: string;
}

/** Bottom key bar: keys on the left, the matching gamepad buttons on the right. */
export function keyBar(items: readonly KeyBarItem[], pad: string): string {
  const left = items
    .map((it) => `<span class="kb-item">${it.keys.map((k) => kc(k)).join('')}<span>${esc(it.label)}</span></span>`)
    .join('');
  return `<div class="mn-keybar" role="note" aria-label="Keyboard shortcuts"><div class="kb-keys">${left}</div><div class="kb-pad">${esc(pad)}</div></div>`;
}

/** Button label with keycaps on the right: `<span>label</span>` + chips. */
export function labelWithKeys(label: string, keys: readonly string[], dark = false, sub?: string): string {
  const sublabel = sub ? `<small>${esc(sub)}</small>` : '';
  return `<span class="lbl2"><span>${esc(label)}</span>${sublabel}</span>${keyChips(keys, dark)}`;
}
