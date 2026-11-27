import { beforeAll, describe, expect, it } from 'vitest';
import { RaceSim, initSim } from '../src/sim/RaceSim';
import { parseClientMessage } from '../src/shared/protocol';

beforeAll(async () => {
  await initSim();
});

const frame = (extra: Record<string, unknown>): string =>
  JSON.stringify({ t: 'input', tick: 5, throttle: 1, brake: 0, steer: 0, ...extra });
const pose = { p: [1, 2, 3], q: [0, 0, 0, 1], v: [0, 0, 20], w: [0, 0, 0] };

describe('pose frames (client-authority mode)', () => {
  it('parse with the reset count, clamped; a malformed pose rejects the whole frame', () => {
    const ok = parseClientMessage(frame({ ps: pose, rs: 2 }));
    expect(ok.ok && ok.msg.t === 'input' && ok.msg.ps?.v).toEqual([0, 0, 20]);
    expect(ok.ok && ok.msg.t === 'input' && ok.msg.rs).toBe(2);
    const far = parseClientMessage(frame({ ps: { ...pose, p: [1e9, 0, 0] }, rs: 0 }));
    expect(far.ok && far.msg.t === 'input' && far.msg.ps?.p[0]).toBe(20000);
    expect(parseClientMessage(frame({ ps: { ...pose, q: [0, 0, 1] } })).ok).toBe(false);
    expect(parseClientMessage(frame({ ps: { ...pose, v: [0, 'x', 0] } })).ok).toBe(false);
    expect(parseClientMessage(frame({ ps: 7 })).ok).toBe(false);
  });

  it('a frame without a pose is unchanged', () => {
    const m = parseClientMessage(frame({}));
    expect(m.ok && m.msg.t === 'input' && m.msg.ps).toBeUndefined();
  });
});

describe('RaceSim.setPose', () => {
  it('puts a human car where its client says; other kinds and unknown ids are ignored', () => {
    const sim = new RaceSim({
      trackId: 'cong_hoa',
      laps: 1,
      combat: false,
      traffic: false,
      slots: [
        { id: 'p1', carId: 'kestrel_gt', kind: 'human', gridSlot: 5 },
        { id: 'b1', carId: 'kestrel_gt', kind: 'ai', skill: 0.5, gridSlot: 0 },
      ],
    });
    const p1 = sim.entry('p1')!.car.physics.body;
    const b1 = sim.entry('b1')!.car.physics.body;
    const b1Before = { ...b1.translation() };
    sim.setPose('p1', { p: [10, 3, -20], q: [0, 0, 0, 1], v: [0, 0, 5], w: [0, 0, 0] });
    sim.setPose('b1', { p: [999, 3, 999], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0] });
    sim.setPose('nobody', { p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0] });
    expect(p1.translation().x).toBe(10);
    expect(p1.translation().z).toBe(-20);
    expect(p1.linvel().z).toBe(5);
    expect(b1.translation().x).toBe(b1Before.x);
    sim.dispose();
  });
});
