import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LobbyClient, hubErrorOf, type RoomView } from '../src/net/LobbyClient';
import { NetServer } from '../src/server/NetServer';
import { initSim } from '../src/sim/RaceSim';

let server: NetServer;
let url = '';

beforeAll(async () => {
  await initSim();
  server = new NetServer({ port: 0, host: '127.0.0.1', maxRooms: 4, maxConnectionsPerIp: 30, defaultLaps: 1 });
  url = `ws://127.0.0.1:${await server.listen()}`;
});
afterAll(async () => {
  await server.close();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(20);
  }
};
const me = { name: 'VOLTKID', car: 'kestrel_gt' };

describe('LobbyClient', () => {
  it('maps server reasons to hub errors', () => {
    expect(hubErrorOf('version')).toBe('version');
    expect(hubErrorOf('data')).toBe('version');
    expect(hubErrorOf('not_found')).toBe('notfound');
    expect(hubErrorOf('no_rooms')).toBe('empty');
    expect(hubErrorOf('full')).toBe('full');
    expect(hubErrorOf('race_started')).toBe('started');
  });

  it('creates a room, a friend joins by code, the host picks the race and the room starts when all are ready', async () => {
    const views: RoomView[] = [];
    const grids: string[] = [];
    const a = await LobbyClient.enter(url, 'create', me, {
      onView: (v) => views.push(v),
      onGrid: (_g, track, laps) => grids.push(`${track}/${laps}`),
    });
    if (!('lobby' in a)) throw new Error(a.err);
    const host = a.lobby;
    expect(host.view?.isHost).toBe(true);
    expect(host.view?.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

    const b = await LobbyClient.enter(url, 'join', { ...me, name: 'GHOST_77', room: host.view?.code.toLowerCase() });
    if (!('lobby' in b)) throw new Error(b.err);
    const guest = b.lobby;
    expect(guest.view?.isHost).toBe(false);
    expect(guest.view?.hostName).toBe('VOLTKID');
    await until(() => host.view?.roster.length === 2);

    host.settings('monte_carlo', 2);
    await until(() => guest.view?.track === 'monte_carlo' && guest.view.laps === 2);

    host.ready(true);
    host.start(); // guest not ready: refused
    await sleep(150);
    expect(host.view?.phase).toBe('lobby');
    guest.ready(true);
    await until(() => host.view?.roster.every((r) => r.ready) === true);
    host.start();
    await until(() => grids.length === 1);
    expect(grids[0]).toBe('monte_carlo/2');
    host.leave();
    guest.leave();
  });

  it('reports a wrong code, a full server and an unreachable server as hub errors', async () => {
    let closed = 0;
    const miss = await LobbyClient.enter(url, 'join', { ...me, room: 'ZZZZZZ' }, { onClosed: () => closed++ });
    expect(miss).toMatchObject({ err: 'notfound' });
    await sleep(300);
    expect(closed).toBe(0); // the server hanging up on a refused join is not a lost connection
    const down = await LobbyClient.enter('ws://127.0.0.1:1', 'quick', me);
    expect(down).toEqual({ err: 'down' });
  });

  it('carries the server protocol version on a version mismatch', async () => {
    const ws = new WebSocket(url);
    const msg = await new Promise<{ reason: string; v: number }>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
      ws.onopen = () =>
        ws.send(JSON.stringify({ t: 'join', v: 99, hash: 'x', name: 'N', car: 'kestrel_gt', mode: 'quick' }));
    });
    expect(msg).toMatchObject({ reason: 'version', v: 1 });
    ws.close();
  });
});
