import { describe, expect, it } from 'vitest';
import { UI_SOUNDS } from '../src/core/Data';
import {
  DUCK_LEVEL,
  THROTTLE_MS,
  type UiEvent,
  clipGain,
  eventDef,
  musicBusVolume,
  musicFadeTarget,
  parseThen,
  pitchFor,
  throttleOk,
  uiBusVolume,
} from '../src/ui/uiAudio';
import { existsSync } from 'node:fs';

describe('ui_sounds.json', () => {
  it('has a file on disk for every event and for the music loop (+ wav fallback)', () => {
    for (const [name, def] of Object.entries(UI_SOUNDS.events)) {
      expect(existsSync(`public/assets/${def.file}`), `${name}: ${def.file}`).toBe(true);
    }
    expect(existsSync(`public/assets/${UI_SOUNDS.music.menu.file}`)).toBe(true);
    expect(existsSync(`public/assets/${UI_SOUNDS.music.menu.fallback}`)).toBe(true);
  });
  it('every event the screens play exists', () => {
    const used: UiEvent[] = [
      'focus_move',
      'confirm',
      'back',
      'blocked',
      'toggle_on',
      'toggle_off',
      'slider_step',
      'screen_transition',
      'vehicle_switch',
      'vehicle_confirm',
      'track_switch',
      'start_race',
      'title_enter',
    ];
    for (const e of used) expect(eventDef(e), e).not.toBeNull();
    expect(eventDef('nope')).toBeNull();
  });
});

describe('pitch', () => {
  const def = eventDef('vehicle_switch')!;
  it('is the vehicle pitch with no jitter when rnd = 0.5', () => {
    expect(pitchFor(def, 'car', () => 0.5)).toBeCloseTo(1);
    expect(pitchFor(def, 'apc8x8', () => 0.5)).toBeCloseTo(0.8);
    expect(pitchFor(def, 'bike', () => 0.5)).toBeCloseTo(1.3);
  });
  it('stays inside ±pitchJitter', () => {
    const move = eventDef('focus_move')!;
    const j = move.pitchJitter as number;
    expect(pitchFor(move, undefined, () => 0)).toBeCloseTo(1 - j);
    expect(pitchFor(move, undefined, () => 1)).toBeCloseTo(1 + j);
    for (let i = 0; i < 50; i++) {
      const p = pitchFor(move);
      expect(p).toBeGreaterThanOrEqual(1 - j - 1e-9);
      expect(p).toBeLessThanOrEqual(1 + j + 1e-9);
    }
  });
  it('ignores the vehicle for events without per-vehicle pitch', () => {
    expect(pitchFor(eventDef('confirm')!, 'bike', () => 0.5)).toBeCloseTo(1);
  });
});

describe('volumes', () => {
  it('UI bus = master × effects, music bus = master × music × loop level, all clamped', () => {
    expect(uiBusVolume(0.8, 0.5)).toBeCloseTo(0.4);
    expect(uiBusVolume(2, 2)).toBe(1);
    expect(uiBusVolume(-1, 1)).toBe(0);
    expect(musicBusVolume(0.5, 0.5, 0.35)).toBeCloseTo(0.0875);
    expect(musicBusVolume(1, 0, 0.35)).toBe(0);
    expect(clipGain(eventDef('start_race')!)).toBeCloseTo(0.8);
  });
  it('music fader: off when unwanted or muted, 40% ducked, else full', () => {
    expect(musicFadeTarget(false, false, false)).toBe(0);
    expect(musicFadeTarget(true, true, false)).toBe(0);
    expect(musicFadeTarget(true, false, true)).toBe(DUCK_LEVEL);
    expect(musicFadeTarget(true, false, false)).toBe(1);
    expect(DUCK_LEVEL).toBe(0.4);
  });
});

describe('throttle', () => {
  it('limits chatty events and never limits the rest', () => {
    const gap = THROTTLE_MS.focus_move as number;
    expect(throttleOk('focus_move', undefined, 1000)).toBe(true);
    expect(throttleOk('focus_move', 1000, 1000 + gap - 1)).toBe(false);
    expect(throttleOk('focus_move', 1000, 1000 + gap)).toBe(true);
    expect(throttleOk('confirm', 1000, 1001)).toBe(true);
  });
});

describe('then actions from the data file', () => {
  it('title_enter starts the menu music, start_race fades it out over 1.2 s', () => {
    expect(parseThen(eventDef('title_enter')!.then)).toEqual({ startMusic: true, fadeOutSec: null });
    expect(parseThen(eventDef('start_race')!.then)).toEqual({ startMusic: false, fadeOutSec: 1.2 });
    expect(parseThen(undefined)).toEqual({ startMusic: false, fadeOutSec: null });
  });
});
