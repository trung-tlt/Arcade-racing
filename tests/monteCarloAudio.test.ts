import { describe, expect, it } from 'vitest';
import { MONTE_CARLO, getTrack } from '../src/core/Data';
import {
  CHEER_RADIUS_M,
  CROWD_RADIUS_M,
  HORN_EVERY_SEC,
  crowdLevel,
  harbourLevel,
  nearStand,
  nextHornDelay,
  trackAudioFiles,
} from '../src/audio/MonteCarloAudio';
import { waterNormalTexture } from '../src/world/MonteCarlo';
import { trackMusic } from '../src/ui/uiAudio';

describe('Monte-Carlo audio zones', () => {
  it('the harbour bed plays on the main straight and sections F-H, not on the climb or in the tunnel', () => {
    expect(harbourLevel(MONTE_CARLO, 0.04)).toBeCloseTo(1, 1); // A: main straight
    expect(harbourLevel(MONTE_CARLO, 0.65)).toBe(1); // F
    expect(harbourLevel(MONTE_CARLO, 0.75)).toBe(1); // G
    expect(harbourLevel(MONTE_CARLO, 0.9)).toBe(1); // H
    expect(harbourLevel(MONTE_CARLO, 0.2)).toBe(0); // B: Beau Rivage climb
    expect(harbourLevel(MONTE_CARLO, 0.5)).toBe(0); // E: tunnel
    // The lap wraps: the start line is inside H and A.
    expect(harbourLevel(MONTE_CARLO, 0.999)).toBeGreaterThan(0.9);
    expect(harbourLevel(MONTE_CARLO, 1.01)).toBeGreaterThan(0.9);
  });

  it('fades smoothly at a section edge', () => {
    const edge = harbourLevel(MONTE_CARLO, 0.578);
    expect(edge).toBeGreaterThan(0.3);
    expect(edge).toBeLessThan(0.7);
    expect(harbourLevel(MONTE_CARLO, 0.5775)).toBeLessThan(edge);
  });

  it('the crowd fades with distance to the nearest grandstand', () => {
    const stands = [
      { x: 0, z: 0 },
      { x: 500, z: 0 },
    ];
    expect(crowdLevel(stands, 0, 0)).toBe(1);
    expect(crowdLevel(stands, CROWD_RADIUS_M / 2, 0)).toBeCloseTo(0.5);
    expect(crowdLevel(stands, CROWD_RADIUS_M + 1, 0)).toBe(0);
    expect(crowdLevel(stands, 480, 0)).toBeCloseTo(1 - 20 / CROWD_RADIUS_M);
    expect(crowdLevel([], 0, 0)).toBe(0);
  });

  it('a cheer needs a grandstand within 80 m', () => {
    const stands = [{ x: 10, z: 10 }];
    expect(nearStand(stands, 10 + CHEER_RADIUS_M - 1, 10, CHEER_RADIUS_M)).toBe(true);
    expect(nearStand(stands, 10 + CHEER_RADIUS_M + 1, 10, CHEER_RADIUS_M)).toBe(false);
  });

  it('yacht horns come every 25-60 s', () => {
    expect(nextHornDelay(0)).toBe(HORN_EVERY_SEC[0]);
    expect(nextHornDelay(0.999999)).toBeLessThanOrEqual(HORN_EVERY_SEC[1]);
    expect(nextHornDelay(0.5)).toBeCloseTo(42.5);
    expect(nextHornDelay(7)).toBe(HORN_EVERY_SEC[1]);
  });

  it('lists every sound the track JSON names so the bus loads them', () => {
    const files = trackAudioFiles(MONTE_CARLO);
    for (const f of [
      'sfx/monaco/harbour_ambience_loop.wav',
      'sfx/monaco/crowd_loop.wav',
      'sfx/monaco/crowd_cheer.wav',
      'sfx/monaco/yacht_horn.wav',
      'sfx/monaco/tunnel_ir.wav',
      'sfx/monaco/helicopter_loop.wav',
    ]) {
      expect(files).toContain(f);
    }
    expect(trackAudioFiles(getTrack('cat_lai'))).toEqual([]);
  });
});

describe('procedural water ripples', () => {
  it('make a unit-ish, upward-facing normal map', () => {
    const tex = waterNormalTexture(128);
    const d = tex.image.data as Uint8Array;
    expect(d.length).toBe(128 * 128 * 4);
    for (let i = 0; i < d.length; i += 4) {
      const nz = (d[i + 2] / 255) * 2 - 1;
      expect(nz).toBeGreaterThan(0.5);
      expect(d[i + 3]).toBe(255);
    }
  });
});

describe('menu music per map', () => {
  it('Monte-Carlo plays its bossa loop (OGG, WAV fallback); every other map the default menu loop', () => {
    expect(trackMusic('monte_carlo')).toEqual({
      file: 'music/monaco_riviera_loop.ogg',
      fallback: 'music/monaco_riviera_loop.wav',
    });
    const def = trackMusic(null);
    expect(def.file).toBe('music/menu_loop.ogg');
    expect(trackMusic('cat_lai')).toEqual(def);
    expect(trackMusic('no_such_map')).toEqual(def);
  });
});
