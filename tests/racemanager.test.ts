import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/Events';
import { RaceManager } from '../src/race/RaceManager';
import { formatTime } from '../src/ui/format';

const CPS = [0.1, 0.25, 0.4, 0.5, 0.6, 0.7, 0.8, 0.94];
const make = (laps = 3) => {
  const events = new EventBus();
  const log: string[] = [];
  events.on('checkpoint', (e) => log.push(`cp${e.index}`));
  events.on('lapComplete', (e) => log.push(`lap${e.lap}`));
  events.on('raceFinished', () => log.push('finish'));
  const r = new RaceManager(
    { carId: 'p', totalLaps: laps, checkpointTs: CPS, countdownSteps: 3, countdownStepSec: 1, goHoldSec: 1 },
    events,
  );
  r.restart(0.99);
  return { r, log };
};
/** Advance the car by `steps` increments of 0.01 along the loop, one 60 Hz tick each. */
function drive(r: RaceManager, from: number, steps: number): number {
  let t = from;
  for (let i = 0; i < steps && r.phase !== 'finished'; i++) {
    t = Math.round(((t + 0.01) % 1) * 100) / 100;
    r.update(1 / 60, t);
  }
  return t;
}

describe('RaceManager', () => {
  it('counts down 3-2-1 then GO and locks controls until then', () => {
    const { r } = make();
    expect(r.controlsLocked).toBe(true);
    expect(r.countdownValue).toBe(3);
    for (let i = 0; i < 61; i++) r.update(1 / 60, 0.99);
    expect(r.countdownValue).toBe(2);
    for (let i = 0; i < 125; i++) r.update(1 / 60, 0.99);
    expect(r.phase).toBe('racing');
    expect(r.controlsLocked).toBe(false);
    expect(r.countdownValue).toBe(0);
  });
  it('does not run the clock or count laps during the countdown', () => {
    const { r, log } = make();
    r.update(0.5, 0.05);
    r.update(0.5, 0.15);
    expect(r.timeSec).toBe(0);
    expect(log).toEqual([]);
  });
  it('finishes a 3-lap race with checkpoints in order', () => {
    const { r, log } = make();
    for (let i = 0; i < 200; i++) r.update(1 / 60, 0.99);
    expect(r.phase).toBe('racing');
    drive(r, 0.99, 400);
    expect(r.phase).toBe('finished');
    expect(log.filter((l) => l === 'finish')).toHaveLength(1);
    expect(r.laps.lapTimes).toHaveLength(3);
    expect(log.filter((l) => l.startsWith('cp'))).toHaveLength(24);
  });
  it('skipping checkpoints (teleport) voids the lap', () => {
    const { r } = make();
    for (let i = 0; i < 200; i++) r.update(1 / 60, 0.99);
    let t = drive(r, 0.99, 30); // crosses cp0, cp1 (t = 0.29)
    r.update(1 / 60, 0.6); // jump > 0.25 of the loop: ignored
    t = drive(r, 0.6, 45); // 0.6 -> 0.05, passes the start line with checkpoints missing
    expect(t).toBeCloseTo(0.05, 5);
    expect(r.laps.lapTimes).toHaveLength(0);
    expect(r.laps.lap).toBe(1);
  });
  it('respawns at the last checkpoint, or the start line', () => {
    const { r } = make();
    expect(r.respawnT).toBe(0);
    for (let i = 0; i < 200; i++) r.update(1 / 60, 0.0);
    r.update(1 / 60, 0.05);
    r.update(1 / 60, 0.11);
    expect(r.respawnT).toBe(0.1);
  });
});

describe('formatTime', () => {
  it('formats m:ss.mmm', () => {
    expect(formatTime(64.912)).toBe('1:04.912');
    expect(formatTime(0)).toBe('0:00.000');
    expect(formatTime(null)).toBe('--:--.---');
  });
});
