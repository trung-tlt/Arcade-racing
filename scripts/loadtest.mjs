#!/usr/bin/env node
// Networked load test for the VOLTLINE race server (docs/multiplayer-release-plan.md, Phase 6).
//
//   node scripts/loadtest.mjs --rooms 1,4,8,16 [--measure 60] [--url ws://host:port] [--workers 4]
//
// For every room count it starts a fresh server (the `npm run server:build` output, or uses --url), seats 6 bot clients
// per room (the repo's NetClient + NetPilot over real WebSockets), lets every room reach the race, then measures for
// --measure seconds and prints per-tick time p50/p99/max (server /health), snapshot rate seen by the clients, CPU and RSS
// of the server process, bytes/s per player, and late / rate-limited input frames. Races restart through the rematch vote
// so the load stays in the racing phase. Bots run in worker threads so the test client itself does not become the
// bottleneck; the report includes the worst client event-loop lag so you can tell.
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------- worker: bot rooms
async function workerMain() {
  const { botModule, url, roomIds, size, track, laps } = workerData;
  const { NetClient, NetPilot, dataHash, PROTOCOL_VERSION } = await import(pathToFileURL(botModule).href);
  void PROTOCOL_VERSION;
  const hash = dataHash();
  /** @type {any[]} */
  const bots = [];
  let lastLoopAt = performance.now();
  let maxLagMs = 0;
  let lagSumMs = 0;
  let lagN = 0;

  for (const roomId of roomIds) {
    for (let i = 0; i < size; i++) bots.push(makeBot(roomId, i));
  }

  function makeBot(roomId, index) {
    const stat = {
      up: 0,
      down: 0,
      snaps: 0,
      gaps: [],
      lastSnapAt: 0,
      late: -1,
      lateFirst: -1,
      racing: false,
      finished: 0,
    };
    class CountingWS extends WebSocket {
      constructor(u) {
        super(u);
        this.addEventListener('message', (e) => (stat.down += String(e.data).length));
      }
      send(d) {
        stat.up += String(d).length;
        super.send(d);
      }
    }
    const bot = { stat, roomId, index, c: null, pilot: null, lastSent: -1, hostKick: 0, measuring: false };
    const car = ['kestrel_gt', 'kestrel_gt'][index % 2];
    bot.c = new NetClient(
      url,
      {
        onState: (m) => {
          if (m.phase === 'loading') {
            bot.pilot = new NetPilot(track, bot.c.id, car);
            bot.lastSent = -1;
            bot.c.ready(true);
          } else if (m.phase === 'results') {
            stat.finished++;
            bot.c.rematch(true);
          } else if (m.phase === 'lobby') {
            if (!bot.readied) bot.c.ready(true);
            bot.readied = true;
            const host = m.roster.find((r) => r.host);
            if (host && host.id === bot.c.id && m.roster.length === size && m.roster.every((r) => r.ready)) {
              const now = performance.now();
              if (now - bot.hostKick > 500) {
                bot.hostKick = now;
                bot.c.start();
              }
            }
          }
          if (m.phase !== 'lobby') bot.readied = false;
        },
        onSnapshot: (m) => {
          const now = performance.now();
          if (bot.measuring) {
            stat.snaps++;
            if (stat.lastSnapAt) stat.gaps.push(now - stat.lastSnapAt);
            if (stat.lateFirst < 0) stat.lateFirst = m.late;
            stat.late = m.late;
          }
          stat.lastSnapAt = now;
          stat.racing = m.phase === 'racing';
        },
        onReject: (reason) => {
          stat.reject = reason;
        },
      },
      CountingWS,
    );
    return bot;
  }

  // Connect everyone, spread out a little so 144 sockets do not all land in one server tick.
  for (const b of bots) {
    await b.c.connect();
    b.c.join(`L${b.roomId}`, 'kestrel_gt', `L${b.roomId}`, hash, track, laps);
    await sleep(15);
  }

  // One driver loop for all bots of this worker: for every tick up to (server tick + 6) a frame goes out, as the game does.
  const loop = () => {
    const now = performance.now();
    const lag = Math.max(0, now - lastLoopAt - 1000 / 60);
    lastLoopAt = now;
    if (bots[0]?.measuring) {
      maxLagMs = Math.max(maxLagMs, lag);
      lagSumMs += lag;
      lagN++;
    }
    for (const b of bots) {
      const snap = b.c.snap;
      if (!snap || !b.pilot || (snap.phase !== 'countdown' && snap.phase !== 'racing')) continue;
      const target = b.c.serverTickNow() + 6;
      if (b.lastSent < 0 || b.lastSent < target - 12) b.lastSent = target - 1;
      const controls = b.pilot.read(snap.cars, snap.phase === 'countdown', (now - b.stat.lastSnapAt) / 1000);
      for (let t = b.lastSent + 1; t <= target; t++) b.c.sendInput(t, controls);
      b.lastSent = Math.max(b.lastSent, target);
    }
    setTimeout(loop, Math.max(0, 1000 / 60 - (performance.now() - now) - 1));
  };
  loop();

  const report = () => ({
    clients: bots.length,
    rejected: bots.filter((b) => b.stat.reject).map((b) => b.stat.reject),
    racing: bots.filter((b) => b.stat.racing).length,
  });
  setInterval(() => parentPort.postMessage({ type: 'status', ...report() }), 500);

  parentPort.on('message', (msg) => {
    if (msg.type === 'mark') {
      for (const b of bots) {
        b.measuring = true;
        b.stat.up = b.stat.down = b.stat.snaps = 0;
        b.stat.gaps = [];
        b.stat.late = b.stat.lateFirst = -1;
        b.stat.finished = 0;
      }
      maxLagMs = lagSumMs = lagN = 0;
      parentPort.postMessage({ type: 'marked' });
    } else if (msg.type === 'stop') {
      const secs = msg.seconds;
      const perClient = bots.map((b) => ({
        snapHz: b.stat.snaps / secs,
        downBps: b.stat.down / secs,
        upBps: b.stat.up / secs,
        gaps: b.stat.gaps,
        late: b.stat.late >= 0 && b.stat.lateFirst >= 0 ? Math.max(0, b.stat.late - b.stat.lateFirst) : 0,
        racesFinished: b.stat.finished,
      }));
      for (const b of bots) b.c.close();
      parentPort.postMessage({ type: 'done', perClient, maxLagMs, meanLagMs: lagN ? lagSumMs / lagN : 0 });
    }
  });
  parentPort.postMessage({ type: 'ready' });
}

// ------------------------------------------------------------------------------------------------------------ main
function parseArgs(argv) {
  const o = {
    rooms: [1, 4, 8, 16],
    size: 6,
    measure: 60,
    url: '',
    workers: 0,
    port: 18200,
    track: 'cat_lai',
    laps: 8,
    out: '',
    build: true,
    startTimeout: 120,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--rooms') o.rooms = v().split(',').map(Number);
    else if (a === '--size') o.size = Number(v());
    else if (a === '--measure') o.measure = Number(v());
    else if (a === '--url') o.url = v();
    else if (a === '--workers') o.workers = Number(v());
    else if (a === '--port') o.port = Number(v());
    else if (a === '--track') o.track = v();
    else if (a === '--laps') o.laps = Number(v());
    else if (a === '--out') o.out = v();
    else if (a === '--no-build') o.build = false;
    else if (a === '--help') {
      console.log(readHelp());
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}
const readHelp = () =>
  'node scripts/loadtest.mjs [--rooms 1,4,8,16] [--size 6] [--measure 60] [--url ws://host:port | --port 18200] ' +
  '[--workers N] [--track cat_lai] [--laps 8] [--out result.json] [--no-build]';

async function bundleBots() {
  const esbuild = await import('esbuild');
  // Inside the repo so the bundle's external imports (three, rapier) resolve from node_modules.
  const dir = join(root, 'node_modules', '.cache', `voltline-loadtest-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, 'bots.mjs');
  await esbuild.build({
    stdin: {
      contents: [
        "export { NetClient } from './src/net/NetClient';",
        "export { NetPilot } from './src/net/NetPilot';",
        "export { dataHash } from './src/shared/dataHash';",
        "export { PROTOCOL_VERSION } from './src/shared/protocol';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'bots-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile,
    logLevel: 'error',
  });
  return outfile;
}

/** Nearest-rank percentile of an unsorted numeric array. */
function pct(xs, q) {
  if (xs.length === 0) return 0;
  const s = Float64Array.from(xs).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

/** Parse the Prometheus text we serve into { name: value } (unlabelled and labelled, labels kept in the key). */
function parseProm(text) {
  const m = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    m[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return m;
}

async function startServer(o, maxRooms) {
  const entry = join(root, 'dist-server/index.mjs');
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(o.port),
      HOST: '127.0.0.1',
      MAX_ROOMS: String(maxRooms),
      MAX_CONN_PER_IP: '100000',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.resume();
  const http = `http://127.0.0.1:${o.port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${http}/health`)).ok) return { child, http, ws: `ws://127.0.0.1:${o.port}` };
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  child.kill();
  throw new Error('server did not start');
}

async function runStep(o, botModule, nRooms) {
  const external = o.url !== '';
  let child = null;
  let http;
  let wsUrl;
  if (external) {
    wsUrl = o.url;
    http = o.url.replace(/^ws/, 'http');
  } else {
    const s = await startServer(o, nRooms + 4);
    child = s.child;
    http = s.http;
    wsUrl = s.ws;
  }
  const workers = [];
  try {
    const nWorkers = Math.max(1, Math.min(nRooms, o.workers || Math.ceil(nRooms / 4), Math.max(1, cpus().length - 2)));
    const share = Array.from({ length: nWorkers }, () => []);
    for (let r = 0; r < nRooms; r++) share[r % nWorkers].push(`${process.pid % 1000}-${r}`);
    const status = new Array(nWorkers).fill(null);
    const waiters = [];
    for (let w = 0; w < nWorkers; w++) {
      const worker = new Worker(fileURLToPath(import.meta.url), {
        workerData: { botModule, url: wsUrl, roomIds: share[w], size: o.size, track: o.track, laps: o.laps },
      });
      worker.on('message', (m) => {
        if (m.type === 'status') status[w] = m;
        for (const fn of waiters.splice(0)) fn(w, m);
      });
      worker.on('error', (e) => console.error('worker error', e));
      workers.push(worker);
    }
    const waitFor = (type) =>
      new Promise((resolve) => {
        let n = 0;
        const out = [];
        const fn = (w, m) => {
          if (m.type === type) {
            out[w] = m;
            n++;
          }
          if (n < nWorkers) waiters.push(fn);
          else resolve(out);
        };
        waiters.push(fn);
      });

    // Wait until every bot is in the racing phase.
    const t0 = Date.now();
    for (;;) {
      await sleep(500);
      const s = status.filter(Boolean);
      const rejected = s.flatMap((x) => x.rejected);
      if (rejected.length) throw new Error(`clients rejected: ${[...new Set(rejected)].join(',')}`);
      if (s.length === nWorkers && s.reduce((a, x) => a + x.racing, 0) === nRooms * o.size) break;
      if (Date.now() - t0 > o.startTimeout * 1000) throw new Error('timed out waiting for all rooms to reach racing');
    }
    // Let the first seconds of the race (spawn, countdown release, first contacts) pass, then measure.
    await sleep(3000);
    const m0 = parseProm(await (await fetch(`${http}/metrics`)).text());
    const marked = waitFor('marked');
    const tm0 = performance.now();
    for (const w of workers) w.postMessage({ type: 'mark' });
    await marked;
    const healthSamples = [];
    const end = tm0 + o.measure * 1000;
    while (performance.now() < end) {
      await sleep(Math.min(5000, Math.max(0, end - performance.now())));
      healthSamples.push(await (await fetch(`${http}/health`)).json());
    }
    const seconds = (performance.now() - tm0) / 1000;
    const m1 = parseProm(await (await fetch(`${http}/metrics`)).text());
    const done = waitFor('done');
    for (const w of workers) w.postMessage({ type: 'stop', seconds });
    const results = await done;
    const health = healthSamples[healthSamples.length - 1];

    const clients = results.flatMap((r) => r.perClient);
    const snapHz = clients.map((c) => c.snapHz);
    const gaps = clients.flatMap((c) => c.gaps);
    const g = (k) => m1[k] - m0[k];
    const cpuPct = (g('process_cpu_seconds_total') / seconds) * 100;
    const n = clients.length;
    return {
      rooms: nRooms,
      players: n,
      workers: nWorkers,
      seconds: +seconds.toFixed(1),
      // Server tick window (60 s of steps) at the end of the measurement, and the worst p99 seen at any sample.
      tickP50: health.tickMsP50,
      tickP99: health.tickMsP99,
      tickMax: health.tickMsMax,
      tickP99Worst: Math.max(...healthSamples.map((h) => h.tickMsP99)),
      overruns: g('voltline_tick_overruns_total'),
      stalls: g('voltline_tick_stalls_total'),
      snapHzMean: snapHz.reduce((a, b) => a + b, 0) / n,
      snapHzMin: Math.min(...snapHz),
      snapGapP99Ms: pct(gaps, 0.99),
      snapGapMaxMs: gaps.reduce((a, b) => Math.max(a, b), 0),
      serverSnapsPerSec: g('voltline_sent_bytes_total') > 0 ? health.snapshotsPerSec : 0,
      cpuPctOfOneCore: external ? null : cpuPct,
      rssMb: m1.process_resident_memory_bytes / 1048576,
      downKBpsPerPlayer: clients.reduce((a, c) => a + c.downBps, 0) / n / 1024,
      upKBpsPerPlayer: clients.reduce((a, c) => a + c.upBps, 0) / n / 1024,
      serverBytesPerSec: health.snapshotBytesPerSec,
      lateFrames: clients.reduce((a, c) => a + c.late, 0),
      rateLimitedFrames: m1.voltline_input_rate_limited_frames,
      racesFinished: clients.reduce((a, c) => a + c.racesFinished, 0) / o.size,
      clientLagMaxMs: Math.max(...results.map((r) => r.maxLagMs)),
      clientLagMeanMs: results.reduce((a, r) => a + r.meanLagMs, 0) / results.length,
    };
  } finally {
    for (const w of workers) void w.terminate();
    if (child) {
      child.kill('SIGTERM');
      await sleep(400);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

function printTable(rows) {
  const f = (v, d = 2) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
  const cols = [
    ['rooms', (r) => r.rooms],
    ['players', (r) => r.players],
    ['tick p50 ms', (r) => f(r.tickP50, 3)],
    ['tick p99 ms', (r) => f(r.tickP99, 3)],
    ['p99 worst', (r) => f(r.tickP99Worst, 3)],
    ['tick max ms', (r) => f(r.tickMax, 2)],
    ['overruns', (r) => r.overruns],
    ['snap Hz mean', (r) => f(r.snapHzMean, 2)],
    ['snap Hz min', (r) => f(r.snapHzMin, 2)],
    ['gap p99 ms', (r) => f(r.snapGapP99Ms, 0)],
    ['CPU % core', (r) => f(r.cpuPctOfOneCore, 0)],
    ['RSS MB', (r) => f(r.rssMb, 0)],
    ['down KB/s/pl', (r) => f(r.downKBpsPerPlayer, 1)],
    ['up KB/s/pl', (r) => f(r.upKBpsPerPlayer, 1)],
    ['late', (r) => r.lateFrames],
    ['rate-lim', (r) => r.rateLimitedFrames],
    ['cli lag max ms', (r) => f(r.clientLagMaxMs, 0)],
  ];
  const cells = [cols.map((c) => c[0]), ...rows.map((r) => cols.map((c) => String(c[1](r))))];
  const widths = cols.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  for (const row of cells) console.log(row.map((c, i) => c.padStart(widths[i])).join('  '));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.url) {
    if (o.build) {
      console.log('building server (npm run server:build)...');
      execSync('npm run server:build', { cwd: root, stdio: 'ignore' });
    } else if (!existsSync(join(root, 'dist-server/index.mjs'))) {
      throw new Error('dist-server/index.mjs missing; run without --no-build');
    }
  }
  const botModule = await bundleBots();
  const rows = [];
  for (const n of o.rooms) {
    console.log(`\n== ${n} room(s) x ${o.size} bots, measuring ${o.measure}s ==`);
    try {
      const r = await runStep(o, botModule, n);
      rows.push(r);
      console.log(
        `tick p50/p99/max ${r.tickP50.toFixed(3)}/${r.tickP99.toFixed(3)}/${r.tickMax.toFixed(2)} ms, snap ${r.snapHzMean.toFixed(2)} Hz (min ${r.snapHzMin.toFixed(2)}), cpu ${r.cpuPctOfOneCore?.toFixed(0) ?? '-'}%, client lag max ${r.clientLagMaxMs.toFixed(0)} ms`,
      );
    } catch (e) {
      console.error(`step failed: ${e.message}`);
      break;
    }
  }
  console.log('');
  printTable(rows);
  const ok = rows.filter((r) => r.tickP99Worst < 8 && r.snapHzMin >= 19.5);
  console.log(
    `\npass rule: worst sampled tick p99 < 8 ms and every client >= 19.5 snapshots/s. Largest passing: ${ok.length ? ok[ok.length - 1].rooms : 0} room(s).`,
  );
  if (o.out) {
    mkdirSync(dirname(resolve(o.out)), { recursive: true });
    writeFileSync(o.out, JSON.stringify(rows, null, 2));
  }
}

if (isMainThread) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
} else {
  workerMain().catch((e) => {
    console.error('worker failed', e);
    process.exit(1);
  });
}
