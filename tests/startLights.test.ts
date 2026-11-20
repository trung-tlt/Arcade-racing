import { describe, expect, it } from 'vitest';
import { RACE, getTrack } from '../src/core/Data';
import { EventBus } from '../src/core/Events';
import { RaceManager } from '../src/race/RaceManager';
import { StartLights } from '../src/race/StartLights';

const cfg = RACE.startLights;
const run = (sl: StartLights, seconds: number, dt = 1 / 60): void => {
  for (let t = 0; t < seconds - 1e-9; t += dt) sl.update(dt);
};

describe('start lights', () => {
  it('data: five lamps, one per second, hold 0.2–3 s, 3 s jump-start penalty', () => {
    expect(cfg.lamps).toBe(5);
    expect(cfg.stepSec).toBe(1);
    expect([cfg.holdMinSec, cfg.holdMaxSec]).toEqual([0.2, 3]);
    expect(cfg.jumpStartPenaltySec).toBe(3);
  });
  it('the Monaco track JSON carries the lights, and other maps have none', () => {
    expect(getTrack('monte_carlo').startLights?.model).toContain('start_gantry');
    expect(getTrack('cat_lai').startLights).toBeNull();
  });
  it('lights one lamp per second, holds, then goes out', () => {
    const sl = new StartLights(cfg, () => 0.5); // hold = 0.2 + 2.8 × 0.5 = 1.6 s
    expect(sl.holdSec).toBeCloseTo(1.6, 6);
    const lit: number[] = [];
    sl.onLit((n) => lit.push(n));
    let go = 0;
    sl.onGo(() => go++);
    run(sl, 0.9);
    expect(sl.lit).toBe(0);
    run(sl, 0.2);
    expect(sl.lit).toBe(1);
    run(sl, 4);
    expect(sl.lit).toBe(5);
    expect(sl.phase).toBe('hold');
    expect(lit).toEqual([1, 2, 3, 4, 5]);
    expect(sl.released).toBe(false);
    run(sl, 1.7);
    expect(sl.phase).toBe('go');
    expect(sl.lit).toBe(0);
    expect(go).toBe(1);
    run(sl, 1);
    expect(go).toBe(1);
    expect(sl.sinceGoSec).toBeGreaterThan(0.9);
  });
  it('the hold is random in range and different per restart', () => {
    const holds = [0, 0.25, 0.5, 0.75, 1].map((r) => new StartLights(cfg, () => r).holdSec);
    expect(holds[0]).toBeCloseTo(0.2, 9);
    expect(holds[4]).toBeCloseTo(3, 9);
    expect(new Set(holds).size).toBe(5);
    let i = 0;
    const seq = [0, 1];
    const sl = new StartLights(cfg, () => seq[i++ % 2]);
    const first = sl.holdSec;
    sl.restart();
    expect(sl.holdSec).not.toBe(first);
    expect(sl.lit).toBe(0);
    expect(sl.phase).toBe('lighting');
  });
  it('a jump start is throttle before lights-out only', () => {
    const sl = new StartLights(cfg, () => 0);
    expect(sl.isJumpStart(0)).toBe(false);
    expect(sl.isJumpStart(1)).toBe(true);
    run(sl, 5.3);
    expect(sl.released).toBe(true);
    expect(sl.isJumpStart(1)).toBe(false);
  });
});

describe('RaceManager with a light-sequence start', () => {
  const make = (): { rm: RaceManager; sl: StartLights } => {
    const sl = new StartLights(cfg, () => 0);
    const rm = new RaceManager(
      {
        carId: 'player',
        totalLaps: 1,
        checkpointTs: [0.5],
        countdownSteps: 3,
        countdownStepSec: 1,
        goHoldSec: 1.2,
        startLights: sl,
        jumpStartPenaltySec: cfg.jumpStartPenaltySec,
      },
      new EventBus(),
    );
    rm.restart(0.99);
    return { rm, sl };
  };
  it('stays locked until the lights go out, then races', () => {
    const { rm, sl } = make();
    expect(rm.usesStartLights).toBe(true);
    for (let i = 0; i < 60 * 3.1; i++) {
      sl.update(1 / 60);
      rm.update(1 / 60, 0.99);
    }
    expect(rm.phase).toBe('countdown');
    expect(rm.controlsLocked).toBe(true);
    expect(rm.startLightsLit).toBe(3);
    expect(rm.countdownValue).toBe(1); // a lamp state, not a 3-2-1 number
    for (let i = 0; i < 60 * 2.5; i++) {
      sl.update(1 / 60);
      rm.update(1 / 60, 0.99);
    }
    expect(rm.phase).toBe('racing');
    expect(rm.countdownValue).toBe(0);
  });
  it('a jump start adds 3 s to the finish time, once', () => {
    const { rm, sl } = make();
    sl.update(2);
    expect(rm.jumpStart(0.05)).toBe(false);
    expect(rm.jumpStart(1)).toBe(true);
    expect(rm.jumpStart(1)).toBe(false);
    expect(rm.penaltySec).toBe(3);
    sl.update(10);
    rm.update(0.1, 0.99);
    expect(rm.phase).toBe('racing');
    expect(rm.jumpStart(1)).toBe(false);
    rm.laps.totalTimeSec; // eslint-disable-line @typescript-eslint/no-unused-expressions
  });
  it('the classic countdown is untouched without lights', () => {
    const rm = new RaceManager(
      { carId: 'p', totalLaps: 1, checkpointTs: [0.5], countdownSteps: 3, countdownStepSec: 1, goHoldSec: 1 },
      new EventBus(),
    );
    rm.restart(0);
    expect(rm.usesStartLights).toBe(false);
    expect(rm.startLightsLit).toBeNull();
    expect(rm.jumpStart(1)).toBe(false);
    expect(rm.countdownValue).toBe(3);
  });
});
