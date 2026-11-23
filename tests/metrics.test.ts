import { describe, expect, it } from 'vitest';
import { SampleWindow, levelEnabled, logLine, parseLogLevel, promText } from '../src/server/metrics';

describe('SampleWindow', () => {
  it('is zero when empty', () => {
    expect(new SampleWindow(4).stats([0.5, 0.99])).toEqual({ q: [0, 0], max: 0, mean: 0 });
  });

  it('gives nearest-rank percentiles, max and mean', () => {
    const w = new SampleWindow(200);
    for (let i = 1; i <= 100; i++) w.push(i);
    const s = w.stats([0.5, 0.99, 1]);
    expect(s.q).toEqual([50, 99, 100]);
    expect(s.max).toBe(100);
    expect(s.mean).toBe(50.5);
  });

  it('keeps only the newest `capacity` samples', () => {
    const w = new SampleWindow(3);
    for (const v of [100, 1, 2, 3]) w.push(v);
    expect(w.size).toBe(3);
    expect(w.stats([1]).max).toBe(3);
  });
});

describe('logging and Prometheus text', () => {
  it('filters by level and falls back to info', () => {
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('nonsense')).toBe('info');
    expect(parseLogLevel(undefined)).toBe('info');
    expect(levelEnabled('info', 'debug')).toBe(false);
    expect(levelEnabled('info', 'warn')).toBe(true);
    expect(levelEnabled('silent', 'error')).toBe(false);
  });

  it('writes one JSON line per event', () => {
    const line = logLine('info', 'room_created', { room: 'ABC' });
    expect(line.includes('\n')).toBe(false);
    expect(JSON.parse(line)).toMatchObject({ level: 'info', event: 'room_created', room: 'ABC' });
  });

  it('renders families with labels', () => {
    const t = promText([
      { name: 'x_total', help: 'h', type: 'counter', values: [{ labels: { reason: 'a"b' }, value: 3 }] },
      { name: 'y', help: 'h', type: 'gauge', values: [{ value: NaN }] },
    ]);
    expect(t).toContain('# TYPE x_total counter');
    expect(t).toContain('x_total{reason="a_b"} 3');
    expect(t).toContain('\ny 0\n');
  });
});
