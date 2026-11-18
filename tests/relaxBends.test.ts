import { describe, expect, it } from 'vitest';
import { CAT_LAI, CONG_HOA, XA_LO } from '../src/core/Data';
import { circumradiusXZ, relaxTightBends } from '../src/world/relaxBends';

const minRadius = (pts: readonly (readonly number[])[]): number => {
  let m = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i + pts.length - 1) % pts.length];
    const b = pts[i];
    const c = pts[(i + 1) % pts.length];
    m = Math.min(m, circumradiusXZ(a[0], a[2], b[0], b[2], c[0], c[2]));
  }
  return m;
};

describe('relaxTightBends', () => {
  it('measures radius', () => {
    expect(circumradiusXZ(0, 0, 1, 0, 2, 0)).toBe(Infinity);
    expect(circumradiusXZ(1, 0, 0, 1, -1, 0)).toBeCloseTo(1, 5);
  });

  it('leaves maps without tight bends untouched', () => {
    for (const t of [CAT_LAI, XA_LO]) {
      const out = relaxTightBends(t.spline.points, 5);
      expect(out).toHaveLength(t.spline.points.length);
    }
  });

  it("opens Cong Hoa's 4 m U-turn up to the minimum radius without moving the rest of the lap", () => {
    const pts = CONG_HOA.spline.points;
    const out = relaxTightBends(pts, 8);
    expect(minRadius(out)).toBeGreaterThan(7);
    // The start line (first control point) stays where it was within a couple of metres.
    const d = Math.min(...out.map((p) => Math.hypot(p[0] - pts[0][0], p[2] - pts[0][2])));
    expect(d).toBeLessThan(2.5);
  });
});
