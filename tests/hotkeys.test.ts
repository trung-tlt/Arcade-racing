import { describe, expect, it } from 'vitest';
import {
  clampStep,
  digitIndex,
  hasChord,
  hotkeyMatches,
  keyBar,
  kc,
  normalizeKey,
  normalizeToken,
  stepValue,
  wrapStep,
} from '../src/ui/hotkeys';

describe('key normalisation', () => {
  it('lower-cases keys and names space / escape', () => {
    expect(normalizeKey({ key: 'Enter' })).toBe('enter');
    expect(normalizeKey({ key: ' ' })).toBe('space');
    expect(normalizeKey({ key: 'Escape' })).toBe('escape');
    expect(normalizeKey({ key: 'R' })).toBe('r');
    expect(normalizeKey({ key: 'ArrowLeft' })).toBe('arrowleft');
    expect(normalizeKey({ key: 'Unidentified', code: 'KeyP' })).toBe('keyp');
  });
  it('treats esc as an alias of escape in data-hotkey attributes', () => {
    expect(normalizeToken('Esc')).toBe('escape');
    expect(hotkeyMatches('esc p', 'escape')).toBe(true);
    expect(hotkeyMatches('esc p', 'p')).toBe(true);
    expect(hotkeyMatches('enter r', 'q')).toBe(false);
    expect(hotkeyMatches(null, 'q')).toBe(false);
  });
});

describe('chords and steps', () => {
  it('ignores ctrl / meta / alt chords', () => {
    expect(hasChord({ ctrlKey: true })).toBe(true);
    expect(hasChord({ metaKey: true })).toBe(true);
    expect(hasChord({ altKey: true })).toBe(true);
    expect(hasChord({ shiftKey: true } as never)).toBe(false);
  });
  it('maps 1–9 and 0 to a vehicle index only when it exists', () => {
    expect(digitIndex('1', 9)).toBe(0);
    expect(digitIndex('9', 9)).toBe(8);
    expect(digitIndex('9', 3)).toBeNull();
    expect(digitIndex('0', 9)).toBeNull(); // no tenth vehicle
    expect(digitIndex('0', 10)).toBe(9);
    expect(digitIndex('a', 9)).toBeNull();
  });
  it('wraps and clamps', () => {
    expect(wrapStep(8, 1, 9)).toBe(0);
    expect(wrapStep(0, -1, 9)).toBe(8);
    expect(clampStep(2, 1, 3)).toBe(2);
    expect(clampStep(0, -1, 3)).toBe(0);
    expect(stepValue(100, 1, 5, 50, 100)).toBe(100);
    expect(stepValue(50, -1, 5, 50, 100)).toBe(50);
    expect(stepValue(80, 1, 10, 0, 100)).toBe(90);
  });
});

describe('markup', () => {
  it('escapes labels and builds a key bar with the pad text', () => {
    expect(kc('<b>')).toContain('&lt;b&gt;');
    const bar = keyBar([{ keys: ['Enter'], label: 'Start' }], 'Gamepad · A');
    expect(bar).toContain('mn-keybar');
    expect(bar).toContain('Start');
    expect(bar).toContain('Gamepad · A');
  });
});
