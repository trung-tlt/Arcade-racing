import { NetServer } from './NetServer';
import { parseLogLevel } from './metrics';

const port = Number(process.env.PORT ?? 8080);
const logLevel = parseLogLevel(process.env.LOG_LEVEL);
const server = new NetServer({
  port,
  host: process.env.HOST ?? '0.0.0.0',
  // Phase 6 load test (docs/multiplayer-release-plan.md section 19): conservative cap for a 2 vCPU VM.
  maxRooms: Number(process.env.MAX_ROOMS ?? 12),
  // Dev and the browser e2e: start a race alone, without waiting for everyone to be ready.
  soloStart: process.env.SOLO_START === '1',
  bots: process.env.BOTS === '1',
  maxConnections: Number(process.env.MAX_CONNECTIONS ?? 200),
  // One IP per NAT / mobile carrier can be many players; the default of 8 suits a public deploy (the load test raises it).
  maxConnectionsPerIp: Number(process.env.MAX_CONNECTIONS_PER_IP ?? 8),
  maxRoomsPerIp: Number(process.env.MAX_ROOMS_PER_IP ?? 4),
  maxRoomCreatesPerMin: Number(process.env.MAX_ROOM_CREATES_PER_MIN ?? 20),
  maxFailedJoinsPerMin: Number(process.env.MAX_FAILED_JOINS_PER_MIN ?? 10),
  // Behind Caddy set TRUST_PROXY=1 (hops). Unset/0: X-Forwarded-For is ignored (it is client-controlled).
  trustProxy: process.env.TRUST_PROXY === 'true' ? 1 : Number(process.env.TRUST_PROXY ?? 0) || 0,
  legacyJoin: process.env.LEGACY_JOIN !== '0',
  rematchSec: Number(process.env.REMATCH_SEC ?? 30),
  logLevel,
  log: (line) => console.log(line),
});

server.listen().then((p) => {
  if (logLevel !== 'silent') {
    console.log(JSON.stringify({ at: new Date().toISOString(), level: 'info', event: 'listening', port: p }));
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
