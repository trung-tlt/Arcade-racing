import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { engineState } from '../src/audio/Rpm';
import { AUDIO } from '../src/core/Data';

describe('engineState', () => {
  it('idles at standstill and revs within each gear', () => {
    expect(engineState(0, 80, 6, 0.12, 0.35)).toEqual({ gear: 1, rpm: 0.35 });
    const a = engineState(10, 80, 6, 0.12, 0.35);
    const b = engineState(13, 80, 6, 0.12, 0.35);
    expect(a.gear).toBe(1);
    expect(b.gear).toBe(1);
    expect(b.rpm).toBeGreaterThan(a.rpm);
  });
  it('shifts up and drops revs, caps at top gear', () => {
    const before = engineState(13.2, 80, 6, 0.12, 0.35);
    const after = engineState(13.5, 80, 6, 0.12, 0.35);
    expect(after.gear).toBe(before.gear + 1);
    expect(after.rpm).toBeLessThan(before.rpm);
    expect(engineState(999, 80, 6, 0.12, 0.35).gear).toBe(6);
  });
});

describe('audio data', () => {
  it('every referenced file exists under public/assets', () => {
    const files = [
      AUDIO.engine.file,
      AUDIO.skid.file,
      ...Object.values(AUDIO.layers).map((l) => l.file),
      ...Object.values(AUDIO.oneShots).map((o) => o.file),
    ];
    for (const f of files) expect(existsSync(`public/assets/${f}`), f).toBe(true);
  });
  it('layer regions are valid (start < end ≤ 10 s)', () => {
    for (const l of Object.values(AUDIO.layers)) {
      expect(l.start).toBeLessThan(l.end);
      expect(l.end).toBeLessThanOrEqual(10);
      expect(l.fade * 2).toBeLessThan(l.end - l.start);
    }
  });
});
