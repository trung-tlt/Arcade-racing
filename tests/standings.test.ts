import { describe, expect, it } from 'vitest';
import { type CarRaceView, effectiveT, rankCars, rubberBandSignal } from '../src/race/Standings';

const v = (id: string, o: Partial<CarRaceView>): CarRaceView => ({
  id,
  lap: 1,
  t: 0,
  nextGateT: 0.088,
  checkpointsPassed: 0,
  finished: false,
  finishTimeSec: null,
  ...o,
});

describe('standings', () => {
  it('ranks a staged grid by distance behind the line, pole first', () => {
    const grid = [v('pole', { t: 1 - 8 / 2400 }), v('p2', { t: 1 - 16 / 2400 }), v('p6', { t: 1 - 48 / 2400 })];
    expect(rankCars([...grid].reverse())).toEqual(['pole', 'p2', 'p6']);
  });
  it('a car that has crossed the line beats the staged grid', () => {
    const cars = [v('staged', { t: 0.995 }), v('away', { t: 0.004, checkpointsPassed: 0 })];
    expect(rankCars(cars)).toEqual(['away', 'staged']);
  });
  it('uses lap then t then distance to next gate; finished cars first by finish time', () => {
    const cars = [
      v('l2', { lap: 2, t: 0.1, checkpointsPassed: 1 }),
      v('l1', { lap: 1, t: 0.9, checkpointsPassed: 8 }),
      v('fin', { lap: 3, t: 0.99, finished: true, finishTimeSec: 200, checkpointsPassed: 8 }),
      v('fin2', { lap: 3, t: 0.99, finished: true, finishTimeSec: 190, checkpointsPassed: 8 }),
    ];
    expect(rankCars(cars)).toEqual(['fin2', 'fin', 'l2', 'l1']);
  });
  it('effectiveT only shifts lap-1 cars that have not passed a checkpoint', () => {
    expect(effectiveT({ lap: 1, t: 0.99, checkpointsPassed: 0 })).toBeCloseTo(-0.01);
    expect(effectiveT({ lap: 1, t: 0.99, checkpointsPassed: 3 })).toBe(0.99);
    expect(effectiveT({ lap: 2, t: 0.99, checkpointsPassed: 0 })).toBe(0.99);
  });
  it('rubber-band signal is clamped and signed', () => {
    expect(rubberBandSignal(1.0, 1.1, 0.05)).toBe(1);
    expect(rubberBandSignal(1.1, 1.0, 0.05)).toBe(-1);
    expect(rubberBandSignal(1.0, 1.0, 0.05)).toBe(0);
  });
});
