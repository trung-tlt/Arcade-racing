import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import online from '../data/online_ui.json';
import { NetServer } from '../src/server/NetServer';
import { Room, type Conn, type Player } from '../src/server/Room';
import { dataHash } from '../src/shared/dataHash';
import {
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  cleanRoomCode,
  parseClientMessage,
  parseServerMessage,
  type ClientMsg,
  type RejectReason,
  type ServerMsg,
} from '../src/shared/protocol';
import { initSim, type RaceSim } from '../src/sim/RaceSim';

beforeAll(async () => {
  await initSim();
});

describe('room codes and lobby messages', () => {
  it('match the design data', () => {
    expect(ROOM_CODE_ALPHABET).toBe(online.roomCode.alphabet);
    expect(ROOM_CODE_LENGTH).toBe(online.roomCode.length);
    expect(online.maxPlayers).toBe(6);
  });

  it('cleanRoomCode upper-cases, drops O/0/I/1 and caps at 6', () => {
    expect(cleanRoomCode('vx7·m4q')).toBe('VX7M4Q');
    expect(cleanRoomCode('o0i1abc')).toBe('ABC');
    expect(cleanRoomCode('abcdefghjk')).toBe('ABCDEF');
  });

  const join = { t: 'join', v: PROTOCOL_VERSION, hash: 'abc', name: 'Linh', car: 'kestrel_gt' };

  it('parses the join modes', () => {
    const ok = (o: object) => parseClientMessage(JSON.stringify({ ...join, ...o }));
    expect(ok({ mode: 'create' })).toMatchObject({ ok: true, msg: { mode: 'create', room: '' } });
    expect(ok({ mode: 'quick', room: 'whatever' })).toMatchObject({ ok: true, msg: { mode: 'quick', room: '' } });
    expect(ok({ mode: 'join', room: 'vx7 m4q' })).toMatchObject({ ok: true, msg: { mode: 'join', room: 'VX7M4Q' } });
    expect(ok({ mode: 'teleport', room: 'ABC' }).ok).toBe(false);
    expect(ok({ room: '' }).ok).toBe(false); // the legacy join still needs a room name
  });

  it('validates settings, rematch and the ping rtt', () => {
    const p = (o: object) => parseClientMessage(JSON.stringify(o));
    expect(p({ t: 'settings', track: 'cat_lai', laps: 40 })).toMatchObject({ ok: true, msg: { laps: 9 } });
    expect(p({ t: 'settings', laps: 'x' }).ok).toBe(false);
    expect(p({ t: 'rematch', vote: 'yes' })).toEqual({ ok: true, msg: { t: 'rematch', vote: 'yes' } });
    expect(p({ t: 'rematch', vote: 'none' })).toEqual({ ok: true, msg: { t: 'rematch', vote: 'none' } });
    expect(p({ t: 'rematch', vote: 'lobby' }).ok).toBe(true);
    expect(p({ t: 'rematch', vote: true }).ok).toBe(false); // the old boolean is no longer accepted
    expect(p({ t: 'rematch', vote: 'maybe' }).ok).toBe(false);
    expect(p({ t: 'rematch' }).ok).toBe(false);
    expect(p({ t: 'ping', c: 1, rtt: 99999 })).toMatchObject({ ok: true, msg: { rtt: 5000 } });
    expect(p({ t: 'ping', c: 1, rtt: 'fast' }).ok).toBe(false);
  });
});

class Fake implements Conn {
  inbox: ServerMsg[] = [];
  player: Player | null = null;
  send(text: string): void {
    const m = parseServerMessage(text);
    if (m) this.inbox.push(m);
  }
  close(): void {}
  state(): Extract<ServerMsg, { t: 'state' }> | undefined {
    for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i].t === 'state') return this.inbox[i] as never;
    return undefined;
  }
}

function seat(room: Room, name = 'Tester'): Fake {
  const c = new Fake();
  const r = room.join(c, {
    t: 'join',
    v: PROTOCOL_VERSION,
    hash: dataHash(),
    name,
    car: 'kestrel_gt',
    room: room.code,
  });
  if (typeof r === 'string') throw new Error(r);
  c.player = r;
  return c;
}

function send(room: Room, c: Fake, msg: ClientMsg): void {
  const parsed = parseClientMessage(JSON.stringify(msg));
  if (!parsed.ok) throw new Error('invalid');
  room.handle(c.player as Player, parsed.msg);
}

/** Skip the race: load it, then finish it as if the flag had dropped. */
function toResults(room: Room, clients: Fake[]): void {
  for (const c of clients) send(room, c, { t: 'ready', ready: true });
  send(room, clients[0], { t: 'start' });
  for (const c of clients) send(room, c, { t: 'ready', ready: true }); // loaded
  room.tick();
  (room as unknown as { finish(sim: RaceSim): void }).finish(room.sim as RaceSim);
}

describe('lobby rules', () => {
  it('start needs 2 humans, all ready, and the host', () => {
    const room = new Room({ code: 'ABCDEF', trackId: 'cat_lai', laps: 1, hash: dataHash() });
    const a = seat(room, 'Host');
    send(room, a, { t: 'ready', ready: true });
    send(room, a, { t: 'start' });
    expect(room.phase).toBe('lobby'); // alone
    const b = seat(room, 'Guest');
    send(room, a, { t: 'start' });
    expect(room.phase).toBe('lobby'); // guest not ready
    send(room, b, { t: 'ready', ready: true });
    send(room, b, { t: 'start' });
    expect(room.phase).toBe('lobby'); // not the host
    send(room, a, { t: 'start' });
    expect(room.phase).toBe('loading');
    room.dispose();
  });

  it('only the host changes track and laps, and that clears everyone ready', () => {
    const room = new Room({ code: 'ABCDEF', trackId: 'cat_lai', laps: 3, hash: dataHash() });
    const a = seat(room);
    const b = seat(room);
    send(room, a, { t: 'ready', ready: true });
    send(room, b, { t: 'settings', laps: 5 });
    expect(room.laps).toBe(3);
    expect(a.player?.ready).toBe(true);
    send(room, a, { t: 'settings', track: 'monte_carlo', laps: 5 });
    expect(room.laps).toBe(5);
    expect(room.trackId).toBe('monte_carlo');
    expect(a.player?.ready).toBe(false);
    send(room, a, { t: 'settings', track: 'no_such_map' });
    expect(room.trackId).toBe('monte_carlo');
    expect(b.state()?.track).toBe('monte_carlo');
  });

  it('hands the host to the lowest slot when the host leaves', () => {
    const room = new Room({ code: 'ABCDEF', trackId: 'cat_lai', laps: 1, hash: dataHash() });
    const a = seat(room);
    const b = seat(room);
    const c = seat(room);
    room.leave(a.player as Player);
    expect(b.state()?.roster.map((r) => [r.id, r.host])).toEqual([
      ['p2', true],
      ['p3', false],
    ]);
    room.leave(b.player as Player);
    expect(c.state()?.roster[0].host).toBe(true);
  });

  it('reports each player ping in the roster', () => {
    const room = new Room({ code: 'ABCDEF', trackId: 'cat_lai', laps: 1, hash: dataHash() });
    const a = seat(room);
    const b = seat(room);
    send(room, a, { t: 'ping', c: 1, rtt: 42.4 });
    send(room, b, { t: 'ready', ready: true }); // any broadcast
    expect(b.state()?.roster.map((r) => r.ping)).toEqual([42, -1]);
  });

  it('re-sends the lobby every two seconds so pings stay fresh', () => {
    const room = new Room({ code: 'ABCDEF', trackId: 'cat_lai', laps: 1, hash: dataHash() });
    const a = seat(room);
    const before = a.inbox.filter((m) => m.t === 'state').length;
    for (let i = 0; i < 119; i++) room.tick();
    expect(a.inbox.filter((m) => m.t === 'state').length).toBe(before);
    room.tick();
    expect(a.inbox.filter((m) => m.t === 'state').length).toBe(before + 1);
  });

  it('is open for quick match only while public, in the lobby and not full', () => {
    const room = new Room({ code: 'ABCDEF', trackId: 'cat_lai', laps: 1, hash: dataHash(), isPublic: true });
    expect(room.open).toBe(true);
    for (let i = 0; i < 6; i++) seat(room);
    expect(room.open).toBe(false);
    const priv = new Room({ code: 'GHJKLM', trackId: 'cat_lai', laps: 1, hash: dataHash() });
    expect(priv.open).toBe(false);
  });
});

describe('results and rematch', () => {
  const mk = (now: () => number): { room: Room; a: Fake; b: Fake } => {
    const room = new Room({ code: 'ABCDEF', trackId: 'cat_lai', laps: 1, hash: dataHash(), now, rematchSec: 30 });
    const a = seat(room, 'Host');
    const b = seat(room, 'Guest');
    toResults(room, [a, b]);
    return { room, a, b };
  };

  it('lists the rows with car, takedowns and the rematch vote', () => {
    const { room, a } = mk(() => 0);
    const st = a.state();
    expect(room.phase).toBe('results');
    expect(st?.results).toHaveLength(6);
    expect(st?.results?.[0]).toMatchObject({ takedowns: expect.any(Number), leftLap: null });
    expect(st?.results?.every((r) => r.car.length > 0)).toBe(true);
    expect(st?.rematch).toEqual({ yes: [], no: [], secLeft: 30 });
    room.dispose();
  });

  it('everyone voting yes loads the same race again with the room ready', () => {
    const { room, a, b } = mk(() => 0);
    send(room, a, { t: 'rematch', vote: 'yes' });
    expect(room.phase).toBe('results');
    expect(a.state()?.rematch?.yes).toEqual(['p1']);
    send(room, b, { t: 'rematch', vote: 'yes' });
    expect(room.phase).toBe('loading');
    expect(room.trackId).toBe('cat_lai');
    expect(room.results).toBeNull();
    room.dispose();
  });

  it('withdrawing a vote clears it, and a cleared vote counts as no vote', () => {
    const { room, a, b } = mk(() => 0);
    send(room, a, { t: 'rematch', vote: 'yes' });
    expect(a.state()?.rematch?.yes).toEqual(['p1']);
    send(room, a, { t: 'rematch', vote: 'none' });
    expect(a.state()?.rematch).toMatchObject({ yes: [], no: [] });
    // b alone voting yes must not start the race: a has no vote.
    send(room, b, { t: 'rematch', vote: 'yes' });
    expect(room.phase).toBe('results');
    // A withdrawn lobby request is not a lobby request either.
    send(room, a, { t: 'rematch', vote: 'lobby' });
    expect(room.phase).toBe('lobby');
    room.dispose();
  });

  it('withdrawing a lobby request keeps the vote open', () => {
    const { room, a, b } = mk(() => 0);
    send(room, a, { t: 'rematch', vote: 'none' }); // no vote yet: a no-op
    send(room, b, { t: 'rematch', vote: 'yes' });
    send(room, a, { t: 'rematch', vote: 'yes' });
    expect(room.phase).toBe('loading');
    room.dispose();
  });

  it('one lobby request ends the vote and sends everyone back, un-readied', () => {
    const { room, a, b } = mk(() => 0);
    send(room, a, { t: 'rematch', vote: 'yes' });
    expect(room.phase).toBe('results');
    send(room, b, { t: 'rematch', vote: 'lobby' });
    expect(room.phase).toBe('lobby');
    expect([...room.players.values()].every((p) => !p.ready && p.vote === null)).toBe(true);
    expect(a.state()?.results).toBeUndefined();
  });

  it('the timer runs out into the lobby', () => {
    let now = 0;
    const { room, a } = mk(() => now);
    send(room, a, { t: 'rematch', vote: 'yes' });
    now = 29_000;
    room.tick();
    expect(room.phase).toBe('results');
    now = 31_000;
    room.tick();
    expect(room.phase).toBe('lobby');
  });

  it('a racer who left mid-race shows the lap they left on, and is gone from the lobby after', () => {
    const room = new Room({ code: 'ABCDEF', trackId: 'cat_lai', laps: 1, hash: dataHash(), rematchSec: 30 });
    const a = seat(room, 'Host');
    const b = seat(room, 'Guest');
    for (const c of [a, b]) send(room, c, { t: 'ready', ready: true });
    send(room, a, { t: 'start' });
    for (const c of [a, b]) send(room, c, { t: 'ready', ready: true }); // loaded
    room.tick();
    for (let i = 0; i < 30; i++) room.tick();
    room.leave(b.player as Player);
    (room as unknown as { finish(sim: RaceSim): void }).finish(room.sim as RaceSim);
    const row = a.state()?.results?.find((r) => r.id === 'p2');
    expect(row?.leftLap).toBeGreaterThanOrEqual(1);
    send(room, a, { t: 'rematch', vote: 'yes' }); // b is gone: a alone decides
    expect(room.phase).toBe('loading');
    expect([...room.players.keys()]).toEqual(['p1']);
    room.dispose();
  });
});

describe('server room modes', () => {
  let server: NetServer;
  let url = '';
  beforeAll(async () => {
    server = new NetServer({
      port: 0,
      host: '127.0.0.1',
      maxRooms: 3,
      maxConnectionsPerIp: 30,
      joinTimeoutMs: 3000,
      defaultLaps: 1,
    });
    url = `ws://127.0.0.1:${await server.listen()}`;
  });
  afterAll(async () => {
    await server.close();
  });

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Open a socket, send a join, and report the welcome (room code) or the reject. */
  async function enter(extra: object): Promise<{ room?: string; reject?: RejectReason; ws: WebSocket }> {
    const ws = new WebSocket(url);
    const out: { room?: string; reject?: RejectReason; ws: WebSocket } = { ws };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMsg;
      if (m.t === 'welcome') out.room = m.room;
      if (m.t === 'reject') out.reject = m.reason;
    };
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.send(
      JSON.stringify({
        t: 'join',
        v: PROTOCOL_VERSION,
        hash: dataHash(),
        name: 'N',
        car: 'kestrel_gt',
        room: '',
        ...extra,
      }),
    );
    await sleep(250);
    return out;
  }

  it('create opens a private room with a six-character code; join finds it; a wrong code is not_found', async () => {
    const host = await enter({ mode: 'create' });
    expect(host.room).toMatch(new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`));
    const guest = await enter({ mode: 'join', room: host.room });
    expect(guest.room).toBe(host.room);
    const miss = await enter({ mode: 'join', room: 'ZZZZZZ' });
    expect(miss.reject).toBe('not_found');
    const quick = await enter({ mode: 'quick' });
    expect(quick.room).not.toBe(host.room); // the private room is not quick-joinable
    for (const s of [host, guest, quick]) s.ws.close();
    await sleep(200);
  });

  it('quick match fills the same public room, and says no_rooms when the cap leaves nowhere to open one', async () => {
    const a = await enter({ mode: 'quick' });
    const b = await enter({ mode: 'quick' });
    expect(b.room).toBe(a.room);
    // maxRooms is 3: fill the rest with private rooms.
    const fillers = [await enter({ mode: 'create' }), await enter({ mode: 'create' }), await enter({ mode: 'create' })];
    const open = fillers.filter((f) => f.room).length;
    expect(open).toBeGreaterThanOrEqual(1);
    // Six people fill the public room; the next quick match has no open room and no room to open one.
    const more = [];
    for (let i = 0; i < 4; i++) more.push(await enter({ mode: 'quick' }));
    expect(more.every((m) => m.room === a.room)).toBe(true);
    const late = await enter({ mode: 'quick' });
    expect(late.reject).toBe('no_rooms');
    for (const s of [a, b, ...fillers, ...more]) s.ws.close();
    await sleep(200);
  });
});
