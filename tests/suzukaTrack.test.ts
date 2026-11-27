import { describe, expect, it } from 'vitest';
import { SUZUKA, TRACKS, getTrack, roadWidthAt } from '../src/core/Data';

describe('Suzuka Hills Circuit track data (Map 7)', () => {
  it('is the 7th map: a day map with a low sun, 2 laps, 5.8 km, with elevation', () => {
    expect(TRACKS[TRACKS.length - 1]).toBe(SUZUKA);
    expect(getTrack('suzuka_hills')).toBe(SUZUKA);
    expect(SUZUKA.timeOfDay).toBe('day');
    expect(SUZUKA.laps).toBe(2);
    expect(SUZUKA.lapLengthM).toBe(5789);
    expect(SUZUKA.hasElevation).toBe(true);
    expect(SUZUKA.daylight?.sun.intensity).toBe(5);
    expect(SUZUKA.daylight?.toneMappingExposure).toBeCloseTo(0.62, 2);
  });

  it('is a figure-eight: the spline crosses itself in plan, 8.5 m above the road underneath', () => {
    const c = SUZUKA.raw.crossover as { upperT: number; lowerT: number; deckClearM: number };
    const path = SUZUKA.spline.points;
    const n = path.length;
    const at = (t: number): number[] => path[Math.min(n - 1, Math.floor(t * n))];
    const upper = at(c.upperT);
    const lower = at(c.lowerT);
    // The legs cross at about the same x/z, the upper one high above the lower one.
    expect(Math.hypot(upper[0] - lower[0], upper[2] - lower[2])).toBeLessThan(120);
    expect(upper[1] - lower[1]).toBeGreaterThan(6);
    expect(c.deckClearM).toBe(8.5);
  });

  it('keeps the carriageway width by section, blended over 40 m, and the pickup lanes inside the narrowest', () => {
    expect(roadWidthAt(SUZUKA, 0.05)).toBeCloseTo(16, 1); // home straight
    expect(roadWidthAt(SUZUKA, 0.25)).toBeCloseTo(13, 1); // S-Curves / Degner
    expect(roadWidthAt(SUZUKA, 0.5)).toBeCloseTo(13, 1);
    expect(roadWidthAt(SUZUKA, 0.8)).toBeCloseTo(14, 1);
    for (const o of SUZUKA.laneOffsetsM) expect(Math.abs(o)).toBeLessThan(13 / 2);
    expect(SUZUKA.sidewalkT).toBeNull();
    expect(SUZUKA.blockedLane).toBeNull();
  });

  it('has the three no-fire zones and a 10-car grid', () => {
    expect(SUZUKA.noFireZones.map((z) => z.name)).toEqual(['S-Curves', 'Under the crossover', 'Final Chicane']);
    expect(SUZUKA.startLine.grid).toHaveLength(10);
    expect(SUZUKA.checkpoints).toHaveLength(8);
  });
});
