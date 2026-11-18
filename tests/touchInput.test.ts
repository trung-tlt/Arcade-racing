import { describe, expect, it } from 'vitest';
import { Input } from '../src/core/Input';
import touchJson from '../data/touch.json';
import {
  TOUCH,
  TouchInput,
  clusterSides,
  detectTouch,
  rollFromOrientation,
  steerFromTilt,
  steerFromWheel,
  validateTouchConfig,
} from '../src/core/TouchInput';

const make = (): TouchInput => {
  const t = new TouchInput();
  t.enabled = true;
  return t;
};

describe('data/touch.json', () => {
  it('matches the schema', () => expect(validateTouchConfig(touchJson)).toEqual([]));
  it('rejects targets under 48 px, margins under the 44 px notch inset and a bad tilt range', () => {
    const bad = JSON.parse(JSON.stringify(touchJson)) as typeof touchJson;
    bad.layout.firePx = 40;
    bad.layout.marginXPx = 30;
    bad.tilt.deadzoneDeg = 40;
    const errors = validateTouchConfig(bad);
    expect(errors.some((e) => e.includes('firePx'))).toBe(true);
    expect(errors.some((e) => e.includes('marginXPx'))).toBe(true);
    expect(errors.some((e) => e.includes('deadzoneDeg'))).toBe(true);
  });
  it('matches the design sizes', () => {
    expect(TOUCH.layout.padPx).toBe(78);
    expect(TOUCH.layout.firePx).toBe(92);
    expect(TOUCH.layout.marginXPx).toBe(44);
  });
});

describe('TouchInput', () => {
  it('auto-gas is on by default and the brake cancels it', () => {
    const t = make();
    expect(t.read().throttle).toBe(1);
    t.press(1, 'brake');
    const a = t.read();
    expect(a.brake).toBe(1);
    expect(a.throttle).toBe(0);
    t.release(1);
    expect(t.read().throttle).toBe(1);
  });

  it('with auto-gas off only the GAS button drives the throttle', () => {
    const t = make();
    t.prefs = { ...t.prefs, autoGas: false };
    expect(t.read().throttle).toBe(0);
    t.press(7, 'gas');
    expect(t.read().throttle).toBe(1);
  });

  it('two thumbs at once: steer and fire together, each released by its own pointer', () => {
    const t = make();
    t.press(1, 'right');
    t.press(2, 'fire');
    t.press(3, 'nitro');
    let a = t.read();
    expect(a.steer).toBe(1);
    expect(a.fire).toBe(true);
    expect(a.nitro).toBe(true);
    t.release(2);
    a = t.read();
    expect(a.fire).toBe(false);
    expect(a.steer).toBe(1);
    t.press(4, 'left'); // both pads cancel
    expect(t.read().steer).toBe(0);
  });

  it('maps rocket and drift to the right actions', () => {
    const t = make();
    t.press(1, 'rocket');
    t.press(2, 'drift');
    const a = t.read();
    expect(a.fireSecondary).toBe(true);
    expect(a.drift).toBe(true);
  });

  it('the swipe wheel steers by drag distance and recentres on release', () => {
    const t = make();
    t.prefs = { ...t.prefs, scheme: 'wheel' };
    t.startWheel(1, 100);
    t.moveWheel(1, 100 + TOUCH.steer.wheelRadiusPx / 2);
    expect(t.read().steer).toBeCloseTo(0.5, 5);
    t.moveWheel(1, 100 + 10 * TOUCH.steer.wheelRadiusPx);
    expect(t.read().steer).toBe(1);
    t.release(1);
    expect(t.read().steer).toBe(0);
    // pads are ignored in wheel mode
    t.press(9, 'left');
    expect(t.read().steer).toBe(0);
  });

  it('tilt: deadzone, saturation and smoothing', () => {
    expect(steerFromTilt(TOUCH.tilt.deadzoneDeg - 0.1)).toBe(0);
    expect(steerFromTilt(TOUCH.tilt.maxDeg + 20)).toBe(1);
    expect(steerFromTilt(-TOUCH.tilt.maxDeg)).toBe(-1);
    const t = make();
    t.prefs = { ...t.prefs, scheme: 'tilt' };
    t.setTilt(TOUCH.tilt.maxDeg);
    const first = t.read().steer;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1); // smoothed, not instant
    for (let i = 0; i < 60; i++) t.read();
    expect(t.read().steer).toBeCloseTo(1, 2);
  });

  it('device roll depends on the screen rotation', () => {
    expect(rollFromOrientation(10, 20, 0)).toBe(20);
    expect(rollFromOrientation(10, 20, 90)).toBe(10);
    expect(rollFromOrientation(10, 20, 270)).toBe(-10);
    expect(rollFromOrientation(10, 20, 180)).toBe(-20);
    expect(rollFromOrientation(10, 20, -90)).toBe(-10);
  });

  it('wheel helper has a deadzone', () => {
    expect(steerFromWheel(1)).toBe(0);
    expect(steerFromWheel(-TOUCH.steer.wheelRadiusPx)).toBe(-1);
  });

  it('left-handed mirrors the clusters', () => {
    expect(clusterSides(false)).toEqual({ steer: 'left', actions: 'right' });
    expect(clusterSides(true)).toEqual({ steer: 'right', actions: 'left' });
  });

  it('pause and reset are one-shot edges cleared at frame end', () => {
    const t = make();
    t.edge('pause');
    expect(t.hasEdge('pause')).toBe(true);
    t.endFrame();
    expect(t.hasEdge('pause')).toBe(false);
  });

  it('releaseAll clears every held pointer', () => {
    const t = make();
    t.press(1, 'fire');
    t.press(2, 'nitro');
    t.releaseAll();
    const a = t.read();
    expect(a.fire).toBe(false);
    expect(a.nitro).toBe(false);
  });
});

describe('detectTouch', () => {
  const win = (coarse: boolean): Pick<Window, 'matchMedia'> => ({
    matchMedia: () => ({ matches: coarse }) as MediaQueryList,
  });
  it('needs a coarse pointer and touch points; ?touch overrides', () => {
    expect(detectTouch('', win(true), { maxTouchPoints: 5 })).toBe(true);
    expect(detectTouch('', win(true), { maxTouchPoints: 0 })).toBe(false);
    expect(detectTouch('', win(false), { maxTouchPoints: 5 })).toBe(false);
    expect(detectTouch('?touch=1', win(false), { maxTouchPoints: 0 })).toBe(true);
    expect(detectTouch('?touch=0', win(true), { maxTouchPoints: 5 })).toBe(false);
  });
});

describe('Input merges touch with keyboard / gamepad through one action object', () => {
  const fakeWindow = (): Window => {
    const listeners = new Map<string, ((e: unknown) => void)[]>();
    return {
      addEventListener: (n: string, f: (e: unknown) => void) => listeners.set(n, [...(listeners.get(n) ?? []), f]),
      removeEventListener: () => undefined,
    } as unknown as Window;
  };

  it('ignores touch when the device is not a touch device', () => {
    const t = new TouchInput();
    t.press(1, 'fire');
    const input = new Input(fakeWindow(), t);
    expect(input.read().fire).toBe(false);
    expect(input.read().throttle).toBe(0);
  });

  it('touch adds auto-gas, steering and fire; the pause edge reaches wasPressed', () => {
    const t = make();
    t.press(1, 'right');
    t.press(2, 'fire');
    const input = new Input(fakeWindow(), t);
    const c = input.read();
    expect(c.throttle).toBe(1);
    expect(c.steer).toBe(1);
    expect(c.fire).toBe(true);
    t.edge('pause');
    expect(input.wasPressed('pause')).toBe(true);
    input.endFrame();
    expect(input.wasPressed('pause')).toBe(false);
  });
});
