import online from '../../data/online_ui.json';

/** Racer-name rules from `data/online_ui.json -> name`. Pure: no DOM, so the node tests cover them. */
const RULES = online.name;
export const NAME_MAX = RULES.maxLength;
export const NAME_INPUT_MAX = RULES.inputMaxLength;
const ALLOWED = new RegExp(RULES.allowed);

export type NameCheck =
  | { kind: 'empty' }
  | { kind: 'tooLong'; n: number }
  | { kind: 'accents'; chars: string[]; fixed: string }
  | { kind: 'badChars'; chars: string[] }
  | { kind: 'ok'; name: string };

/** NFD-normalise, drop the combining marks and map the stroked d (the button "Remove accents"). */
export function removeAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFC');
}

const unique = (chars: string[]): string[] => [...new Set(chars)];

/** Why a typed name can or cannot be saved. Spaces at both ends are ignored (they are trimmed on save). */
export function checkName(raw: string): NameCheck {
  const name = raw.trim();
  if (name.length === 0) return { kind: 'empty' };
  const bad = unique([...name].filter((c) => !ALLOWED.test(c)));
  if (bad.length > 0) {
    // Letters that only fail because of an accent get the "Remove accents" fix; anything else is just not allowed.
    const fixed = removeAccents(name);
    if (fixed !== name && ALLOWED.test(fixed) && fixed.length > 0) return { kind: 'accents', chars: bad, fixed };
    return { kind: 'badChars', chars: bad.filter((c) => removeAccents(c) === c || !ALLOWED.test(removeAccents(c))) };
  }
  if (name.length > NAME_MAX) return { kind: 'tooLong', n: name.length };
  return { kind: 'ok', name };
}

/** What the name tag shows: capitals, the first `tagCut` characters. */
export const tagText = (name: string): string => name.trim().toUpperCase().slice(0, RULES.tagCut);

/** `{word1}{word2}-{10..99}` for "Suggest another". `rnd` is injectable for tests. */
export function suggestName(rnd: () => number = Math.random): string {
  const [a, b] = RULES.suggestWords;
  const pick = (w: string[]): string => w[Math.floor(rnd() * w.length) % w.length];
  return `${pick(a)}${pick(b)}-${10 + Math.floor(rnd() * 90)}`;
}
