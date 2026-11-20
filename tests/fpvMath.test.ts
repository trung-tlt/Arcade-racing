import { describe, expect, it } from 'vitest';
import { CARS, FPV, getCarDef } from '../src/core/Data';
import {
  FpvShake,
  HeadMotion,
  availableViews,
  dashReadout,
  dueForRedraw,
  follow,
  fpvFov,
  mirrorSpec,
  nextAvailableView,
  resolveView,
  shakeFor,
  type FpvFeel,
} from '../src/vehicle/FpvMath';

const FEEL = FPV as unknown as FpvFeel;
const DEG = Math.PI / 180;
const calm = { lateralAccel: 0, vy: 0, steer: 0, lookBack: false, bikeLeanRad: 0, calm: false };

describe('first-person views', () => {
  it('every car offers chase, hood and (with the rig loaded) its driver view', () => {
    for (const c of CARS) {
      expect(availableViews(c, true), c.id).toEqual(['chase', 'hood', 'cockpit']);
    }
  });
  it('a cockpit car without the rig loaded skips the cockpit; helmet cars do not need it', () => {
    expect(availableViews(getCarDef('kestrel_gt'), false)).toEqual(['chase', 'hood']);
    expect(availableViews(getCarDef('mantis_650r'), false)).toEqual(['chase', 'hood', 'cockpit']);
  });
  it('V cycles chase → hood → cockpit → chase and skips views the car cannot show', () => {
    const all = ['chase', 'hood', 'cockpit'] as const;
    expect(nextAvailableView('chase', all)).toBe('hood');
    expect(nextAvailableView('hood', all)).toBe('cockpit');
    expect(nextAvailableView('cockpit', all)).toBe('chase');
    expect(nextAvailableView('hood', ['chase', 'hood'])).toBe('chase');
    expect(nextAvailableView('chase', ['chase'])).toBe('chase');
  });
  it('a remembered view the car cannot show falls back to chase', () => {
    expect(resolveView('cockpit', ['chase', 'hood'])).toBe('chase');
    expect(resolveView('hood', ['chase', 'hood'])).toBe('hood');
  });
  it('every driver view has an eye and a field of view; cockpit cars carry rig colours', () => {
    for (const c of CARS) {
      expect(c.fpv, c.id).toBeDefined();
      expect(c.fpv?.eye).toHaveLength(3);
      if (c.fpv?.mode === 'cockpit') expect(c.fpv.tint?.paint).toMatch(/^#/);
    }
  });
});

describe('field of view', () => {
  const kestrel = getCarDef('kestrel_gt');
  const mantis = getCarDef('mantis_650r');
  it('cockpit 64°, helmet 70°, hood from data; nitro adds 6°', () => {
    expect(fpvFov('cockpit', kestrel, FEEL, 0)).toBe(64);
    expect(fpvFov('cockpit', mantis, FEEL, 0)).toBe(70);
    expect(fpvFov('hood', kestrel, FEEL, 0)).toBe(FPV.fov.hood);
    expect(fpvFov('cockpit', kestrel, FEEL, 1)).toBe(70);
    expect(fpvFov('cockpit', kestrel, FEEL, 0.5)).toBe(67);
  });
  it('the nitro kick eases in over about 0.3 s', () => {
    let k = 0;
    for (let i = 0; i < 18; i++) k += (1 - k) * follow(1 / 60, FEEL.fov.nitroLerpSec);
    expect(k).toBeGreaterThan(0.6);
    expect(k).toBeLessThan(0.7);
  });
});

describe('head motion', () => {
  it('leans with lateral g but never more than 2°', () => {
    const h = new HeadMotion();
    for (let i = 0; i < 120; i++) h.update(1 / 60, FEEL, { ...calm, lateralAccel: 100 });
    expect(h.roll).toBeLessThanOrEqual(FEEL.head.leanMaxDeg * DEG + 1e-9);
    expect(h.roll).toBeGreaterThan(1.5 * DEG);
  });
  it('looks toward the apex with 0.12 × steer, capped at 8°', () => {
    const h = new HeadMotion();
    for (let i = 0; i < 120; i++) h.update(1 / 60, FEEL, { ...calm, steer: 1 });
    expect(h.yaw).toBeCloseTo(FEEL.apex.gain, 2); // 0.12 rad ≈ 6.9°, under the 8° cap
    const hard = new HeadMotion();
    for (let i = 0; i < 120; i++) hard.update(1 / 60, FEEL, { ...calm, steer: 5 });
    expect(hard.yaw).toBeCloseTo(FEEL.apex.maxDeg * DEG, 2);
    const half = new HeadMotion();
    for (let i = 0; i < 120; i++) half.update(1 / 60, FEEL, { ...calm, steer: 0.05 });
    expect(Math.abs(half.yaw)).toBeLessThan(FEEL.apex.maxDeg * DEG);
  });
  it('dips 4 cm on a landing and recovers', () => {
    const h = new HeadMotion();
    h.update(1 / 60, FEEL, { ...calm, vy: -10 });
    h.update(1 / 60, FEEL, { ...calm, vy: 0 });
    expect(h.offset.y).toBeLessThan(-0.02);
    expect(h.offset.y).toBeGreaterThan(-FEEL.head.dipM * 1.6);
    for (let i = 0; i < 180; i++) h.update(1 / 60, FEEL, calm);
    expect(Math.abs(h.offset.y)).toBeLessThan(0.002);
  });
  it('C looks over the shoulder (180°) and back', () => {
    const h = new HeadMotion();
    for (let i = 0; i < 90; i++) h.update(1 / 60, FEEL, { ...calm, lookBack: true });
    expect(h.yaw).toBeCloseTo(Math.PI, 1);
    expect(h.lookBackAmount).toBeGreaterThan(0.95);
    for (let i = 0; i < 90; i++) h.update(1 / 60, FEEL, calm);
    expect(Math.abs(h.yaw)).toBeLessThan(0.05);
  });
  it('bikes lean the view with the machine (×0.6)', () => {
    const h = new HeadMotion();
    h.update(1 / 60, FEEL, { ...calm, bikeLeanRad: 40 * DEG });
    expect(h.roll).toBeCloseTo(40 * DEG * FEEL.head.bikeLeanMul, 6);
  });
  it('Reduce motion / Low: no lean, dip, slide or apex look', () => {
    const h = new HeadMotion();
    for (let i = 0; i < 60; i++)
      h.update(1 / 60, FEEL, { lateralAccel: 100, vy: -10, steer: 1, lookBack: false, bikeLeanRad: 0, calm: true });
    expect(h.roll).toBeCloseTo(0, 9);
    expect(h.yaw).toBeCloseTo(0, 9);
    expect(h.offset.y).toBeCloseTo(0, 9);
    expect(h.offset.x).toBeCloseTo(0, 9);
  });
});

describe('shake', () => {
  it('hits last 0.15 s at 0.8°, rockets 0.4 s at 2.5°, and fade out', () => {
    expect(shakeFor(0.1, FPV.shake.rocketMinAmount)).toBe('hit');
    expect(shakeFor(0.8, FPV.shake.rocketMinAmount)).toBe('rocket');
    const s = new FpvShake();
    s.kick(FPV.shake.rocket.sec, FPV.shake.rocket.deg);
    const first = s.step(1 / 60, () => 1);
    expect(first.x).toBeLessThanOrEqual(FPV.shake.rocket.deg * DEG);
    expect(first.x).toBeGreaterThan(FPV.shake.rocket.deg * DEG * 0.9);
    for (let i = 0; i < 40; i++) s.step(1 / 60, () => 1);
    expect(s.active).toBe(false);
    expect(s.step(1 / 60, () => 1)).toEqual({ x: 0, y: 0 });
  });
  it('a small hit does not cut a bigger shake short', () => {
    const s = new FpvShake();
    s.kick(0.4, 2.5);
    s.kick(0.15, 0.8);
    for (let i = 0; i < 12; i++) s.step(1 / 60, () => 1);
    expect(s.active).toBe(true);
  });
});

describe('mirror and dash', () => {
  it('mirror is 512×128 at 30 fps, 256×64 at 15 fps on Low', () => {
    expect(mirrorSpec(false, FPV.mirror)).toEqual({ width: 512, height: 128, fps: 30 });
    expect(mirrorSpec(true, FPV.mirror)).toEqual({ width: 256, height: 64, fps: 15 });
  });
  it('redraws only when the interval has passed', () => {
    expect(dueForRedraw(0.01, 30)).toBe(false);
    expect(dueForRedraw(1 / 30, 30)).toBe(true);
    expect(dueForRedraw(1, 0)).toBe(false);
    expect(FPV.dash.hz).toBe(10);
    expect(FPV.dash.lowHz).toBe(5);
  });
  it('the dash shows speed in the chosen unit, gear (R when reversing), revs and the nitro bars', () => {
    expect(dashReadout(50, false, 3, 0.7, 2.4, false)).toEqual({
      speed: '180',
      unit: 'KM/H',
      gear: '3',
      rpm: 0.7,
      nitroBars: 2.4,
    });
    expect(dashReadout(-10, true, 1, 0.2, 0, true)).toMatchObject({ speed: '22', unit: 'MPH', gear: 'R' });
    expect(dashReadout(0, false, 1, 3, 9, false)).toMatchObject({ rpm: 1, nitroBars: 3 });
  });
});
