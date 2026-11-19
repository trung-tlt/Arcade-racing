import { describe, expect, it } from 'vitest';
import { PHAM_VAN_DONG, type WeatherDef } from '../src/core/Data';
import { rainIntensityAt, rainParticleCount, visibleRainCount } from '../src/weather/rainConfig';

const W = PHAM_VAN_DONG.weather as WeatherDef;

describe('Map 4 weather data', () => {
  it('only Map 4 has a weather block', () => {
    expect(W).not.toBeNull();
    expect(W.rain.intensity).toEqual([0.9, 0.6]);
  });
});

describe('rain by lap and device', () => {
  it('uses the lap intensity and holds the last value for later laps', () => {
    expect(rainIntensityAt(W, 0)).toBe(0.9);
    expect(rainIntensityAt(W, 1)).toBe(0.6);
    expect(rainIntensityAt(W, 4)).toBe(0.6);
    expect(rainIntensityAt(W, -1)).toBe(0.9);
  });
  it('clamps intensity to 0..1', () => {
    const d = { ...W, rain: { ...W.rain, intensity: [3, -2] } };
    expect(rainIntensityAt(d, 0)).toBe(1);
    expect(rainIntensityAt(d, 1)).toBe(0);
  });
  it('picks 6000 particles on desktop and 1500 on phones or the Low preset', () => {
    expect(rainParticleCount(W, false)).toBe(6000);
    expect(rainParticleCount(W, true)).toBe(1500);
  });
  it('shows a share of the particles that follows the intensity', () => {
    expect(visibleRainCount(6000, 0.9)).toBe(5400);
    expect(visibleRainCount(6000, 0.6)).toBe(3600);
    expect(visibleRainCount(6000, 2)).toBe(6000);
    expect(visibleRainCount(6000, 0)).toBe(0);
  });
});
