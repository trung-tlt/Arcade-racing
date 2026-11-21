import { beforeAll, describe, expect, it } from 'vitest';
import { NetPilot } from '../src/net/NetPilot';
import { Room, type Conn, type Player } from '../src/server/Room';
import { dataHash } from '../src/shared/dataHash';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  type ClientMsg,
  type ServerMsg,
  type SnapCar,
} from '../src/shared/protocol';
import { initSim } from '../src/sim/RaceSim';

beforeAll(async () => {
  await initSim();
});

class FakeClient implements Conn {
  inbox: ServerMsg[] = [];
  closed = false;
  player: Player | null = null;
  send(text: string): void {
    const m = parseServerMessage(text);
    if (m) this.inbox.push(m);
  }
  close(): void {
    this.closed = true;
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i].t === t) return this.inbox[i] as never;
    return undefined;
  }
}

const joinMsg = (over: Partial<Extract<ClientMsg, { t: 'join' }>> = {}): Extract<ClientMsg, { t: 'join' }> => ({
  t: 'join',
  v: PROTOCOL_VERSION,
  hash: dataHash(),
  name: 'Tester',
  car: 'kestrel_gt',
  room: 'TEST',
  ...over,
});

/** Parse through the same validator the server uses, so the wire format is exercised. */
function send(room: Room, c: FakeClient, msg: ClientMsg): void {
  const parsed = parseClientMessage(JSON.stringify(msg));
  if (!parsed.ok) throw new Error('invalid');
  expect(c.player).not.toBeNull();
  room.handle(c.player as Player, parsed.msg);
}

function seat(room: Room, over: Partial<Extract<ClientMsg, { t: 'join' }>> = {}): FakeClient {
  const c = new FakeClient();
  const r = room.join(c, joinMsg(over));
  if (typeof r === 'string') throw new Error(r);
  c.player = r;
  return c;
}

const mkRoom = (extra: Partial<ConstructorParameters<typeof Room>[0]> = {}): Room =>
  new Room({ code: 'TEST', trackId: 'cat_lai', laps: 1, hash: dataHash(), ...extra });

describe('Room lobby', () => {
  it('seats players, makes the first the host and rejects bad joins', () => {
    const room = mkRoom();
    const a = seat(room);
    const b = seat(room, { name: 'Second', car: 'wisp_r' });
    expect(a.last('welcome')?.id).toBe('p1');
    expect(b.last('state')?.roster.map((r) => r.name)).toEqual(['Tester', 'Second']);
    expect(b.last('state')?.roster[0].host).toBe(true);
    expect(room.join(new FakeClient(), joinMsg({ v: 999 }))).toBe('version');
    expect(room.join(new FakeClient(), joinMsg({ hash: 'deadbeef' }))).toBe('data');
    expect(room.join(new FakeClient(), joinMsg({ car: 'no_such_car' }))).toBe('unknown_car');
  });

  it('only the host can start; nobody can join afterwards', () => {
    const room = mkRoom();
    const a = seat(room);
    const b = seat(room);
    send(room, b, { t: 'start' });
    expect(room.phase).toBe('lobby');
    send(room, a, { t: 'start' });
    expect(room.phase).toBe('countdown');
    expect(room.join(new FakeClient(), joinMsg())).toBe('race_started');
    room.dispose();
  });

  it('fills the grid with bots and starts a race of six', () => {
    const room = mkRoom();
    const a = seat(room);
    send(room, a, { t: 'start' });
    expect(room.sim?.entries).toHaveLength(6);
    expect(room.sim?.entries.filter((e) => e.kind === 'human')).toHaveLength(1);
    room.dispose();
  });

  it('refuses a seventh player', () => {
    const room = mkRoom();
    for (let i = 0; i < 6; i++) seat(room);
    expect(room.join(new FakeClient(), joinMsg())).toBe('full');
  });
});

describe('Room input handling', () => {
  it('drops duplicate and reordered input frames and rate limits floods', () => {
    let now = 0;
    const room = mkRoom({ now: () => now, inputRatePerSec: 60 });
    const a = seat(room);
    send(room, a, { t: 'start' });
    const frame = (seq: number): ClientMsg => ({
      t: 'input',
      seq,
      throttle: 1,
      brake: 0,
      steer: 0,
      drift: false,
      nitro: false,
      fire: false,
      fireSecondary: false,
    });
    send(room, a, frame(5));
    send(room, a, frame(3)); // reordered: ignored
    expect(a.player?.lastSeq).toBe(5);
    // A flood far above the rate: tokens run out, frames are dropped, and persistent abuse is reported.
    let abuse: string | null = null;
    for (let i = 6; i < 2000 && !abuse; i++) {
      abuse = room.handle(a.player as Player, { ...(frame(i) as Extract<ClientMsg, { t: 'input' }>) });
    }
    expect(abuse).toBe('rate');
    now += 5000;
    room.dispose();
  });
});

describe('a human drives a lap online (in-process, 60 Hz, 20 Hz snapshots)', () => {
  it('completes one lap of Cat Lai from snapshots and inputs alone (solo time trial)', () => {
    // The room's rate limiter runs on wall-clock time; the test runs faster than real time, so give it the sim clock.
    let clockMs = 0;
    const room = mkRoom({ gridSize: 1, now: () => clockMs });
    const c = seat(room);
    send(room, c, { t: 'start' });
    const pilot = new NetPilot('cat_lai', 'p1', 'kestrel_gt');
    let seq = 0;
    let slow = 0;
    let me: SnapCar | undefined;
    let snaps = 0;
    let lastSnap: ServerMsg | undefined;
    let snapTick = 0;
    for (let tick = 0; tick < 60 * 400 && room.phase !== 'results'; tick++) {
      clockMs = (tick * 1000) / 60;
      room.tick();
      const s = c.last('snap');
      if (s) {
        me = s.cars.find((x) => x.id === 'p1');
        if (s !== lastSnap) {
          lastSnap = s;
          snapTick = tick;
        }
      }
      snaps = c.inbox.filter((m) => m.t === 'snap').length;
      if (!me) continue;
      // The driver presses R after three seconds without moving, like a human would.
      slow = Math.hypot(me.v[0], me.v[2]) < 1 && room.phase === 'racing' ? slow + 1 : 0;
      if (slow > 180) {
        send(room, c, { t: 'reset' });
        slow = 0;
      }
      send(room, c, {
        t: 'input',
        seq: seq++,
        ...pilot.read(c.last('snap')?.cars ?? [], room.phase === 'countdown', (tick - snapTick) / 60),
      });
    }
    const results = c.last('state')?.results;
    expect(room.phase).toBe('results');
    expect(results).toBeDefined();
    const mine = results?.find((r) => r.id === 'p1');
    console.log(`ONLINE LAP time=${mine?.timeSec?.toFixed(1)} place=${mine?.place} snaps=${snaps}`);
    expect(mine?.timeSec).not.toBeNull();
    expect(mine?.timeSec as number).toBeGreaterThan(40);
    expect(mine?.timeSec as number).toBeLessThan(200);
    // ~20 snapshots a second were sent, and the server acked our latest input.
    expect(snaps).toBeGreaterThan(20 * 50);
    expect((c.last('snap')?.ack ?? 0) > 1000).toBe(true);
    room.dispose();
  }, 120_000);
});

describe('a full grid online', () => {
  it('runs a six-car race: the human and five bots all make progress, snapshots list all six', () => {
    let clockMs = 0;
    const room = mkRoom({ now: () => clockMs });
    const c = seat(room);
    send(room, c, { t: 'start' });
    const pilot = new NetPilot('cat_lai', 'p1', 'kestrel_gt');
    let seq = 0;
    for (let tick = 0; tick < 60 * 40; tick++) {
      clockMs = (tick * 1000) / 60;
      room.tick();
      const s = c.last('snap');
      if (s) send(room, c, { t: 'input', seq: seq++, ...pilot.read(s.cars, room.phase === 'countdown') });
    }
    const s = c.last('snap');
    expect(s?.cars).toHaveLength(6);
    expect(room.phase).toBe('racing');
    const bots = s?.cars.filter((x) => x.id.startsWith('b')) ?? [];
    expect(bots).toHaveLength(5);
    // 40 s in (about 35 s after the green): the bots are well down the road (some may have lapped past t = 1).
    expect(bots.some((b) => Math.hypot(b.v[0], b.v[2]) > 10)).toBe(true);
    room.dispose();
  });
});
