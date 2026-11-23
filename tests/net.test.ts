import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NetClient } from '../src/net/NetClient';
import { NetPilot } from '../src/net/NetPilot';
import { NetServer } from '../src/server/NetServer';
import { dataHash } from '../src/shared/dataHash';
import { PROTOCOL_VERSION, type RejectReason, type ServerMsg } from '../src/shared/protocol';

let server: NetServer;
let url = '';

beforeAll(async () => {
  server = new NetServer({ port: 0, host: '127.0.0.1', joinTimeoutMs: 1500, defaultLaps: 1, soloStart: true });
  const port = await server.listen();
  url = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let roomN = 0;
const roomCode = (): string => `T${++roomN}X`;

async function connect(events: ConstructorParameters<typeof NetClient>[1] = {}): Promise<NetClient> {
  const c = new NetClient(url, events);
  await c.connect();
  return c;
}

/** Resolves with the first reject reason (or 'closed') seen on a raw join attempt. */
async function rejection(join: object): Promise<RejectReason | 'closed' | null> {
  const ws = new WebSocket(url);
  let result: RejectReason | 'closed' | null = null;
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMsg;
    if (m.t === 'reject') result = m.reason;
  };
  ws.onclose = () => (result ??= 'closed');
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.send(JSON.stringify(join));
  await sleep(300);
  ws.close();
  return result;
}

const goodJoin = (room: string): object => ({
  t: 'join',
  v: PROTOCOL_VERSION,
  hash: dataHash(),
  name: 'Net',
  car: 'kestrel_gt',
  room,
});

describe('websocket server', () => {
  it('rejects a mismatched client build and bad data hashes', async () => {
    expect(await rejection({ ...goodJoin(roomCode()), v: PROTOCOL_VERSION + 1 })).toBe('version');
    expect(await rejection({ ...goodJoin(roomCode()), hash: 'deadbeef' })).toBe('data');
  });

  it('rejects junk, a first message that is not a join, and oversize messages', async () => {
    expect(await rejection({ t: 'input', seq: 0, throttle: 1, brake: 0, steer: 0 })).toBe('bad_message');
    expect(await rejection({ nonsense: true })).toBe('bad_message');
    const big = { ...goodJoin(roomCode()), name: 'x'.repeat(5000) };
    expect(['bad_message', 'closed']).toContain(await rejection(big));
  });

  it('drops a connection that never joins', async () => {
    const ws = new WebSocket(url);
    const closed = new Promise<boolean>((r) => (ws.onclose = () => r(true)));
    expect(await Promise.race([closed, sleep(3000).then(() => false)])).toBe(true);
  });

  it('a client joins, the host starts, and it drives a car in real time at 20 Hz snapshots', async () => {
    const room = roomCode();
    let welcomed = false;
    let states = 0;
    const c = await connect({
      onWelcome: () => (welcomed = true),
      onState: () => states++,
    });
    c.join('Runner', 'kestrel_gt', room, dataHash(), 'cat_lai', 1);
    await sleep(200);
    expect(welcomed).toBe(true);
    expect(c.id).toBe('p1');
    c.start();
    await sleep(100);
    c.ready(true);
    const pilot = new NetPilot('cat_lai', c.id, 'kestrel_gt');
    let snaps = 0;
    let firstSnapAt = 0;
    let lastSnapAt = 0;
    let lastSnapMs = 0;
    c.events.onSnapshot = () => {
      const now = performance.now();
      snaps++;
      firstSnapAt ||= now;
      lastSnapAt = now;
      lastSnapMs = now;
    };
    // 60 Hz input loop from the latest snapshot (the pilot extrapolates it by its age).
    const timer = setInterval(() => {
      if (!c.snap) return;
      c.sendInput(
        c.serverTickNow() + 6,
        pilot.read(c.snap.cars, c.snap.phase === 'countdown', (performance.now() - lastSnapMs) / 1000),
      );
    }, 1000 / 60);
    await sleep(9000);
    clearInterval(timer);
    const me = c.me();
    c.close();
    const rate = (snaps - 1) / ((lastSnapAt - firstSnapAt) / 1000);
    console.log(
      `NET snaps=${snaps} rate=${rate.toFixed(1)}Hz me.t=${me?.t} speed=${me ? Math.hypot(me.v[0], me.v[2]).toFixed(1) : '-'} ack=${c.snap?.ack}`,
    );
    expect(states).toBeGreaterThan(1);
    expect(rate).toBeGreaterThan(17);
    expect(rate).toBeLessThan(23);
    expect(c.snap?.cars).toHaveLength(6);
    // Green is at ~3.5 s; after 9 s the car is up to speed and the server is applying our inputs.
    expect(me && Math.hypot(me.v[0], me.v[2])).toBeGreaterThan(15);
    expect(c.snap?.ack).toBeGreaterThan(300);
    expect(c.pingMs >= 0).toBe(true);
  }, 30_000);

  it('serves /health and frees the room when everyone leaves', async () => {
    const res = await fetch(url.replace('ws://', 'http://') + '/health');
    const h = (await res.json()) as { rooms: number; players: number; tickMsP99: number; hz: number };
    expect(h.hz).toBe(60);
    await sleep(500);
    const again = (await (await fetch(url.replace('ws://', 'http://') + '/health')).json()) as typeof h;
    expect(again.players).toBe(0);
    expect(again.rooms).toBe(0);
  });
});

describe.skipIf(!process.env.NET_LAP)('a full lap over the websocket (real time, ~90 s)', () => {
  it('drives one lap of Cat Lai solo and gets results', async () => {
    const s2 = new NetServer({ port: 0, host: '127.0.0.1', defaultLaps: 1, soloStart: true });
    const port = await s2.listen();
    let results: unknown;
    const c = new NetClient(`ws://127.0.0.1:${port}`, {
      onState: (m) => {
        if (m.phase === 'results') results = m.results;
      },
    });
    await c.connect();
    c.join('Lapper', 'kestrel_gt', 'LAP1', dataHash(), 'cat_lai', 1);
    await sleep(200);
    c.start();
    await sleep(100);
    c.ready(true);
    const pilot = new NetPilot('cat_lai', c.id, 'kestrel_gt');
    let last = 0;
    c.events.onSnapshot = () => (last = performance.now());
    const timer = setInterval(() => {
      if (c.snap)
        c.sendInput(
          c.serverTickNow() + 6,
          pilot.read(c.snap.cars, c.snap.phase === 'countdown', (performance.now() - last) / 1000),
        );
    }, 1000 / 60);
    const start = Date.now();
    while (!results && Date.now() - start < 200_000) await sleep(250);
    clearInterval(timer);
    c.close();
    await s2.close();
    console.log('NET LAP results', JSON.stringify(results));
    expect(results).toBeDefined();
  }, 240_000);
});
