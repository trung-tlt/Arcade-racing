import { describe, expect, it } from 'vitest';
import { ALL_TRACKS } from '../src/core/Data';
import { buildOutline } from '../src/ui/trackOutline';

describe('buildOutline', () => {
  it('fits a square inside the padded box and centres it', () => {
    const o = buildOutline(
      [
        [0, 0, 0],
        [100, 0, 0],
        [100, 0, 100],
        [0, 0, 100],
      ],
      400,
      300,
      50,
    );
    expect(o.scale).toBeCloseTo(2, 5); // limited by the 300 px height: (300-100)/100
    const a = o.project(0, 0);
    const b = o.project(100, 100);
    expect(a.y).toBeCloseTo(50, 5);
    expect(b.y).toBeCloseTo(250, 5);
    expect((a.x + b.x) / 2).toBeCloseTo(200, 5);
    expect(o.d.startsWith('M')).toBe(true);
    expect(o.d.endsWith('Z')).toBe(true);
    expect(o.d.match(/C/g)).toHaveLength(4);
  });
  it('puts north (−Z) at the top', () => {
    const o = buildOutline([
      [0, 0, -500],
      [50, 0, 0],
      [0, 0, 500],
    ]);
    expect(o.project(0, -500).y).toBeLessThan(o.project(0, 500).y);
  });
  it('draws the start bar perpendicular to the first segment', () => {
    const o = buildOutline([
      [0, 0, 0],
      [100, 0, 0],
      [100, 0, 100],
      [0, 0, 100],
    ]);
    const bx = o.start.x2 - o.start.x1;
    const by = o.start.y2 - o.start.y1;
    const seg = { x: o.project(100, 0).x - o.project(0, 0).x, y: o.project(100, 0).y - o.project(0, 0).y };
    expect(bx * seg.x + by * seg.y).toBeCloseTo(0, 3);
  });
  it('fits every real map inside the box', () => {
    for (const t of ALL_TRACKS) {
      const o = buildOutline(t.spline.points);
      for (const p of t.spline.points) {
        const q = o.project(p[0], p[2]);
        expect(q.x, t.id).toBeGreaterThanOrEqual(0);
        expect(q.x, t.id).toBeLessThanOrEqual(760);
        expect(q.y, t.id).toBeGreaterThanOrEqual(0);
        expect(q.y, t.id).toBeLessThanOrEqual(740);
      }
    }
  });
});
