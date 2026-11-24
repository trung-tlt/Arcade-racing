// A WebSocket proxy that makes a link bad on purpose: fixed delay, jitter, and TCP-style stalls (a "lost" packet holds
// up everything behind it for one retransmit timeout). Messages stay in order, like a real socket.
import { WebSocket, WebSocketServer } from 'ws';

export const PROFILES = {
  lan: { latencyMs: 2, jitterMs: 1, stallProb: 0, stallMs: 0 },
  '60ms': { latencyMs: 30, jitterMs: 8, stallProb: 0, stallMs: 0 },
  '150ms': { latencyMs: 75, jitterMs: 20, stallProb: 0.01, stallMs: 250 },
  mobile: { latencyMs: 45, jitterMs: 40, stallProb: 0.02, stallMs: 300 },
};

/** One direction: schedule each message at now + latency + jitter (+ stall), never before the one ahead of it. */
function lane(cfg, rand) {
  let lastAt = 0;
  return (deliver) => {
    const stall = rand() < cfg.stallProb ? cfg.stallMs : 0;
    let at = Date.now() + cfg.latencyMs + rand() * cfg.jitterMs + stall;
    if (at < lastAt) at = lastAt;
    lastAt = at;
    setTimeout(deliver, Math.max(0, at - Date.now()));
  };
}

/** Listen on `port`, forward every connection to `target` (a ws:// URL) through the given profile (both directions). */
export function startProxy({ port, target, profile, seed = 1 }) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const wss = new WebSocketServer({ port });
  wss.on('connection', (client, req) => {
    const up = lane(profile, rand);
    const down = lane(profile, rand);
    const server = new WebSocket(target + (req.url ?? ''), {
      headers: { 'x-forwarded-for': req.socket.remoteAddress ?? '' },
    });
    const pending = [];
    server.on('open', () => pending.splice(0).forEach((m) => server.send(m.data, { binary: m.binary })));
    client.on('message', (data, binary) =>
      up(() => (server.readyState === WebSocket.OPEN ? server.send(data, { binary }) : pending.push({ data, binary }))),
    );
    server.on('message', (data, binary) =>
      down(() => client.readyState === WebSocket.OPEN && client.send(data, { binary })),
    );
    client.on('close', () => up(() => server.close()));
    server.on('close', () => down(() => client.close()));
    client.on('error', () => server.terminate());
    server.on('error', () => client.terminate());
  });
  return { close: () => new Promise((r) => wss.close(() => r())) };
}
