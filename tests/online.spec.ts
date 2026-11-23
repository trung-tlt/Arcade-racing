import { expect, test, type Page } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';

const PORT = 18123;
let server: ChildProcess | null = null;

test.beforeAll(async () => {
  execSync('npm run server:build', { stdio: 'ignore' });
  server = spawn('node', ['dist-server/index.mjs'], {
    env: { ...process.env, PORT: String(PORT), SOLO_START: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('race server did not start');
});

test.afterAll(() => {
  server?.kill();
});

type Online = {
  live: boolean;
  localTick: number;
  serverTick: number;
  phase: string;
  me: { x: number; z: number; speed: number };
  puppets: { id: string; x: number; z: number; snapX: number; snapZ: number; speed: number }[];
  reconcile: Record<string, number>;
  netEvents: Record<string, number>;
  hp: number;
  pingMs: number;
  minMargin: number;
  advance: number;
  racePhase: string;
  lap: number;
};

const state = (page: Page): Promise<Online | null> =>
  page.evaluate(
    () => (window as unknown as { __voltline?: { debugOnline(): Online | null } }).__voltline?.debugOnline() ?? null,
  );

test('two browsers race each other online on one server', async ({ browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const open = async (name: string, car: string): Promise<Page> => {
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(
      `/?online=ws://127.0.0.1:${PORT}&room=PW${Date.now() % 1000}&name=${name}&car=${car}&track=monte_carlo&laps=1&start=2`,
    );
    return page;
  };
  // The room code must be shared: both pages use the same one.
  const room = `PW${Date.now() % 100000}`;
  const make = async (name: string, car: string): Promise<Page> => {
    // Software rendering with two tabs is slow: a tiny viewport on the Low preset keeps the sim near 60 Hz.
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    await page.addInitScript(() => localStorage.setItem('voltline.settings', JSON.stringify({ preset: 'low' })));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(
      `/?online=ws://127.0.0.1:${PORT}&room=${room}&name=${name}&car=${car}&track=monte_carlo&laps=1&start=2`,
    );
    return page;
  };
  void open;
  const a = await make('Anna', 'kestrel_gt');
  await a
    .waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
      timeout: 5_000,
    })
    .catch(() => undefined);
  const b = await make('Ben', 'wisp_r');
  // Startup timeline: when does each page go live, and how far off the server is it then?
  const t0 = Date.now();
  let liveBoth = false;
  while (!liveBoth && Date.now() - t0 < 90_000) {
    const [x, y] = [await state(a), await state(b)];
    console.log(
      `ONLINE start +${((Date.now() - t0) / 1000).toFixed(1)}s A live=${x?.live} ${x?.localTick}/${x?.serverTick} ${x?.phase} adv=${x?.advance} | B live=${y?.live} ${y?.localTick}/${y?.serverTick} ${y?.phase} adv=${y?.advance}`,
    );
    liveBoth = !!(x?.live && y?.live);
    if (!liveBoth) await a.waitForTimeout(400);
  }
  for (const p of [a, b]) {
    await p.evaluate(() =>
      (
        window as unknown as { __voltline: { debugAutopilot(on: boolean, fight?: boolean): void } }
      ).__voltline.debugAutopilot(true, true),
    );
  }
  const fps = await a.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const f = (): void => {
          n++;
          if (performance.now() - t0 > 2000) resolve(n / 2);
          else requestAnimationFrame(f);
        };
        requestAnimationFrame(f);
      }),
  );
  console.log(`ONLINE page fps ${fps.toFixed(1)}`);
  // Let them race for a while (the countdown is ~4 s).
  for (let i = 0; i < 14; i++) {
    await a.waitForTimeout(1000);
    const [x, y] = [await state(a), await state(b)];
    console.log(
      `ONLINE t=${i} A tick ${x?.localTick}/${x?.serverTick} adv=${x?.advance} mm=${x?.minMargin} | B tick ${y?.localTick}/${y?.serverTick} adv=${y?.advance} mm=${y?.minMargin}`,
    );
  }
  await a.screenshot({ path: 'test-results/online-a.png' });
  await b.screenshot({ path: 'test-results/online-b.png' });
  const [sa, sb] = [await state(a), await state(b)];
  console.log('ONLINE A', JSON.stringify(sa));
  console.log('ONLINE B', JSON.stringify(sb));
  expect(sa && sb).toBeTruthy();
  for (const s of [sa, sb] as Online[]) {
    expect(s.live).toBe(true);
    expect(s.phase).toBe('racing');
    expect(s.me.speed).toBeGreaterThan(5);
    expect(s.puppets).toHaveLength(5); // the other human and four bots
    expect(Math.abs(s.localTick - s.serverTick)).toBeLessThan(60); // the local sim stays within a second of the server
  }
  // Every drawn remote car is where the server's newest snapshot says it is, give or take the interpolation delay
  // (100 ms) and the age of that snapshot: a few tenths of a second of its own speed. A car that has just been
  // teleported (a bot's respawn) is shown at its old spot for the interpolation delay by design, so the bots get a
  // transient allowance; the other human is held to the bound.
  for (const s2 of [sa, sb] as Online[]) {
    const off = s2.puppets.filter((pz) => Math.hypot(pz.x - pz.snapX, pz.z - pz.snapZ) >= pz.speed * 0.6 + 4);
    expect(
      off.filter((pz) => pz.id.startsWith('p')),
      'the other human is drawn where the server says',
    ).toHaveLength(0);
    expect(off.length, 'at most one bot mid-teleport').toBeLessThanOrEqual(1);
  }
  // Combat arrives from the server: shots and hits are seen by both tabs, and the hull of a car that was hit is lower.
  const events = [sa, sb].map((x) => (x as Online).netEvents);
  console.log('ONLINE events', JSON.stringify(events), 'hp', (sa as Online).hp, (sb as Online).hp);
  expect(events.reduce((n, e) => n + (e.gun ?? 0), 0)).toBeGreaterThan(5);
  expect(events.reduce((n, e) => n + (e.hit ?? 0), 0)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await a.close();
  await b.close();
});
