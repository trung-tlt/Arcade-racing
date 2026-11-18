import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fitDistance, luminance, selectedCardColors } from '../src/ui/carThumbs';

describe('selectedCardColors', () => {
  it('fills with the paint and picks dark text on light paints', () => {
    expect(selectedCardColors('#C6FF3D')).toEqual({ bg: '#C6FF3D', fg: '#0e1116', border: '#C6FF3D' });
    expect(selectedCardColors('#FF6A1A').fg).toBe('#0e1116');
  });
  it('uses light text on mid/dark paints', () => {
    expect(selectedCardColors('#4B5A3A').fg).toBe('#ffffff');
    expect(selectedCardColors('#8B5CF6').fg).toBe('#ffffff');
  });
  it('gives near-black paints a visible steel fill with a light outline', () => {
    const c = selectedCardColors('#14171D');
    expect(c.bg).not.toBe('#14171D');
    expect(luminance(c.bg)).toBeGreaterThan(luminance('#14171D'));
    expect(c.fg).toBe('#e8ecf2');
    expect(c.border).toBe('#e8ecf2');
  });
});

describe('fitDistance', () => {
  const centre = new THREE.Vector3(0, 0, 0);
  const front = new THREE.Vector3(0, 0, 1);
  const corners = (hx: number, hy: number, hz: number): THREE.Vector3[] => {
    const out: THREE.Vector3[] = [];
    for (const x of [-hx, hx])
      for (const y of [-hy, hy]) for (const z of [-hz, hz]) out.push(new THREE.Vector3(x, y, z));
    return out;
  };
  it('grows with the size of the subject and is never zero', () => {
    const a = fitDistance(corners(1, 1, 1), centre, front, 30, 1.6);
    const b = fitDistance(corners(2, 2, 2), centre, front, 30, 1.6);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a * 1.8);
  });
  it('keeps every corner inside the frustum at the returned distance', () => {
    const pts = corners(2.4, 0.8, 1);
    const dir = new THREE.Vector3(0.72, 0.38, 0.9).normalize();
    const d = fitDistance(pts, centre, dir, 28, 1.6);
    const cam = new THREE.PerspectiveCamera(28, 1.6, 0.1, 100);
    cam.position.copy(dir).multiplyScalar(d);
    cam.lookAt(centre);
    cam.updateMatrixWorld(true);
    for (const p of pts) {
      const ndc = p.clone().project(cam);
      expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1.0001);
      expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1.0001);
    }
  });
  it('applies the margin', () => {
    const base = fitDistance(corners(1, 1, 1), centre, front, 30, 1.6, 1);
    expect(fitDistance(corners(1, 1, 1), centre, front, 30, 1.6, 1.25)).toBeCloseTo(base * 1.25, 6);
  });
});
