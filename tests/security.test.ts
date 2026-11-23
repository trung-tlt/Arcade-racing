import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { Room, type Conn, type Player } from '../src/server/Room';
import { NetServer } from '../src/server/NetServer';
import { WindowLimiter, clientIp, guardedSend } from '../src/server/limits';
import { dataHash } from '../src/shared/dataHash';
import {
  MAX_NAME_CHARS,
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  sanitizeName,
  type ClientMsg,
  type RejectReason,
  type ServerMsg,
} from '../src/shared/protocol';
import { initSim } from '../src/sim/RaceSim';

beforeAll(async () => {
  await initSim();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** mulberry32: a seeded PRNG so the fuzz runs are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('names', () => {
  it('strips bidi overrides, zero-width and C1 controls', () => {
    expect(sanitizeName('a‮b​c⁦d﻿e\u0085f­g', 16, 'X')).toBe('abcdefg');
    expect(sanitizeName('​‮ ‍', 16, 'Player')).toBe('Player');
  });
  it('caps by code points and never splits a surrogate pair', () => {
    const name = sanitizeName('\u{1F600}'.repeat(40), MAX_NAME_CHARS, 'X');
    expect([...name]).toHaveLength(MAX_NAME_CHARS);
    expect(name).toBe(JSON.parse(JSON.stringify(name)));
    expect(sanitizeName('ab\uD800cd', 16, 'X')).toBe('abcd'); // lone surrogate dropped
  });
  it('limits stacked combining marks (zalgo)', () => {
    const zalgo = 'e' + '́̂̃̄̅̆̇̈'.repeat(20);
    expect([...sanitizeName(zalgo, 16, 'X')].length).toBeLessThanOrEqual(1 + 3);
  });
});

describe('parser limits', () => {
  it('rejects absurd input ticks', () => {
    const base = { t: 'input', throttle: 1, brake: 0, steer: 0 };
    for (const tick of [1e12, 2 ** 40, -1, 1.5]) {
      expect(parseClientMessage(JSON.stringify({ ...base, tick })).ok).toBe(false);
    }
    expect(parseClientMessage('{"t":"input","tick":"NaN","throttle":1,"brake":0,"steer":0}').ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ ...base, tick: 100 })).ok).toBe(true);
  });
  it('survives deep nesting and prototype keys', () => {
    expect(parseClientMessage('['.repeat(300)).ok).toBe(false);
    expect(parseClientMessage('{"a":'.repeat(100) + '1' + '}'.repeat(100)).ok).toBe(false);
    expect(parseClientMessage('{"__proto__":{"t":"start"}}').ok).toBe(false);
    const r = parseClientMessage('{"t":"start","__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}}}');
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

/** A Room test rig. */
class Fake implements Conn {
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
}
const joinMsg = (over: Partial<Extract<ClientMsg, { t: 'join' }>> = {}): Extract<ClientMsg, { t: 'join' }> => ({
  t: 'join',
  v: PROTOCOL_VERSION,
  hash: dataHash(),
  name: 'T',
  car: 'kestrel_gt',
  room: 'SEC',
  ...over,
});
function seat(room: Room): Fake {
  const c = new Fake();
  const r = room.join(c, joinMsg());
  if (typeof r === 'string') throw new Error(r);
  c.player = r;
  return c;
}
const mkRoom = (now: () => number = () => 0): Room =>
  new Room({ code: 'SEC', trackId: 'cat_lai', laps: 1, hash: dataHash(), now, minPlayers: 1, needAllReady: false });
const states = (c: Fake): number => c.inbox.filter((m) => m.t === 'state').length;
/** Feed raw text the way the server does. Returns the reject reason, if any. */
function feed(room: Room, c: Fake, raw: string): RejectReason | null {
  const p = parseClientMessage(raw);
  return p.ok ? room.handle(c.player as Player, p.msg) : 'bad_message';
}

describe('room abuse', () => {
  it('rate limits control messages: no state broadcast amplification', () => {
    const room = mkRoom();
    const a = seat(room);
    const b = seat(room);
    const before = states(b);
    let reason: RejectReason | null = null;
    for (let i = 0; i < 3000; i++) {
      reason = feed(room, a, `{"t":"ready","ready":${i % 2 === 0}}`) ?? reason;
    }
    expect(states(b) - before).toBeLessThan(60);
    expect(reason).toBe('rate'); // a sustained flood is disconnected
  });
  it('lets a normal client ping, ready and pick cars at a human pace', () => {
    let t = 0;
    const room = mkRoom(() => t);
    const a = seat(room);
    for (let i = 0; i < 100; i++) {
      t += 500;
      expect(feed(room, a, '{"t":"ping","c":1,"rtt":40}')).toBeNull();
      expect(feed(room, a, `{"t":"ready","ready":${i % 2 === 0}}`)).toBeNull();
    }
    expect(a.inbox.filter((m) => m.t === 'pong')).toHaveLength(100);
  });
  it('a far-future input tick cannot poison ack or grow the frame buffer', () => {
    const room = mkRoom();
    const a = seat(room);
    const p = a.player as Player;
    for (let i = 0; i < 5000; i++) {
      room.handle(p, {
        t: 'input',
        tick: 1_000_000 + i,
        throttle: 1,
        brake: 0,
        steer: 0,
        drift: false,
        nitro: false,
        fire: false,
        fireSecondary: false,
      });
      room.handle(p, {
        t: 'input',
        tick: i % 400,
        throttle: 1,
        brake: 0,
        steer: 0,
        drift: false,
        nitro: false,
        fire: false,
        fireSecondary: false,
      });
    }
    expect(p.frames.size).toBeLessThanOrEqual(90);
    expect(p.ackTick).toBeLessThan(1000);
  });
  it('host-only messages from a non-host do nothing; settings only in the lobby', () => {
    const room = mkRoom();
    const host = seat(room);
    const guest = seat(room);
    feed(room, guest, '{"t":"settings","laps":9}');
    expect(room.laps).toBe(1);
    feed(room, guest, '{"t":"start"}');
    expect(room.phase).toBe('lobby');
    feed(room, host, '{"t":"start"}');
    expect(room.phase).toBe('loading');
    feed(room, host, '{"t":"settings","laps":9,"track":"nope"}');
    expect(room.laps).toBe(1);
  });
  it('keeps a lag-comp view tick claim harmless', () => {
    const room = mkRoom();
    const host = seat(room);
    feed(room, host, '{"t":"start"}');
    for (const vt of [0, 1e9, -5]) {
      feed(room, host, JSON.stringify({ t: 'input', tick: 0, vt, throttle: 1, brake: 0, steer: 0 }));
    }
    expect(() => {
      for (let i = 0; i < 400; i++) room.tick();
    }).not.toThrow();
    room.dispose();
  });
});

const alphabet = [
  '{',
  '}',
  '[',
  ']',
  '"',
  ':',
  ',',
  '\\',
  'null',
  'true',
  '-1',
  '1e999',
  '0',
  '\u0000',
  '\u{1F600}',
  '\uD800',
  '__proto__',
];
const VALID = [
  '{"t":"join","v":1,"hash":"abc","name":"Bob","car":"kestrel_gt","room":"SEC"}',
  '{"t":"join","v":1,"hash":"abc","name":"Bob","car":"kestrel_gt","room":"","mode":"quick","laps":3,"track":"x"}',
  '{"t":"ready","ready":true}',
  '{"t":"car","car":"kestrel_gt"}',
  '{"t":"settings","track":"cat_lai","laps":2}',
  '{"t":"start"}',
  '{"t":"rematch","vote":true}',
  '{"t":"input","tick":5,"vt":3.5,"throttle":1,"brake":0,"steer":-0.3,"drift":true}',
  '{"t":"reset"}',
  '{"t":"ping","c":3,"rtt":55}',
  '{"t":"leave"}',
];
function mutate(r: () => number, s: string): string {
  let out = s;
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const at = Math.floor(r() * (out.length + 1));
    const k = r();
    if (k < 0.3) out = out.slice(0, at) + out.slice(at + 1 + Math.floor(r() * 3));
    else if (k < 0.7) out = out.slice(0, at) + alphabet[Math.floor(r() * alphabet.length)] + out.slice(at);
    else if (k < 0.85) out = out.slice(0, at) + String(Math.floor((r() - 0.5) * 1e6)) + out.slice(at);
    else out = out.slice(0, at) + out.slice(at).repeat(1 + Math.floor(r() * 5));
  }
  return out;
}

describe('fuzz', () => {
  it('the parser never throws and only passes sane values', () => {
    const r = rng(1337);
    let accepted = 0;
    for (let i = 0; i < 20000; i++) {
      const raw =
        r() < 0.1
          ? String.fromCharCode(...Array.from({ length: 40 }, () => Math.floor(r() * 65536)))
          : mutate(r, VALID[Math.floor(r() * VALID.length)]);
      const p = parseClientMessage(raw);
      if (!p.ok) continue;
      accepted++;
      const m = p.msg;
      if (m.t === 'input') {
        expect(Number.isInteger(m.tick) && m.tick >= 0 && m.tick < 2 ** 31).toBe(true);
        expect(m.steer >= -1 && m.steer <= 1 && m.throttle >= 0 && m.throttle <= 1).toBe(true);
        if (m.vt !== undefined) expect(Number.isFinite(m.vt)).toBe(true);
      }
      if (m.t === 'join') expect([...m.name].length).toBeLessThanOrEqual(MAX_NAME_CHARS);
    }
    expect(accepted).toBeGreaterThan(500);
  });

  it('a live room survives thousands of mutated messages and stays usable', () => {
    const r = rng(4242);
    let t = 0;
    const room = mkRoom(() => t);
    const clients = [seat(room), seat(room), seat(room)];
    const heap0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 6000; i++) {
      t += 5;
      const c = clients[Math.floor(r() * clients.length)];
      const p = c.player as Player;
      if (!p.connected) continue;
      const raw = mutate(r, VALID[Math.floor(r() * VALID.length)]);
      const parsed = parseClientMessage(raw);
      if (parsed.ok && parsed.msg.t !== 'join') {
        expect(() => room.handle(p, parsed.msg)).not.toThrow();
      }
      if (room.phase !== 'lobby' && i % 7 === 0) expect(() => room.tick()).not.toThrow();
      if (room.phase === 'results') for (const q of room.players.values()) q.vote = null;
      for (const q of room.players.values()) expect(q.frames.size).toBeLessThanOrEqual(91);
    }
    room.dispose();
    expect(process.memoryUsage().heapUsed - heap0).toBeLessThan(150 * 1024 * 1024);

    // Fresh room afterwards is fully functional.
    const fresh = mkRoom();
    const h = seat(fresh);
    feed(fresh, h, '{"t":"start"}');
    expect(fresh.phase).toBe('loading');
    fresh.dispose();
  });
});

describe('limits helpers', () => {
  it('WindowLimiter counts events inside its window only', () => {
    const l = new WindowLimiter(3, 1000);
    expect(l.blocked('a', 0)).toBe(false);
    l.record('a', 0);
    l.record('a', 10);
    l.record('a', 20);
    expect(l.blocked('a', 30)).toBe(true);
    expect(l.blocked('b', 30)).toBe(false);
    expect(l.blocked('a', 2000)).toBe(false);
  });
  it('clientIp ignores X-Forwarded-For unless proxy trust is on, and takes the hop our proxy appended', () => {
    expect(clientIp('10.0.0.1', '6.6.6.6', 0)).toBe('10.0.0.1');
    expect(clientIp('10.0.0.1', '6.6.6.6, 1.2.3.4', 1)).toBe('1.2.3.4'); // the spoofed left entry is ignored
    expect(clientIp('10.0.0.1', '6.6.6.6, 1.2.3.4, 10.0.0.9', 2)).toBe('1.2.3.4');
    expect(clientIp('10.0.0.1', undefined, 1)).toBe('10.0.0.1');
    expect(clientIp('10.0.0.1', 'garbage<script>', 1)).toBe('10.0.0.1');
    expect(clientIp('10.0.0.1', '1.2.3.4', 3)).toBe('10.0.0.1'); // fewer hops than trusted: do not guess
  });
  it('guardedSend drops a client that does not read', () => {
    const sent: string[] = [];
    let terminated = false;
    const ws = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: (s: string) => sent.push(s),
      terminate: () => (terminated = true),
    };
    guardedSend(ws, 'a', 1000);
    expect(sent).toEqual(['a']);
    ws.bufferedAmount = 5000;
    guardedSend(ws, 'b', 1000);
    expect(sent).toEqual(['a']);
    expect(terminated).toBe(true);
  });
});

describe('server', () => {
  const servers: NetServer[] = [];
  const socks: WsClient[] = [];
  afterEach(async () => {
    for (const s of socks.splice(0)) s.terminate();
    for (const s of servers.splice(0)) await s.close();
  });
  async function start(o: Partial<ConstructorParameters<typeof NetServer>[0]> = {}): Promise<string> {
    const s = new NetServer({ port: 0, host: '127.0.0.1', joinTimeoutMs: 1500, defaultLaps: 1, ...o });
    servers.push(s);
    return `ws://127.0.0.1:${await s.listen()}`;
  }
  /** Open a socket; resolves with it plus a log of what it saw. */
  async function open(url: string, headers: Record<string, string> = {}) {
    const ws = new WsClient(url, { headers });
    socks.push(ws);
    const seen: ServerMsg[] = [];
    let closed = false;
    ws.on('message', (d) => {
      const m = parseServerMessage(String(d));
      if (m) seen.push(m);
    });
    ws.on('close', () => (closed = true));
    ws.on('error', () => (closed = true));
    await new Promise<void>((res) => {
      ws.on('open', () => res());
      ws.on('error', () => res());
    });
    return { ws, seen, isClosed: () => closed || ws.readyState > 1 };
  }
  const join = (extra: object): string =>
    JSON.stringify({
      t: 'join',
      v: PROTOCOL_VERSION,
      hash: dataHash(),
      name: 'S',
      car: 'kestrel_gt',
      room: '',
      ...extra,
    });
  const reasonOf = (seen: ServerMsg[]): string | undefined =>
    (seen.find((m) => m.t === 'reject') as { reason: string } | undefined)?.reason;

  it('throttles room-code brute force per IP', async () => {
    const url = await start({ maxFailedJoinsPerMin: 3 });
    const reasons: (string | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await open(url);
      c.ws.send(join({ mode: 'join', room: `ZZZZZ${i + 2}` }));
      await sleep(80);
      reasons.push(reasonOf(c.seen));
    }
    expect(reasons.slice(0, 3)).toEqual(['not_found', 'not_found', 'not_found']);
    expect(reasons.slice(3)).toEqual(['rate', 'rate']);
  });

  it('caps rooms opened per IP and the creation rate', async () => {
    const url = await start({ maxRoomsPerIp: 2, maxConnectionsPerIp: 20 });
    const out: (string | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await open(url);
      c.ws.send(join({ mode: 'create' }));
      await sleep(80);
      out.push(reasonOf(c.seen) ?? (c.seen.some((m) => m.t === 'welcome') ? 'ok' : 'none'));
    }
    expect(out).toEqual(['ok', 'ok', 'rate']);
    const url2 = await start({ maxRoomCreatesPerMin: 3, maxConnectionsPerIp: 20 });
    const res: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await open(url2);
      c.ws.send(join({ mode: 'create' }));
      await sleep(80);
      res.push(reasonOf(c.seen) ?? 'ok');
      c.ws.close(); // churn: leave right away so the room is reaped
      await sleep(60);
    }
    expect(res).toEqual(['ok', 'ok', 'ok', 'rate', 'rate']);
  });

  it('enforces the global connection cap', async () => {
    const url = await start({ maxConnections: 2, maxConnectionsPerIp: 50 });
    const cs = [await open(url), await open(url), await open(url)];
    await sleep(150);
    expect(cs.map((c) => c.isClosed())).toEqual([false, false, true]);
  });

  it('does not trust X-Forwarded-For unless TRUST_PROXY is set', async () => {
    const plain = await start({ maxConnectionsPerIp: 2 });
    const a = [
      await open(plain, { 'x-forwarded-for': '1.1.1.1' }),
      await open(plain, { 'x-forwarded-for': '2.2.2.2' }),
      await open(plain, { 'x-forwarded-for': '3.3.3.3' }),
    ];
    await sleep(150);
    expect(a.map((c) => c.isClosed())).toEqual([false, false, true]);
    const proxied = await start({ maxConnectionsPerIp: 1, trustProxy: 1 });
    const b = [
      await open(proxied, { 'x-forwarded-for': 'evil, 1.1.1.1' }),
      await open(proxied, { 'x-forwarded-for': 'evil, 2.2.2.2' }),
      await open(proxied, { 'x-forwarded-for': 'evil2, 2.2.2.2' }),
    ];
    await sleep(150);
    expect(b.map((c) => c.isClosed())).toEqual([false, false, true]);
  });

  it('contains an exception in a room tick or message handler', async () => {
    const url = await start({ soloStart: true, maxConnectionsPerIp: 20 });
    const srv = servers[0] as unknown as { rooms: Map<string, Room> };
    const bad = await open(url);
    bad.ws.send(join({ mode: 'create' }));
    const good = await open(url);
    good.ws.send(join({ mode: 'create' }));
    await sleep(150);
    const rooms = [...srv.rooms.values()];
    expect(rooms).toHaveLength(2);
    rooms[0].tick = (): void => {
      throw new Error('boom tick');
    };
    rooms[1].handle = (): never => {
      throw new Error('boom handle');
    };
    await sleep(100);
    expect(srv.rooms.size).toBe(1); // the failing room was closed, the process is alive
    good.ws.send('{"t":"ping","c":1}');
    await sleep(100);
    expect(good.isClosed()).toBe(true); // only the offending player is dropped
    const again = await open(url);
    again.ws.send(join({ mode: 'create' }));
    await sleep(100);
    expect(again.seen.some((m) => m.t === 'welcome')).toBe(true);
    expect(bad.isClosed()).toBe(true);
  });
});
