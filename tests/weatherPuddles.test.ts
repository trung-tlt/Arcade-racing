import { describe, expect, it } from 'vitest';
import { PHAM_VAN_DONG, RACE, type WeatherDef } from '../src/core/Data';
import { PuddleTracker, puddleSpots } from '../src/weather/puddleSpots';
import { TrackPath } from '../src/world/TrackPath';

const W = PHAM_VAN_DONG.weather as WeatherDef;
const path = new TrackPath(PHAM_VAN_DONG.spline.points, RACE.track.sampleSpacingM, RACE.track.projectWindowSamples);
const spots = puddleSpots(W, path, RACE.track.roadY);

describe('puddle placement', () => {
  it('has the 13 puddles of the JSON', () => {
    expect(spots).toHaveLength(13);
  });
  it('puts each one lateralM from the racing line, + to the left', () => {
    W.puddles.items.forEach((it, i) => {
      const p = path.pointAt(it.t);
      const tg = path.tangentAt(it.t);
      const h = Math.hypot(tg.x, tg.z);
      // signed distance along "left" = (tz, -tx)
      const lateral = ((spots[i].x - p.x) * tg.z - (spots[i].z - p.z) * tg.x) / h;
      expect(lateral).toBeCloseTo(it.lateralM, 3);
      expect(spots[i].y).toBeCloseTo(p.y + RACE.track.roadY, 3);
    });
  });
});

describe('puddle tracker', () => {
  const s = spots[2];
  const mk = () => new PuddleTracker(spots, { gripSec: 0.4, hitRadiusMul: 0.85 });
  it('reports an entry once and holds the reduced grip for 0.4 s', () => {
    const tr = mk();
    expect(tr.update('a', s.x + 50, s.z, 1 / 60)).toBeNull();
    expect(tr.gripActive('a')).toBe(false);
    expect(tr.update('a', s.x, s.z, 1 / 60)).toBe(s);
    expect(tr.gripActive('a')).toBe(true);
    // still inside: no second entry
    expect(tr.update('a', s.x + 0.5, s.z, 1 / 60)).toBeNull();
    // leave and let the timer run: active for ~0.4 s, then off
    for (let i = 0; i < 22; i++) tr.update('a', s.x + 50, s.z, 1 / 60);
    expect(tr.gripActive('a')).toBe(true);
    for (let i = 0; i < 6; i++) tr.update('a', s.x + 50, s.z, 1 / 60);
    expect(tr.gripActive('a')).toBe(false);
  });
  it('counts a hit only inside 85% of the radius', () => {
    const tr = mk();
    expect(tr.update('a', s.x + s.radiusM * 0.9, s.z, 1 / 60)).toBeNull();
    expect(tr.update('a', s.x + s.radiusM * 0.8, s.z, 1 / 60)).toBe(s);
  });
  it('tracks cars independently and re-enters after leaving', () => {
    const tr = mk();
    expect(tr.update('a', s.x, s.z, 1 / 60)).toBe(s);
    expect(tr.gripActive('b')).toBe(false);
    tr.update('a', s.x + 50, s.z, 1 / 60);
    expect(tr.update('a', s.x, s.z, 1 / 60)).toBe(s);
  });
});
