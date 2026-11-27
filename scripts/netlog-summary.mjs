#!/usr/bin/env node
// Summarises the race server's telemetry (JSON log lines) so a lag report can be checked against what the server saw.
//   ssh <vm> "journalctl -u voltline-server --since '2 hours ago' -o cat" | node scripts/netlog-summary.mjs
//   node scripts/netlog-summary.mjs server.log
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const input = process.argv[2] ? createReadStream(process.argv[2]) : process.stdin;
const rooms = new Map();
const room = (code) => {
  if (!rooms.has(code)) rooms.set(code, { code, events: [], samples: [], players: new Map() });
  return rooms.get(code);
};
const servers = [];
const pct = (xs, q) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] : null;

for await (const line of createInterface({ input })) {
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  if (!r.event) continue;
  if (r.event === 'server_sample') servers.push(r);
  else if (r.room) {
    const rm = room(r.room);
    rm.events.push(r);
    if (r.event === 'race_sample') {
      rm.samples.push(r);
      for (const p of r.players) {
        const a = rm.players.get(p.name) ?? {
          rtt: [],
          stepped: 0,
          late: 0,
          missed: 0,
          maxRun: 0,
          margin: [],
          cs: null,
        };
        if (p.rttMs >= 0) a.rtt.push(p.rttMs);
        a.stepped += p.stepped;
        a.late += p.late;
        a.missed += p.missed;
        a.maxRun = Math.max(a.maxRun, p.maxRun);
        if (p.marginTicks !== null) a.margin.push(p.marginTicks);
        if (p.client) {
          const c = (a.cs ??= {
            sec: 0,
            frames: 0,
            hitches: 0,
            over50: 0,
            nearOver50: 0,
            snaps: 0,
            maxErrM: 0,
            holds: 0,
            catchUps: 0,
            interp: [],
          });
          c.sec += p.client.sec;
          c.frames += p.client.fps * p.client.sec;
          for (const k of ['hitches', 'over50', 'nearOver50', 'snaps', 'holds', 'catchUps']) c[k] += p.client[k];
          c.maxErrM = Math.max(c.maxErrM, p.client.maxErrM);
          c.interp.push(p.client.interpMs);
        }
        rm.players.set(p.name, a);
      }
    }
  }
}

for (const rm of rooms.values()) {
  const ev = (n) => rm.events.filter((e) => e.event === n);
  console.log(`\n== room ${rm.code}  ${rm.events[0]?.at ?? ''}`);
  for (const e of rm.events) {
    if (
      ['player_join', 'player_leave', 'restart', 'loading_done', 'finish', 'race_start', 'race_end'].includes(e.event)
    ) {
      const { at, level, event, room: _r, track, ...rest } = e;
      console.log(`  ${at?.slice(11, 19)} ${event.padEnd(13)} ${JSON.stringify(rest)}`);
    }
  }
  const bytes = rm.samples.map((s) => s.snapBytes);
  if (bytes.length)
    console.log(`  snapshot size: median ${pct(bytes, 0.5)} B, max ${Math.max(...bytes)} B  (x20/s per player)`);
  for (const [name, a] of rm.players) {
    const missPct = a.stepped ? ((a.missed / a.stepped) * 100).toFixed(2) : '-';
    console.log(
      `  ${name.padEnd(14)} rtt p50 ${pct(a.rtt, 0.5)} p95 ${pct(a.rtt, 0.95)} ms | ticks without input ${missPct}% | late frames ${a.late} | longest gap ${a.maxRun} ticks | lead margin p5 ${pct(a.margin, 0.05)} ticks`,
    );
    const c = a.cs;
    if (c) {
      const min = c.sec / 60;
      console.log(
        `  ${''.padEnd(14)} client (${Math.round(c.sec)} s): fps ${Math.round(c.frames / c.sec)} | hitches ${c.hitches} | corrections >0.5 m ${c.over50} (${c.nearOver50} near a car) | snaps ${c.snaps} | max err ${c.maxErrM} m | holds/min ${(c.holds / min).toFixed(0)} catch-ups/min ${(c.catchUps / min).toFixed(0)} | interp p50 ${pct(c.interp, 0.5)} ms`,
      );
    }
  }
  void ev;
}
if (servers.length) {
  const p99 = servers.map((s) => s.tickMsP99);
  console.log(
    `\nserver: ${servers.length} samples, tick p99 median ${pct(p99, 0.5)} ms max ${Math.max(...p99)} ms, peak rooms ${Math.max(...servers.map((s) => s.rooms))}, peak players ${Math.max(...servers.map((s) => s.players))}, rss max ${Math.max(...servers.map((s) => s.rssMb))} MB`,
  );
}
if (rooms.size === 0 && servers.length === 0) console.log('no telemetry lines found');
