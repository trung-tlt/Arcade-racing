import { describe, expect, it } from 'vitest';
import { approachAngle, turretYaw, wrapAngle } from '../src/vehicle/Turret';

const deg = (r: number): number => (r * 180) / Math.PI;

describe('turretYaw', () => {
  const fwd = { x: 0, z: 1 };
  it('is zero straight ahead', () => expect(turretYaw(fwd, { x: 0, z: 5 }, 25)).toBeCloseTo(0, 9));
  it('is positive towards +X (car left) and negative towards -X', () => {
    expect(deg(turretYaw(fwd, { x: 1, z: 1 }, 90))).toBeCloseTo(45, 6);
    expect(deg(turretYaw(fwd, { x: -1, z: 1 }, 90))).toBeCloseTo(-45, 6);
  });
  it('clamps to the limit', () => {
    expect(deg(turretYaw(fwd, { x: 1, z: 0 }, 25))).toBeCloseTo(25, 6);
    expect(deg(turretYaw(fwd, { x: -1, z: 0 }, 15))).toBeCloseTo(-15, 6);
  });
  it('is relative to the vehicle heading, not the world', () => {
    const east = { x: 1, z: 0 }; // car facing +X
    expect(deg(turretYaw(east, { x: 1, z: 1 }, 90))).toBeCloseTo(-45, 6); // target is to its right (-yaw)
  });
  it('360° turrets can aim backwards', () => {
    expect(Math.abs(deg(turretYaw(fwd, { x: 0, z: -3 }, 360)))).toBeCloseTo(180, 6);
  });
  it('ignores degenerate vectors', () => {
    expect(turretYaw(fwd, { x: 0, z: 0 }, 90)).toBe(0);
  });
});

describe('approachAngle / wrapAngle', () => {
  it('steps by at most maxStep', () => expect(approachAngle(0, 1, 0.25)).toBeCloseTo(0.25, 9));
  it('lands exactly on the target when within a step', () => expect(approachAngle(0.9, 1, 0.25)).toBeCloseTo(1, 9));
  it('takes the short way round the ±π seam', () => {
    const r = approachAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.05);
    expect(r).toBeCloseTo(Math.PI - 0.05, 9);
  });
  it('wraps into (-π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(0.5)).toBeCloseTo(0.5, 9);
  });
});
