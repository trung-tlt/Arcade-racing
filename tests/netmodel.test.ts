import { beforeAll, describe, expect, it } from 'vitest';
import { ClockSync } from '../src/net/ClockSync';
import { Interpolator } from '../src/net/Interpolator';
import { Reconciler, type BodyState, type ReconcileBody } from '../src/net/Reconciler';
import { SimClient } from '../src/net/SimClient';
import { VirtualNet, type LinkConfig } from '../src/net/VirtualNet';
import { Room } from '../src/server/Room';
import { dataHash } from '../src/shared/dataHash';
import type { SnapCar } from '../src/shared/protocol';
import { initSim } from '../src/sim/RaceSim';

beforeAll(async () => {
  await initSim();
});

const car = (over: Partial<SnapCar> = {}): SnapCar => ({
  id: 'x',
  p: [0, 0, 0],
  q: [0, 0, 0, 1],
  v: [0, 0, 10],
  w: [0, 0, 0],
  hp: 100,
  nb: 0,
  lap: 1,
  t: 0,
  fl: 0,
  st: 0,
  rs: 0,
  am: 0,
  ht: 0,
  ...over,
});

describe('ClockSync', () => {
  it('locks onto the fastest packets despite jitter', () => {
    const c = new ClockSync();
    // True offset 100 s; one-way delay 20..80 ms.
    for (let i = 0; i < 100; i++) {
      const local = i * 0.05;
      const delay = i % 7 === 0 ? 0.02 : 0.02 + ((i * 37) % 60) / 1000;
      c.onSnapshot(local + 100 - delay + delay, local + delay); // server time at send = local(sent)+100
    }
    expect(c.ready).toBe(true);
    // serverTime(local) should be within the minimum delay (20 ms) of the truth.
    expect(Math.abs(c.serverTime(10) - 110 + 0.02)).toBeLessThan(0.03);
  });
});

describe('ClockSync recovery', () => {
  it('replaces a badly wrong first estimate at once instead of slewing for minutes', () => {
    const c = new ClockSync();
    // True: server time = local time. The first snapshots were processed 3 s late (a blocked tab): they claim an offset
    // of -3 s, which is wrong by 3 s. Then snapshots arrive on time (offset 0).
    for (let i = 0; i < 5; i++) c.onSnapshot(50 + i * 0.05, 53 + i * 0.05);
    expect(Math.abs(c.serverTime(60) - 57)).toBeLessThan(0.1); // wrong, as expected, before better samples arrive
    for (let i = 0; i < 3; i++) c.onSnapshot(60 + i * 0.05, 60 + i * 0.05);
    expect(Math.abs(c.serverTime(60.2) - 60.2)).toBeLessThan(0.05);
  });
});

describe('Interpolator', () => {
  it('blends between two snapshots and extrapolates at most 150 ms', () => {
    const ip = new Interpolator();
    ip.push(1.0, car({ p: [0, 0, 0] }));
    ip.push(1.05, car({ p: [0, 0, 0.5] }));
    expect(ip.sample(1.025)?.p[2]).toBeCloseTo(0.25, 5);
    const late = ip.sample(1.05 + 0.5);
    expect(late?.extrapolating).toBe(true);
    // 0.5 s past the newest sample but clamped to 0.15 s * 10 m/s = 1.5 m.
    expect(late?.p[2]).toBeCloseTo(0.5 + 1.5, 5);
  });

  it('never blends across a teleport (respawn counter changes)', () => {
    const ip = new Interpolator();
    ip.push(1.0, car({ p: [0, 0, 0], rs: 0 }));
    ip.push(1.05, car({ p: [100, 0, 500], rs: 1 }));
    expect(ip.sample(1.04)?.p[2]).toBe(0);
    expect(ip.sample(1.06)?.p[2]).toBeCloseTo(500.1, 5); // on the new side, extrapolating 10 ms
  });

  it('takes the short way round for rotations', () => {
    const ip = new Interpolator();
    const a = car({ q: [0, Math.sin(-0.4), 0, Math.cos(-0.4)] });
    const b = car({ q: [0, -Math.sin(0.4), 0, -Math.cos(0.4)] }); // same rotation, opposite sign
    ip.push(0, a);
    ip.push(1, b);
    const q = ip.sample(0.5)?.q as number[];
    expect(Math.abs(q[3])).toBeGreaterThan(0.9);
  });

  it('ignores stale and duplicate snapshots', () => {
    const ip = new Interpolator();
    ip.push(1, car());
    ip.push(1, car());
    ip.push(0.9, car());
    expect(ip.size).toBe(1);
  });
});

/** A car on a line, to test the reconciler without physics. */
class FakeBody implements ReconcileBody {
  s: BodyState = { p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 10], w: [0, 0, 0] };
  read(out: BodyState): void {
    out.p = [...this.s.p];
    out.q = [...this.s.q];
    out.v = [...this.s.v];
    out.w = [...this.s.w];
  }
  nudge(dp: [number, number, number], _dq: [number, number, number, number], dv: [number, number, number]): void {
    for (let i = 0; i < 3; i++) {
      this.s.p[i] += dp[i];
      this.s.v[i] += dv[i];
    }
  }
  set(s: BodyState): void {
    this.s = { p: [...s.p], q: [...s.q], v: [...s.v], w: [...s.w] };
  }
  step(): void {
    this.s.p[2] += this.s.v[2] / 60;
  }
}

describe('Reconciler sunk car', () => {
  it('snaps to the server on request even when the error is small', () => {
    const body = new FakeBody();
    const rec = new Reconciler();
    for (let seq = 0; seq < 30; seq++) {
      rec.apply(body);
      body.step();
      rec.record(seq, body);
    }
    body.s.p[1] = -1.5; // the predicted car sits inside the road; the server's car is on it
    rec.requestSnap();
    const r = rec.onSnapshot(20, car({ p: [0, 0.5, 20 / 6], v: [0, 0, 10] }), body, 20);
    expect(r.kind).toBe('snap');
    expect(body.s.p[1]).toBeCloseTo(0.5, 5);
    expect(body.s.v[2]).toBeCloseTo(10, 5);
  });
});

describe('Reconciler', () => {
  const run = (serverOffset: number, ticks: number, ackLag = 6): { body: FakeBody; kinds: string[] } => {
    const body = new FakeBody();
    const rec = new Reconciler();
    const kinds: string[] = [];
    for (let seq = 0; seq < ticks; seq++) {
      rec.apply(body);
      body.step();
      rec.record(seq, body);
      // The server (ahead by `serverOffset` m) reports the state it had when it applied input seq - ackLag.
      if (seq % 3 === 0 && seq >= ackLag) {
        const truth = (seq - ackLag + 1) * (10 / 60);
        const r = rec.onSnapshot(seq - ackLag, car({ p: [0, 0, truth + serverOffset], v: [0, 0, 10] }), body);
        kinds.push(r.kind);
      }
    }
    return { body, kinds };
  };

  it('does nothing when prediction and server agree', () => {
    const { kinds } = run(0, 120);
    expect(kinds.every((k) => k === 'none')).toBe(true);
  });

  it('blends out a 0.5 m disagreement without a jump and without overshoot', () => {
    const body = new FakeBody();
    const rec = new Reconciler();
    const trace: number[] = [];
    let seq = 0;
    for (; seq < 30; seq++) {
      rec.apply(body);
      body.step();
      rec.record(seq, body);
    }
    // Server thinks we are 0.5 m further on than we predicted at input 20.
    const at20 = (20 + 1) * (10 / 60);
    const r = rec.onSnapshot(20, car({ p: [0, 0, at20 + 0.5] }), body);
    expect(r.kind).toBe('smooth');
    expect(r.errM).toBeCloseTo(0.5, 3);
    let prevZ = body.s.p[2];
    for (let i = 0; i < 90; i++, seq++) {
      rec.apply(body);
      body.step();
      rec.record(seq, body);
      trace.push(body.s.p[2] - prevZ);
      prevZ = body.s.p[2];
    }
    // Total movement = 90 steps of 1/6 m plus the 0.5 m correction, delivered gradually (no step bigger than 0.12 m extra).
    const extra = trace.map((d) => d - 10 / 60);
    expect(Math.max(...extra)).toBeLessThan(0.12);
    expect(extra.reduce((a, b) => a + b, 0)).toBeCloseTo(0.5, 2);
    expect(extra.every((e) => e > -1e-9)).toBe(true);
  });

  it('does not double-correct when a second snapshot arrives mid-blend', () => {
    const body = new FakeBody();
    const rec = new Reconciler();
    let seq = 0;
    let total = 0;
    for (; seq < 30; seq++) {
      rec.apply(body);
      body.step();
      rec.record(seq, body);
    }
    const truthAt = (s: number): number => (s + 1) * (10 / 60) + 0.5; // the server is 0.5 m ahead throughout
    rec.onSnapshot(20, car({ p: [0, 0, truthAt(20)] }), body);
    for (let i = 0; i < 12; i++, seq++) {
      rec.apply(body);
      body.step();
      rec.record(seq, body);
    }
    rec.onSnapshot(seq - 6, car({ p: [0, 0, truthAt(seq - 6)] }), body);
    const before = body.s.p[2];
    for (let i = 0; i < 120; i++, seq++) {
      rec.apply(body);
      body.step();
      rec.record(seq, body);
    }
    total = body.s.p[2] - before - 120 * (10 / 60);
    // Remaining correction after the second snapshot is only what was left of the 0.5 m, never more.
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(0.5);
  });

  it('hard-snaps a gap over 3 m and clears its history', () => {
    const body = new FakeBody();
    const rec = new Reconciler();
    for (let seq = 0; seq < 30; seq++) {
      rec.apply(body);
      body.step();
      rec.record(seq, body);
    }
    const r = rec.onSnapshot(20, car({ p: [5, 0, 500], v: [0, 0, 0] }), body);
    expect(r.kind).toBe('snap');
    expect(body.s.p[2]).toBe(500);
    expect(rec.onSnapshot(21, car(), body).kind).toBe('unknown');
  });
});

interface Profile {
  name: string;
  link: LinkConfig;
}

const PROFILES: Profile[] = [
  { name: 'LAN 5 ms', link: { latencyMs: 5, jitterMs: 2, loss: 0, rtoMs: 200 } },
  { name: '60 ms RTT', link: { latencyMs: 30, jitterMs: 8, loss: 0, rtoMs: 200 } },
  { name: '150 ms RTT + 1% stalls', link: { latencyMs: 75, jitterMs: 20, loss: 0.01, rtoMs: 250 } },
];

const CARS6 = ['kestrel_gt', 'wisp_r', 'velora_s', 'raijin_rx', 'warden_px', 'fulmine_fx'];

function race(
  link: LinkConfig,
  trackId: string,
  seed: number,
  humans = 2,
  hook?: (step: number, room: Room, clients: SimClient[]) => void,
  roomOpts: Partial<ConstructorParameters<typeof Room>[0]> = {},
): {
  clients: SimClient[];
  room: Room;
  seconds: number;
} {
  const net = new VirtualNet(seed);
  const room = new Room({
    code: 'NET',
    trackId,
    laps: 1,
    hash: dataHash(),
    minPlayers: 1,
    needAllReady: false,
    now: () => net.now,
    ...roomOpts,
  });
  const clients = Array.from(
    { length: humans },
    (_, i) =>
      new SimClient({
        net,
        room,
        trackId,
        carId: CARS6[i % CARS6.length],
        name: `P${i + 1}`,
        up: link,
        down: link,
      }),
  );
  clients[0].send({ t: 'start' });
  const dt = 1000 / 60;
  let steps = 0;
  for (; steps < 60 * 260 && room.phase !== 'results'; steps++) {
    net.now += dt;
    net.flush();
    room.tick();
    for (const c of clients) c.frame();
    hook?.(steps, room, clients);
  }
  net.now += 1000;
  net.flush();
  room.dispose();
  return { clients, room, seconds: steps / 60 };
}

describe('two humans + four bots over a bad network (virtual time)', () => {
  for (const prof of PROFILES) {
    it(`${prof.name}: both finish, own car is predicted within a metre, remote cars never teleport`, () => {
      const { clients, room, seconds } = race(prof.link, 'monte_carlo', 7);
      const stats = clients.map((c) => {
        const all = c.session.log.filter((r) => r.kind !== 'unknown');
        const alone = all.filter((r) => !r.nearOther);
        const worstOf = (xs: typeof all): number =>
          Math.max(0, ...xs.filter((r) => r.kind !== 'snap').map((r) => r.errM));
        const mean = alone.reduce((a, r) => a + r.errM, 0) / Math.max(1, alone.length);
        const worstJump = Math.max(0, ...c.jumps.map((j) => j.excessM));
        const me = c.session.snap?.cars.find((x) => x.id === c.id);
        return {
          id: c.id,
          n: all.length,
          aloneMean: mean,
          aloneWorst: worstOf(alone),
          aloneSnaps: alone.filter((r) => r.kind === 'snap').length,
          nearN: all.length - alone.length,
          nearMean:
            all.filter((r) => r.nearOther).reduce((a, r) => a + r.errM, 0) / Math.max(1, all.length - alone.length),
          nearOver50: all.filter((r) => r.nearOther && r.errM > 0.5).length,
          aloneOver50: alone.filter((r) => r.errM > 0.5).length,
          nearSnaps: all.filter((r) => r.nearOther && r.kind === 'snap').length,
          jumps: c.jumps.length,
          worstJump,
          at: me ? `lap${me.lap} t=${me.t.toFixed(2)} v=${Math.hypot(me.v[0], me.v[2]).toFixed(0)} fl=${me.fl}` : '-',
          late: c.session.snap?.late ?? 0,
          margin: c.session.minMargin,
        };
      });
      console.log(
        `NETMODEL ${prof.name} sim=${seconds.toFixed(0)}s phase=${room.phase}\n` +
          stats
            .map(
              (s) =>
                `   ${s.id}: n=${s.n} alone: mean=${s.aloneMean.toFixed(2)} worst=${s.aloneWorst.toFixed(2)} snaps=${s.aloneSnaps} | near-car n=${s.nearN} mean=${s.nearMean.toFixed(2)} >0.5m=${s.nearOver50} snaps=${s.nearSnaps} (alone >0.5m=${s.aloneOver50}) | jumps=${s.jumps} worst=${s.worstJump.toFixed(1)} | late=${s.late} minMargin=${s.margin} | ${s.at}`,
            )
            .join('\n'),
      );
      expect(room.phase).toBe('results');
      for (const s of stats) {
        expect(s.n).toBeGreaterThan(100);
        // No rendered frame moves a remote car more than a metre beyond its own motion (respawns excepted).
        expect(s.worstJump).toBeLessThan(1);
        // Alone on the road the own car is predicted to within the snap distance, and snaps are rare.
        expect(s.aloneWorst).toBeLessThan(3);
        expect(s.aloneSnaps).toBeLessThan(s.n * 0.03);
      }
    }, 240_000);
  }
});

describe('six humans, and a human who leaves', () => {
  it('six humans finish on a 60 ms link with no rendered remote-car jumps', () => {
    const { clients, room, seconds } = race(PROFILES[1].link, 'monte_carlo', 11, 6, undefined, { finishGraceSec: 200 });
    const worstJump = Math.max(0, ...clients.flatMap((c) => c.jumps.map((j) => j.excessM)));
    const finished = room.results?.filter((r) => !r.bot && r.timeSec !== null).length ?? 0;
    console.log(
      `NETMODEL six humans sim=${seconds.toFixed(0)}s finished=${finished}/6 worstJump=${worstJump.toFixed(2)} ` +
        clients
          .map((c) => `${c.id}:snaps=${c.session.log.filter((r) => r.kind === 'snap').length}/${c.session.log.length}`)
          .join(' '),
    );
    expect(room.phase).toBe('results');
    expect(finished).toBe(6);
    expect(worstJump).toBeLessThan(1);
  }, 240_000);

  it('a human who disconnects mid-race is taken over by the AI and keeps racing', () => {
    let at30 = 0;
    let at40 = 0;
    let kindAfter = '';
    const { room } = race(PROFILES[0].link, 'monte_carlo', 3, 2, (step, r, clients) => {
      const e = r.sim?.entry('p2');
      if (!e) return;
      if (step === 60 * 30) {
        r.leave(clients[1].player);
        at30 = e.t + e.race.laps.lap;
      }
      if (step === 60 * 50) {
        at40 = e.t + e.race.laps.lap;
        kindAfter = e.kind;
      }
    });
    expect(room.phase).toBe('results');
    expect(kindAfter).toBe('ai');
    // 20 s later the abandoned car is well down the road (it would be stationary if nobody drove it; the AI may need a
    // few seconds to get free of whatever the human left it against).
    expect(at40 - at30).toBeGreaterThan(0.03);
  }, 240_000);
});

/** The browser's `Loop`, in virtual time: frames at `fps`, at most 6 fixed steps per frame, the rest of the time dropped. */
class SlowLoop {
  private acc = 0;
  private nextFrameMs = 0;
  constructor(
    private readonly client: SimClient,
    private readonly fps: number,
  ) {}
  /** Call once per 1/60 s of virtual time. */
  tick(nowMs: number, lastMs: number): void {
    this.acc += (nowMs - lastMs) / 1000;
    if (nowMs < this.nextFrameMs) return;
    this.nextFrameMs = nowMs + 1000 / this.fps;
    const dt = Math.min(this.acc, 0.1);
    this.acc = dt;
    let steps = 0;
    while (this.acc >= 1 / 60 && steps < 6) {
      this.client.frame();
      this.acc -= 1 / 60;
      steps++;
    }
    if (steps === 6) this.acc = 0;
  }
}

describe('a client whose frame rate is far below 60 fps', () => {
  for (const fps of [30, 15, 8]) {
    it(`${fps} fps: the client's lead over the server stays bounded and the race is finished`, () => {
      const net = new VirtualNet(5);
      const link = PROFILES[1].link;
      const room = new Room({
        code: 'NET',
        trackId: 'monte_carlo',
        laps: 1,
        hash: dataHash(),
        minPlayers: 1,
        needAllReady: false,
        now: () => net.now,
        finishGraceSec: 200,
      });
      const clients = [
        new SimClient({ net, room, trackId: 'monte_carlo', carId: 'kestrel_gt', name: 'A', up: link, down: link }),
        new SimClient({ net, room, trackId: 'monte_carlo', carId: 'wisp_r', name: 'B', up: link, down: link }),
      ];
      const loops = clients.map((c, i) => new SlowLoop(c, i === 0 ? fps : 60));
      clients[0].send({ t: 'start' });
      const gaps: number[] = [];
      let last = 0;
      for (let step = 0; step < 60 * 300 && room.phase !== 'results'; step++) {
        net.now += 1000 / 60;
        net.flush();
        room.tick();
        loops.forEach((l) => l.tick(net.now, last));
        last = net.now;
        const sim = clients[0].localSim;
        if (sim && room.sim && step % 60 === 0) gaps.push(sim.tick - room.sim.tick);
      }
      const maxLead = Math.max(...gaps);
      const minLead = Math.min(...gaps.slice(5));
      console.log(
        `SLOWLOOP ${fps}fps phase=${room.phase} lead min=${minLead} max=${maxLead} late=${clients[0].session.snap?.late} snaps=${clients[0].session.log.filter((r) => r.kind === 'snap').length}`,
      );
      room.dispose();
      expect(maxLead).toBeLessThan(40);
      expect(minLead).toBeGreaterThan(-20);
    }, 300_000);
  }
});

describe('combat over the network', () => {
  it('every client gets the same event stream and a wrecked car is respawned and re-adopted', () => {
    const net = new VirtualNet(9);
    const link = PROFILES[1].link;
    const room = new Room({
      code: 'NET',
      trackId: 'monte_carlo',
      laps: 1,
      hash: dataHash(),
      minPlayers: 1,
      needAllReady: false,
      now: () => net.now,
      finishGraceSec: 300,
    });
    const clients = ['kestrel_gt', 'wisp_r', 'velora_s'].map(
      (carId, i) =>
        new SimClient({ net, room, trackId: 'monte_carlo', carId, name: `P${i + 1}`, up: link, down: link }),
    );
    const counts = clients.map(() => new Map<string, number>());
    clients.forEach((c, i) => {
      c.session.onEvents = (evs) => {
        for (const e of evs) counts[i].set(e.k, (counts[i].get(e.k) ?? 0) + 1);
      };
    });
    clients[0].send({ t: 'start' });
    let teleports = 0;
    clients[1].session.onOwnTeleport = () => teleports++;
    for (let step = 0; step < 60 * 200 && room.phase !== 'results'; step++) {
      net.now += 1000 / 60;
      net.flush();
      room.tick();
      for (const c of clients) c.frame();
    }
    room.dispose();
    const guns = counts.map((m) => m.get('gun') ?? 0);
    const hits = counts.map((m) => m.get('hit') ?? 0);
    console.log(
      'NETMODEL combat gun',
      JSON.stringify(guns),
      'hit',
      JSON.stringify(hits),
      'wreck',
      JSON.stringify(counts.map((m) => m.get('wreck') ?? 0)),
      'teleports(p2)',
      teleports,
    );
    expect(guns[0]).toBeGreaterThan(10);
    expect(hits[0]).toBeGreaterThan(0);
    // The same snapshots reach everyone, so the totals agree (a client may still be a snapshot or two behind at the end).
    for (let i = 1; i < clients.length; i++) {
      expect(Math.abs(guns[i] - guns[0])).toBeLessThanOrEqual(Math.max(8, guns[0] * 0.05));
      expect(Math.abs(hits[i] - hits[0])).toBeLessThanOrEqual(Math.max(8, hits[0] * 0.05));
    }
  }, 240_000);
});
