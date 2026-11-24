import { describe, expect, it } from 'vitest';
import { CAT_LAI } from '../src/core/Data';
import {
  CLANK_EVERY_SEC,
  ClankScheduler,
  FerryHornScheduler,
  RIVER_RADIUS_M,
  SCOOTER_EVERY_SEC,
  ScooterHornScheduler,
  crossed,
  entered,
  ferryApproach,
  portLevel,
  quayEdge,
  riverLevel,
  streetLevel,
  trackAudioFiles,
  zoneLevel,
} from '../src/audio/CatLaiAudio';

describe('Cat Lai audio zones', () => {
  it('lists every sfx the JSON names, all of them existing files', async () => {
    const files = trackAudioFiles(CAT_LAI);
    expect(files.sort()).toEqual(
      [
        'port_day_loop',
        'street_traffic_loop',
        'river_lapping_loop',
        'reverse_beeper_loop',
        'container_clank',
        'ship_horn',
        'ferry_horn',
        'scooter_horns',
      ]
        .map((n) => `sfx/catlai2/${n}.wav`)
        .sort(),
    );
    const fs = await import('node:fs');
    for (const f of files) expect(fs.existsSync(`public/assets/${f}`)).toBe(true);
  });

  it('street on Nguyen Thi Dinh and the link, port everywhere else', () => {
    expect(streetLevel(CAT_LAI, 0.05)).toBe(1);
    expect(streetLevel(CAT_LAI, 0.97)).toBe(1);
    expect(streetLevel(CAT_LAI, 0.3)).toBe(0);
    expect(portLevel(CAT_LAI, 0.3)).toBe(1);
    expect(portLevel(CAT_LAI, 0.05)).toBe(0);
    const mid = streetLevel(CAT_LAI, 0.1155);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
  });

  it('river is audible within 60 m of the quay edge only', () => {
    const e = quayEdge(CAT_LAI)!;
    const mid = { x: (e.a.x + e.b.x) / 2, z: (e.a.z + e.b.z) / 2 };
    expect(riverLevel(e, mid.x, mid.z)).toBe(1);
    expect(riverLevel(e, mid.x - 30, mid.z - 30)).toBeGreaterThan(0);
    expect(riverLevel(e, mid.x - 300, mid.z - 300)).toBe(0);
    expect(RIVER_RADIUS_M).toBe(60);
    expect(riverLevel(null, 0, 0)).toBe(0);
  });

  it('the quay edge follows the JSON shoreline', () => {
    const e = quayEdge(CAT_LAI)!;
    // shoreline vertex at 558.2, 165.2 lies on the edge (187 m along from the start).
    expect(riverLevel(e, 558.2, 165.2)).toBe(1);
  });

  it('beeper zone fades with distance to a handler', () => {
    const p = [{ x: 0, z: 0 }];
    expect(zoneLevel(p, 5, 0, 50, 12)).toBe(1);
    expect(zoneLevel(p, 100, 0, 50, 12)).toBe(0);
  });

  it('clank and scooter schedulers fire inside their ranges with an injected rng', () => {
    const c = new ClankScheduler(() => 0);
    expect(c.tick(CLANK_EVERY_SEC[0] - 0.1, true)).toBe(false);
    expect(c.tick(0.2, true)).toBe(true);
    expect(c.tick(100, false)).toBe(false);
    const c2 = new ClankScheduler(() => 1);
    expect(c2.tick(CLANK_EVERY_SEC[1] - 0.1, true)).toBe(false);
    expect(c2.tick(0.2, true)).toBe(true);
    const s = new ScooterHornScheduler(() => 0.5);
    const mid = (SCOOTER_EVERY_SEC[0] + SCOOTER_EVERY_SEC[1]) / 2;
    expect(s.tick(mid - 0.1, true)).toBe(false);
    expect(s.tick(0.2, true)).toBe(true);
  });

  it('ferry horn follows the 240 s cycle near the landing, and when passing the approach', () => {
    const f = new FerryHornScheduler(240, 30);
    expect(f.tick(100, true, false)).toBe(false);
    expect(f.tick(21, true, false)).toBe(true); // 121 s: arrival at the half cycle
    expect(f.tick(10, true, true)).toBe(false); // cooldown
    const g = new FerryHornScheduler(240, 30);
    expect(g.tick(130, false, false)).toBe(false); // out of earshot
    expect(g.tick(1, true, true)).toBe(true); // passing the approach
  });

  it('lap-fraction crossings', () => {
    expect(crossed(0.32, 0.34, 0.33)).toBe(true);
    expect(crossed(0.34, 0.36, 0.33)).toBe(false);
    const a = ferryApproach(CAT_LAI)!;
    expect(a[0]).toBeCloseTo(0.1155);
    expect(entered(a[0] - 0.01, a[0] + 0.01, a)).toBe(true);
    expect(entered(a[0] + 0.01, a[0] + 0.02, a)).toBe(false);
  });
});
