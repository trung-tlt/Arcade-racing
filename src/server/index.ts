import { NetServer } from './NetServer';

const port = Number(process.env.PORT ?? 8080);
const server = new NetServer({
  port,
  host: process.env.HOST ?? '0.0.0.0',
  maxRooms: Number(process.env.MAX_ROOMS ?? 20),
  // Dev and the browser e2e: start a race alone, without waiting for everyone to be ready.
  soloStart: process.env.SOLO_START === '1',
  maxConnections: Number(process.env.MAX_CONNECTIONS ?? 200),
  maxConnectionsPerIp: Number(process.env.MAX_CONNECTIONS_PER_IP ?? 8),
  maxRoomsPerIp: Number(process.env.MAX_ROOMS_PER_IP ?? 4),
  maxFailedJoinsPerMin: Number(process.env.MAX_FAILED_JOINS_PER_MIN ?? 10),
  // Behind Caddy set TRUST_PROXY=1 (hops). Unset/0: X-Forwarded-For is ignored (it is client-controlled).
  trustProxy: process.env.TRUST_PROXY === 'true' ? 1 : Number(process.env.TRUST_PROXY ?? 0) || 0,
  legacyJoin: process.env.LEGACY_JOIN !== '0',
  rematchSec: Number(process.env.REMATCH_SEC ?? 30),
  log: (line) => console.log(JSON.stringify({ at: new Date().toISOString(), msg: line })),
});

server
  .listen()
  .then((p) => console.log(JSON.stringify({ at: new Date().toISOString(), msg: `voltline server on :${p}` })));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
