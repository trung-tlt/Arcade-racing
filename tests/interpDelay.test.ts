import { describe, expect, it } from 'vitest';
import { INTERP_DELAY_SEC, OnlineSession } from '../src/net/OnlineSession';
import type { ServerMsg } from '../src/shared/protocol';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
const snap = (tick: number): Snap =>
  ({ t: 'snap', tick, time: tick / 60, ack: tick + 4, late: 0, cars: [], ev: [], rk: [], pk: [] }) as unknown as Snap;

/** Feed `n` snapshots 20 Hz apart on the server, arriving after `gap(i)` seconds each. */
function run(gap: (i: number) => number, n: number): OnlineSession {
  const s = new OnlineSession('p1');
  let now = 0;
  for (let i = 0; i < n; i++) {
    now += gap(i);
    s.onSnapshot(snap(i * 3), now);
  }
  return s;
}

describe('adaptive interpolation delay', () => {
  it('stays at the base delay on a steady link', () => {
    expect(run(() => 0.05, 300).interpDelay).toBeCloseTo(INTERP_DELAY_SEC, 6);
  });

  it('grows with jitter, never past the cap', () => {
    const jittery = run((i) => (i % 5 === 0 ? 0.16 : 0.03), 400);
    expect(jittery.interpDelay).toBeGreaterThan(0.17);
    expect(jittery.interpDelay).toBeLessThanOrEqual(0.3);
    const awful = run((i) => (i % 3 === 0 ? 0.6 : 0.01), 600);
    expect(awful.interpDelay).toBe(0.3);
  });

  it('comes back down slowly once the link settles', () => {
    const s = run((i) => (i < 200 ? (i % 4 === 0 ? 0.2 : 0.03) : 0.05), 260);
    expect(s.interpDelay).toBeGreaterThan(INTERP_DELAY_SEC);
    const settled = run((i) => (i < 200 ? (i % 4 === 0 ? 0.2 : 0.03) : 0.05), 2000);
    expect(settled.interpDelay).toBeCloseTo(INTERP_DELAY_SEC, 3);
  });
});
