import { describe, expect, it } from 'vitest';
import { OnlineSession } from '../src/net/OnlineSession';
import type { ReconcileBody } from '../src/net/Reconciler';
import type { ServerMsg } from '../src/shared/protocol';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
const body: ReconcileBody = { read: (o) => void (o.p = [0, 0, 0]), nudge: () => undefined, set: () => undefined };
const car = { id: 'p1', p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], hp: 100, nb: 0, rs: 0 };
/** `ack`: the newest input tick the server accepted (it stops moving when our frames are too far ahead). */
const snap = (tick: number, ack: number): Snap =>
  ({ t: 'snap', tick, time: tick / 60, ack, late: 0, cars: [car], ev: [], rk: [], pk: [] }) as unknown as Snap;

function ahead(localTick: number): OnlineSession {
  const s = new OnlineSession('p1');
  s.setBody(body);
  for (let t = 1; t <= localTick; t++) s.afterStep(t);
  return s;
}

/** Steps the session would run over `frames` render frames. */
const stepsOver = (s: OnlineSession, frames: number): number => {
  let n = 0;
  for (let i = 0; i < frames; i++) n += s.planSteps();
  return n;
};

describe('lead controller: no runaway when the server stops acking', () => {
  it('a client far ahead of the server holds back even though the acks (stuck) read as "behind"', () => {
    const s = ahead(1000);
    // The server is at tick 100; our frames were refused for being too far ahead, so the ack is stuck at 50.
    for (let k = 0; k < 40; k++) s.onSnapshot(snap(100 + k * 3, 50), 1 + k * 0.05);
    // Held: over the next 200 frames far fewer than 200 steps run (it is waiting for the server to catch up).
    expect(stepsOver(s, 200)).toBeLessThan(120);
  });

  it('never asks for a catch-up that would put it past the point the server accepts', () => {
    const s = ahead(60);
    // Behind by margin (ack far below the server tick) but only 60 ticks of lead: a 600-tick catch-up must not happen.
    for (let k = 0; k < 40; k++) s.onSnapshot(snap(10, -1 + 0), 1 + k * 0.05);
    expect(stepsOver(s, 50)).toBeLessThan(50 + 80);
  });

  it('a client in the normal band is left alone', () => {
    const s = ahead(130);
    for (let k = 0; k < 40; k++) s.onSnapshot(snap(100, 112), 1 + k * 0.05);
    expect(stepsOver(s, 100)).toBe(100);
  });
});
