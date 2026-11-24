import { describe, expect, it } from 'vitest';
import { ARDENNES, CAT_LAI } from '../src/core/Data';
import {
  EAU_ROUGE_T,
  GUST_EVERY_SEC,
  GustScheduler,
  THUNDER_EVERY_SEC,
  ThunderScheduler,
  crossed,
  gravelSpray,
  inGustZone,
  kerbLevel,
  showerForLap,
  trackAudioFiles,
  wetnessAt,
  wetTyresLevel,
  whooshTrigger,
  zoneLevel,
} from '../src/audio/ArdennesAudio';

describe('Ardennes audio zones', () => {
  it('zone level is full near a point and fades to 0 at the radius', () => {
    const p = [{ x: 0, z: 0 }];
    expect(zoneLevel(p, 10, 0, 80, 40)).toBe(1);
    expect(zoneLevel(p, 60, 0, 80, 40)).toBeCloseTo(0.5);
    expect(zoneLevel(p, 80, 0, 80, 40)).toBe(0);
    expect(zoneLevel(p, 500, 0, 80, 40)).toBe(0);
    expect(zoneLevel([], 0, 0, 80)).toBe(0);
  });

  it('the shower is dry on lap 1 and 0.8 on lap 2 (and after), only inside the wet zones', () => {
    expect(showerForLap(ARDENNES, 1)).toBe(0);
    expect(showerForLap(ARDENNES, 2)).toBe(0.8);
    expect(showerForLap(ARDENNES, 3)).toBe(0.8);
    expect(showerForLap(CAT_LAI, 2)).toBe(0);
    expect(wetnessAt(ARDENNES, 1, 0.8)).toBe(0);
    expect(wetnessAt(ARDENNES, 2, 0.8)).toBeCloseTo(0.8); // Stavelot -> Blanchimont
    expect(wetnessAt(ARDENNES, 2, 0.15)).toBeCloseTo(0.8); // Eau Rouge damp
    expect(wetnessAt(ARDENNES, 2, 0.4)).toBe(0);
  });

  it('wet tyres scale with speed x wetness; kerb with speed', () => {
    expect(wetTyresLevel(0, 0.8)).toBe(0);
    expect(wetTyresLevel(300, 0)).toBe(0);
    expect(wetTyresLevel(100, 0.8)).toBeCloseTo(0.4);
    expect(kerbLevel(false, 200)).toBe(0);
    expect(kerbLevel(true, 100)).toBeCloseTo(0.5);
  });
});

describe('Ardennes audio triggers', () => {
  it('the whoosh needs >= 180 km/h through the bottom of Eau Rouge, going forward', () => {
    expect(whooshTrigger(EAU_ROUGE_T - 0.001, EAU_ROUGE_T + 0.001, 200)).toBe(true);
    expect(whooshTrigger(EAU_ROUGE_T - 0.001, EAU_ROUGE_T + 0.001, 150)).toBe(false);
    expect(whooshTrigger(EAU_ROUGE_T + 0.001, EAU_ROUGE_T + 0.002, 250)).toBe(false);
    expect(whooshTrigger(EAU_ROUGE_T + 0.001, EAU_ROUGE_T - 0.001, 250)).toBe(false);
  });

  it('crossing detection survives the lap wrap and ignores teleports', () => {
    expect(crossed(0.999, 0.001, 0)).toBe(true);
    expect(crossed(0.5, 0.9, 0.7)).toBe(false);
  });

  it('thunder is lap-2 only, 45-90 s apart, with an injectable rng', () => {
    const lo = new ThunderScheduler(() => 0);
    expect(lo.tick(100, 1)).toBe(false);
    expect(lo.tick(THUNDER_EVERY_SEC[0] - 1, 2)).toBe(false);
    expect(lo.tick(1, 2)).toBe(true);
    expect(lo.tick(THUNDER_EVERY_SEC[0] - 1, 2)).toBe(false);
    expect(lo.tick(1, 2)).toBe(true);
    const hi = new ThunderScheduler(() => 1);
    expect(hi.tick(THUNDER_EVERY_SEC[1] - 0.5, 2)).toBe(false);
    expect(hi.tick(1, 2)).toBe(true);
  });

  it('gusts blow only on Kemmel / Les Combes, every 20-40 s', () => {
    expect(inGustZone(0.3)).toBe(true);
    expect(inGustZone(0.38)).toBe(true);
    expect(inGustZone(0.7)).toBe(false);
    const g = new GustScheduler(() => 0);
    expect(g.tick(100, false)).toBe(false);
    expect(g.tick(GUST_EVERY_SEC[0], true)).toBe(true);
  });

  it('gravel spray fires on entry above 60 km/h only', () => {
    expect(gravelSpray(false, true, 80)).toBe(true);
    expect(gravelSpray(false, true, 50)).toBe(false);
    expect(gravelSpray(true, true, 80)).toBe(false);
  });
});

describe('Ardennes audio files', () => {
  it('lists every sound the track JSON names so the bus loads them', () => {
    const files = trackAudioFiles(ARDENNES);
    for (const n of [
      'forest_ambience_loop',
      'crowd_valley_loop',
      'creek_loop',
      'rain_canopy_loop',
      'compression_whoosh',
      'wet_tyres_loop',
      'far_thunder',
      'kerb_rumble',
      'gravel_spray',
      'wind_gust',
      'church_bell',
      'cowbells_loop',
      'campsite_radio_loop',
      'rain_on_roof_loop',
    ])
      expect(files).toContain(`sfx/spa/${n}.wav`);
    expect(new Set(files).size).toBe(files.length);
    expect(trackAudioFiles(CAT_LAI)).toEqual([]);
  });
});
