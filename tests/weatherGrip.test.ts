import { describe, expect, it } from 'vitest';
import { PHAM_VAN_DONG, type WeatherDef } from '../src/core/Data';
import { composeSurface } from '../src/weather/grip';

const W = PHAM_VAN_DONG.weather as WeatherDef;

describe('surface multipliers', () => {
  it('a wet road alone gives 90% grip and 20% longer braking', () => {
    expect(composeSurface(W, false, false)).toEqual({ grip: 0.9, brakeDistance: 1.2, drag: 1 });
  });
  it('a puddle drops grip to 65%', () => {
    expect(composeSurface(W, true, false).grip).toBe(0.65);
  });
  it('the flood gives 55% grip and 1.6x drag', () => {
    const m = composeSurface(W, false, true);
    expect(m.grip).toBe(0.55);
    expect(m.drag).toBe(1.6);
  });
  it('the lowest grip figure wins, they do not stack', () => {
    expect(composeSurface(W, true, true).grip).toBe(0.55);
  });
});
