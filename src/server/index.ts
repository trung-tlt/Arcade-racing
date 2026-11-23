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
  // One IP per NAT / mobile carrier can be many players; the default of 8 suits a public deploy, the load test raises it.
  maxConnectionsPerIp: Number(process.env.MAX_CONN_PER_IP ?? 8),
  soloStart: process.env.SOLO_START === '1',
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
