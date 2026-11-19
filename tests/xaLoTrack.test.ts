import { describe, expect, it } from 'vitest';
import { TRACKS, XA_LO, roadWidthAt } from '../src/core/Data';
import { TrackPath } from '../src/world/TrackPath';

describe('Hanoi Highway track data', () => {
  it('is registered as the third (of four), dusk, elevated map', () => {
    expect(TRACKS.map((t) => t.id).slice(0, 3)).toEqual(['cat_lai', 'cong_hoa', 'xa_lo_ha_noi']);
    expect(XA_LO.timeOfDay).toBe('dusk');
    expect(XA_LO.hasElevation).toBe(true);
    expect(XA_LO.groundY).toBeLessThan(-6.5);
    expect(XA_LO.daylight).not.toBeNull();
    expect(XA_LO.laneOffsetsM).toHaveLength(4);
  });

  it('narrows to the frontage road only inside its section, with a blend', () => {
    expect(roadWidthAt(XA_LO, 0.2)).toBeCloseTo(15, 5);
    expect(roadWidthAt(XA_LO, 0.7)).toBeCloseTo(8, 5);
    const mid = roadWidthAt(XA_LO, XA_LO.widthProfile[0].fromT + 10 / XA_LO.lapLengthM);
    expect(mid).toBeGreaterThan(8);
    expect(mid).toBeLessThan(15);
  });

  it('samples road height from the spline', () => {
    const p = new TrackPath(XA_LO.spline.points, 4, 12);
    expect(Math.max(...p.py)).toBeGreaterThan(10);
    expect(Math.min(...p.py)).toBeLessThan(-6);
    expect(p.yAt(0.377)).toBeLessThan(-4);
  });
});
