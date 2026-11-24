#!/usr/bin/env node
// netlab: real browser clients race each other on a real race server through links made bad on purpose, then report how
// the game felt in numbers (prediction corrections, hitches, remote-car smoothness, server load). No human needed.
//
//   npm run netlab -- --profile 60ms,mobile --track ardennes --players 2 --seconds 60
//   npm run netlab -- --profile all --track cong_hoa,ardennes --baseline netlab-baseline.json
//
// Options: --profile lan|60ms|150ms|mobile|all  --track <id,id>  --players N  --cars a,b,..  --seconds N (racing window)
//          --render gpu|skip (skip = no GPU draw: many clients per machine, no frame-rate effects)  --out file.json
//          --baseline file.json (print the change against an earlier run)  --save-baseline file.json
import { chromium } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PROFILES, startProxy } from './impair.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const list = (s) => s.split(',').filter(Boolean);
const profiles = arg('profile', '60ms') === 'all' ? Object.keys(PROFILES) : list(arg('profile', '60ms'));
const tracks = list(arg('track', 'cong_hoa'));
const players = Number(arg('players', 2));
const CARS = ['kestrel_gt', 'wisp_r', 'rhino_x4', 'sable_rs', 'warden_px', 'fulmine_fx'];
const cars = list(arg('cars', CARS.join(',')));
const seconds = Number(arg('seconds', 60));
const render = arg('render', 'skip');
// Extra URL parameters for the game under test (A/B a switch): --params ghosts=1
const extra = arg('params', '');
const DEV = 'http://localhost:5173';
const SERVER_PORT = 18200;

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function ensureDevServer() {
  if (await up(DEV)) return null;
  const p = spawn('npm', ['run', 'dev', '--', '--port', '5173'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !(await up(DEV)); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await up(DEV))) throw new Error('dev server did not start');
  return p;
}

function startServer() {
  execSync('npm run server:build', { stdio: 'ignore' });
  const lines = [];
  const p = spawn('node', ['dist-server/index.mjs'], {
    env: { ...process.env, PORT: String(SERVER_PORT), LOG_LEVEL: 'info', REMATCH_SEC: '600', SOLO_START: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        lines.push(JSON.parse(l));
      } catch {
        /* not a log record */
      }
    }
  });
  return { p, lines };
}

const pct = (xs, q) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] : null;

async function scenario(browser, profileName, track) {
  const profile = PROFILES[profileName];
  const { p: server, lines } = startServer();
  for (let i = 0; i < 100 && !(await up(`http://127.0.0.1:${SERVER_PORT}/health`)); i++)
    await new Promise((r) => setTimeout(r, 100));
  const room = `NL${Date.now() % 100000}`;
  const proxies = [];
  const pages = [];
  const errors = [];
  try {
    for (let i = 0; i < players; i++) {
      const port = 18300 + i;
      proxies.push(startProxy({ port, target: `ws://127.0.0.1:${SERVER_PORT}`, profile, seed: 11 + i }));
      const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
      if (process.env.NETLAB_TRACE) await ctx.addInitScript(() => (window.__netlabTrace = true));
      const page = await ctx.newPage();
      await page.addInitScript(() => localStorage.setItem('voltline.settings', JSON.stringify({ preset: 'low' })));
      page.on('pageerror', (e) => errors.push(`P${i + 1}: ${e.message}`));
      if (process.env.NETLAB_DEBUG)
        page.on('console', (m) => console.log(`  [P${i + 1}] ${m.type()} ${m.text().slice(0, 160)}`));
      const url = `${DEV}/?online=ws://127.0.0.1:${port}&room=${room}&name=P${i + 1}&car=${cars[i % cars.length]}&track=${track}&laps=1&start=${players}${render === 'skip' ? '&render=0' : ''}${extra ? `&${extra}` : ''}`;
      await page.goto(url);
      pages.push(page);
    }
    const state = (page) =>
      page.evaluate(() => {
        const g = window.__voltline;
        return g ? { phase: g.debugOnline()?.phase ?? 'none', live: g.debugOnline()?.live ?? false } : null;
      });
    // Wait for the race to go green on every client, put the autopilots on, then measure a fixed window.
    const t0 = Date.now();
    for (;;) {
      const s = await Promise.all(pages.map(state));
      if (s.every((x) => x && x.phase === 'racing')) break;
      if (Date.now() - t0 > 120_000) {
        const txt = await Promise.all(
          pages.map((pg) =>
            pg.evaluate(() => document.body.innerText.slice(0, 120).replace(/\s+/g, ' ')).catch(() => '?'),
          ),
        );
        throw new Error(
          `race never started: ${JSON.stringify(s)} ${JSON.stringify(txt)} ${JSON.stringify(lines.slice(-3))}`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await Promise.all(
      pages.map((pg) =>
        pg.evaluate(() => {
          const g = window.__voltline;
          g.debugAutopilot(true, false);
          g.netDebug.reset();
          if (new URLSearchParams(location.search).has('trace') || window.__netlabTrace) {
            window.__trace = [];
            setInterval(() => {
              const d = g.debugOnline();
              const c = g.car.physics;
              const sc = g.online.session.snap?.cars.find((q) => q.id === g.online.selfId);
              window.__trace.push({
                lt: d.localTick,
                x: +d.me.x.toFixed(1),
                z: +c.curr.p.z.toFixed(1),
                y: +c.curr.p.y.toFixed(2),
                v: +d.me.speed.toFixed(1),
                st: +c.steerAngle.toFixed(3),
                br: c.braking ? 1 : 0,
                air: c.airborne ? 1 : 0,
                stk: g.online.session.snap?.tick ?? -1,
                sx: sc ? +sc.p[0].toFixed(1) : null,
                sz: sc ? +sc.p[2].toFixed(1) : null,
                sv: sc ? +Math.hypot(sc.v[0], sc.v[2]).toFixed(1) : null,
                sy: sc ? +sc.p[1].toFixed(2) : null,
              });
            }, 16);
          }
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const clients = await Promise.all(
      pages.map((pg) =>
        pg.evaluate(() => ({
          stats: window.__voltline.netStats(),
          online: window.__voltline.debugOnline(),
          trace: window.__trace ?? null,
          log: window.__trace ? window.__voltline.online.session.log.filter((r) => r.errM > 0.5).slice(0, 60) : null,
        })),
      ),
    );
    if (process.env.NETLAB_TRACE)
      clients.forEach((c, i) => {
        if (!c.log) return;
        console.log(
          `\n  P${i + 1} corrections over 0.5 m (server tick, kind, err m | car at that tick: x z y speed steer brake air)`,
        );
        const byLt = new Map(c.trace.map((t) => [t.lt, t]));
        const byStk = new Map(c.trace.map((t) => [t.stk, t]));
        for (const r of c.log) {
          let me, sv;
          for (let d = 0; d <= 2 && !me; d++) me = byLt.get(r.tick + d) ?? byLt.get(r.tick - d);
          sv = byStk.get(r.tick);
          console.log(
            `   ${String(r.tick).padStart(6)} ${r.kind.padEnd(6)} ${r.errM.toFixed(2).padStart(6)} | client ${me ? `x${me.x} z${me.z} y${me.y} v${me.v} st${me.st} br${me.br}` : '-'} | server ${sv && sv.sx !== null ? `x${sv.sx} z${sv.sz} y${sv.sy} v${sv.sv}` : '-'}`,
          );
        }
      });
    const samples = lines.filter((l) => l.event === 'race_sample');
    const serverSamples = lines.filter((l) => l.event === 'server_sample');
    const missed = samples.flatMap((s) => s.players.map((p) => p.missed));
    const late = samples.flatMap((s) => s.players.map((p) => p.late));
    return {
      profile: profileName,
      track,
      players,
      seconds,
      render,
      params: extra,
      clients: clients.map((c, i) => ({
        name: `P${i + 1}`,
        ...c.stats,
        meX: c.online ? Math.round(c.online.me.x) : null,
        lap: c.online?.lap,
      })),
      server: {
        raceSamples: samples.length,
        missedTicksP95: pct(missed, 0.95),
        lateFramesTotal: late.reduce((a, b) => a + b, 0),
        snapBytes: samples.length ? samples[samples.length - 1].snapBytes : null,
        tickMsP99: serverSamples.length ? Math.max(...serverSamples.map((s) => s.tickMsP99)) : null,
        rssMb: serverSamples.length ? Math.max(...serverSamples.map((s) => s.rssMb)) : null,
      },
      errors,
    };
  } finally {
    for (const pg of pages)
      await pg
        .context()
        .close()
        .catch(() => undefined);
    for (const px of proxies) await px.close();
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** The headline numbers per scenario: the worst client, so one bad seat cannot hide behind a good one. */
function headline(r) {
  const worst = (k) => Math.max(...r.clients.map((c) => c[k] ?? 0));
  const best = (k) => Math.min(...r.clients.map((c) => c[k] ?? Infinity));
  return {
    fps: best('fps'),
    frameP95Ms: worst('frameP95Ms'),
    hitches: worst('hitchesOver33ms'),
    snapGapP95Ms: worst('snapGapP95Ms'),
    interpDelayMs: worst('interpDelayMs'),
    reconOver50cm: worst('reconOver50cm'),
    reconSnap: worst('reconSnap'),
    reconMaxErrM: worst('reconMaxErrM'),
    extrapolatingPct: worst('extrapolatingPct'),
    holdPerMin: worst('holdPerMin'),
    catchUpPerMin: worst('catchUpPerMin'),
    serverTickP99: r.server.tickMsP99,
    serverMissedTicksP95: r.server.missedTicksP95,
  };
}

const dev = await ensureDevServer();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
  ],
});
const results = [];
try {
  for (const track of tracks)
    for (const prof of profiles) {
      process.stdout.write(`netlab ${prof} on ${track}, ${players} players, ${seconds}s ... `);
      try {
        const r = await scenario(browser, prof, track);
        r.headline = headline(r);
        results.push(r);
        console.log(JSON.stringify(r.headline));
      } catch (e) {
        console.log(`FAILED ${e.message}`);
        results.push({ profile: prof, track, error: String(e.message) });
      }
    }
} finally {
  await browser.close();
  dev?.kill();
}

const out = arg('out', `netlab-out/${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
mkdirSync('netlab-out', { recursive: true });
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nfull results: ${out}`);
const saveBase = arg('save-baseline');
if (saveBase) {
  writeFileSync(
    saveBase,
    JSON.stringify(
      results.map(({ profile, track, headline: h }) => ({ profile, track, headline: h })),
      null,
      2,
    ),
  );
  console.log(`baseline saved: ${saveBase}`);
}
const baseFile = arg('baseline');
if (baseFile) {
  const base = JSON.parse(readFileSync(baseFile, 'utf8'));
  for (const r of results) {
    const b = base.find((x) => x.profile === r.profile && x.track === r.track);
    if (!b || !r.headline) continue;
    const rows = Object.keys(r.headline).map((k) => {
      const now = r.headline[k];
      const was = b.headline[k];
      const d = typeof now === 'number' && typeof was === 'number' ? +(now - was).toFixed(2) : '';
      return `  ${k.padEnd(22)} ${String(was).padStart(8)} -> ${String(now).padStart(8)}  ${d === '' ? '' : (d > 0 ? '+' : '') + d}`;
    });
    console.log(`\n${r.profile} / ${r.track} vs baseline\n${rows.join('\n')}`);
  }
}
process.exit(0);
