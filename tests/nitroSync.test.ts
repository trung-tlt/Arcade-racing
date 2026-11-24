import { describe, expect, it } from 'vitest';
import { NitroTank } from '../src/vehicle/Nitro';
import { OnlineSession } from '../src/net/OnlineSession';
import type { ReconcileBody } from '../src/net/Reconciler';
import type { ServerMsg } from '../src/shared/protocol';

type Snap = Extract<ServerMsg, { t: 'snap' }>;

const body: ReconcileBody = { read: (o) => void (o.p = [0, 0, 0]), nudge: () => undefined, set: () => undefined };
const own = (nb: number) => ({ id: 'p1', p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], hp: 100, nb, rs: 0 });
const snap = (tick: number, nb: number): Snap =>
  ({ t: 'snap', tick, time: tick / 60, ack: tick + 6, late: 0, cars: [own(nb)], ev: [], rk: [], pk: [] }) as unknown as Snap;

/** A session whose own tank is stepped `ticks` times, burning `burnPerTick` bars each tick. */
function session(ticks: number, burnPerTick = 0): { s: OnlineSession; tank: NitroTank } {
  const s = new OnlineSession('p1');
  const tank = new NitroTank(3, 1);
  s.setBody(body);
  s.setNitro(tank);
  for (let t = 1; t <= ticks; t++) {
    tank.bars = Math.max(0, tank.bars - burnPerTick);
    s.afterStep(t);
  }
  return { s, tank };
}

describe('own nitro bars follow the server', () => {
  it('adopts bars earned on the server only (a pickup, a takedown)', () => {
    const { s, tank } = session(20);
    s.onSnapshot(snap(10, 1), 1);
    expect(tank.bars).toBeCloseTo(1, 2);
  });

  it('ignores rounding noise and does not apply the same grant twice', () => {
    const { s, tank } = session(30);
    s.onSnapshot(snap(10, 1), 1);
    s.onSnapshot(snap(13, 1.01), 1.05);
    s.onSnapshot(snap(16, 1), 1.1);
    expect(tank.bars).toBeCloseTo(1, 2);
  });

  it('compares like with like when the local tank has been spent since the snapshot tick', () => {
    const { s, tank } = session(0);
    tank.bars = 2;
    for (let t = 1; t <= 20; t++) {
      tank.bars -= 0.02; // burning nitro: local and server agree
      s.afterStep(t);
    }
    // The server, at tick 10, had 2 - 10 * 0.02 = 1.8 bars: no grant, no change.
    const before = tank.bars;
    s.onSnapshot(snap(10, 1.8), 1);
    expect(tank.bars).toBeCloseTo(before, 6);
  });
});
