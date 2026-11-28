import { describe, expect, it } from 'vitest';
import { ALL_TRACKS } from '../src/core/Data';
import { runHeadlessRace } from '../src/sim/HeadlessRace';

const pct = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)];
const f = (v: number | null | undefined): string => (v == null ? '-' : v.toFixed(1));

describe('headless AI race (no three.js, no DOM)', () => {
  for (const def of ALL_TRACKS) {
    for (const holdFire of [true, false]) {
      it(`${def.id}${holdFire ? ' (fire held)' : ' (full combat)'}: six cars finish one lap`, async () => {
        const r = await runHeadlessRace({ trackId: def.id, laps: 1, holdFire });
        const mean = r.stepMs.reduce((a, b) => a + b, 0) / r.stepMs.length;
        console.log(
          `HEADLESS ${def.id}${holdFire ? ' hold' : ' fight'} order=${r.order.join(',')} sim=${r.simSec.toFixed(0)}s ` +
            `step mean=${mean.toFixed(2)}ms p99=${pct(r.stepMs, 0.99).toFixed(2)}ms ` +
            `wrecks=${JSON.stringify(r.wrecks)} finish=${Object.values(r.finishSec).map(f).join('/')}`,
        );
        expect(r.order).toHaveLength(6);
        expect(Object.values(r.finishSec).every((v) => v !== null)).toBe(true);
      }, 120_000);
    }
  }
});
