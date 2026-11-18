import { describe, expect, it } from 'vitest';
import { LapTracker } from '../src/race/Laps';
import { crossed, rankEntries, wrapDelta, type RaceEntry } from '../src/race/Positions';
import { gridPose, respawnPose, type TrackSampler } from '../src/race/Respawn';

function fullLap(l: LapTracker, at: number): 'lap' | 'finish' | 'ignored' {
  for (let i = 0; i < 8; i++) expect(l.passCheckpoint(i)).toBe('ok');
  return l.crossStartLine(at);
}

describe('LapTracker', () => {
  it('blocks the lap when a checkpoint is skipped', () => {
    const l = new LapTracker(8, 3);
    l.start(0);
    l.passCheckpoint(0);
    expect(l.passCheckpoint(2)).toBe('wrong-order');
    expect(l.nextCheckpoint).toBe(1);
    expect(l.crossStartLine(30)).toBe('ignored');
    expect(l.lap).toBe(1);
  });
  it('ignores re-passing a checkpoint and tracks the last one', () => {
    const l = new LapTracker(8, 3);
    l.start(0);
    l.passCheckpoint(0);
    l.passCheckpoint(1);
    expect(l.passCheckpoint(0)).toBe('ignored');
    expect(l.lastCheckpoint).toBe(1);
  });
  it('counts a full lap, finishes after 3, and records times', () => {
    const l = new LapTracker(8, 3);
    l.start(0);
    expect(fullLap(l, 70)).toBe('lap');
    expect(l.lap).toBe(2);
    expect(l.lastCheckpoint).toBe(-1);
    expect(fullLap(l, 130)).toBe('lap');
    expect(fullLap(l, 185)).toBe('finish');
    expect(l.finished).toBe(true);
    expect(l.lapTimes).toEqual([70, 60, 55]);
    expect(l.bestLap).toBe(55);
    expect(l.totalTimeSec).toBe(185);
    expect(l.crossStartLine(200)).toBe('ignored');
  });
  it('does not count the start-line crossing at race start', () => {
    const l = new LapTracker(8, 3);
    l.start(0);
    expect(l.crossStartLine(1)).toBe('ignored');
    expect(l.bestLap).toBeNull();
  });
});

describe('rankEntries', () => {
  const e = (id: string, lap: number, t: number, distToNext = 100, extra: Partial<RaceEntry> = {}): RaceEntry => ({
    id,
    lap,
    t,
    distToNext,
    ...extra,
  });
  it('orders by lap + t', () => {
    expect(rankEntries([e('a', 1, 0.9), e('b', 2, 0.1), e('c', 1, 0.95)])).toEqual(['b', 'c', 'a']);
  });
  it('breaks near-equal progress by distance to next checkpoint', () => {
    expect(rankEntries([e('a', 1, 0.5, 80), e('b', 1, 0.5 + 1e-8, 40)])).toEqual(['b', 'a']);
  });
  it('puts finished cars first, by finish time', () => {
    const r = rankEntries([
      e('a', 3, 0.9),
      e('b', 4, 0, 0, { finished: true, finishTime: 200 }),
      e('c', 4, 0, 0, { finished: true, finishTime: 190 }),
    ]);
    expect(r).toEqual(['c', 'b', 'a']);
  });
});

describe('wrapDelta / crossed', () => {
  it('wraps the shortest way round', () => {
    expect(wrapDelta(0.95, 0.05)).toBeCloseTo(0.1, 9);
    expect(wrapDelta(0.05, 0.95)).toBeCloseTo(-0.1, 9);
    expect(wrapDelta(0.2, 0.3)).toBeCloseTo(0.1, 9);
  });
  it('detects forward crossings, including across the wrap', () => {
    expect(crossed(0.48, 0.52, 0.5)).toBe(true);
    expect(crossed(0.98, 0.02, 0)).toBe(true);
    expect(crossed(0.99, 0.01, 0.995)).toBe(true);
  });
  it('rejects backwards motion, misses and big jumps', () => {
    expect(crossed(0.52, 0.48, 0.5)).toBe(false);
    expect(crossed(0.02, 0.98, 0)).toBe(false);
    expect(crossed(0.4, 0.45, 0.5)).toBe(false);
    expect(crossed(0.3, 0.7, 0.5)).toBe(false);
    expect(crossed(0.5, 0.5, 0.5)).toBe(false);
  });
});

function straight(dir: { x: number; z: number }, length = 1000): TrackSampler {
  return {
    pointAt: (t) => ({ x: dir.x * t * length, y: 0, z: dir.z * t * length }),
    tangentAt: () => ({ x: dir.x, y: 0, z: dir.z }),
  };
}

describe('respawnPose', () => {
  it('faces +Z with yaw 0 and puts positive lateral on +X (left)', () => {
    const p = respawnPose(straight({ x: 0, z: 1 }), 0.5, 4);
    expect(p.yaw).toBeCloseTo(0, 9);
    expect(p.x).toBeCloseTo(4, 9);
    expect(p.z).toBeCloseTo(500, 9);
  });
  it('faces +X with yaw π/2 and left is −Z', () => {
    const p = respawnPose(straight({ x: 1, z: 0 }), 0.5, 4);
    expect(p.yaw).toBeCloseTo(Math.PI / 2, 9);
    expect(p.x).toBeCloseTo(500, 9);
    expect(p.z).toBeCloseTo(-4, 9);
  });
  it('gridPose places slots behind t=0 via wrap', () => {
    const p = gridPose(straight({ x: 0, z: 1 }, 2400), -4.5, 8, 2400);
    expect(p.z).toBeCloseTo(2400 - 8, 6);
    expect(p.x).toBeCloseTo(-4.5, 9);
  });
});
