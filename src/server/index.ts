import { NetServer } from './NetServer';

const port = Number(process.env.PORT ?? 8080);
const server = new NetServer({
  port,
  host: process.env.HOST ?? '0.0.0.0',
  maxRooms: Number(process.env.MAX_ROOMS ?? 20),
  // Dev and the browser e2e: start a race alone, without waiting for everyone to be ready.
  soloStart: process.env.SOLO_START === '1',
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
