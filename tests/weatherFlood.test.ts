import { describe, expect, it } from 'vitest';
import { PHAM_VAN_DONG, type WeatherDef } from '../src/core/Data';
import { inFlood, inFloodRange } from '../src/weather/flood';

const W = PHAM_VAN_DONG.weather as WeatherDef;

describe('flooded dip', () => {
  it('spans t 0.5368 to 0.5682 (inclusive) and wraps laps', () => {
    expect(inFloodRange(W, 0.5368)).toBe(true);
    expect(inFloodRange(W, 0.55)).toBe(true);
    expect(inFloodRange(W, 0.5682)).toBe(true);
    expect(inFloodRange(W, 0.536)).toBe(false);
    expect(inFloodRange(W, 0.57)).toBe(false);
    expect(inFloodRange(W, 1.55)).toBe(true);
  });
  it('needs the car to stand low in the dip, not cross the stretch on a bridge', () => {
    expect(inFlood(W, 0.55, -2.4, 1)).toBe(true);
    expect(inFlood(W, 0.55, 8, 1)).toBe(false);
    expect(inFlood(W, 0.3, -2.4, 1)).toBe(false);
  });
});
