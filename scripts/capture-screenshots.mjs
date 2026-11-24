// Captures the README screenshots into docs/screenshots/ from a running dev server (npm run dev, port 5173).
//   CHROMIUM_PATH=/path/to/chrome node scripts/capture-screenshots.mjs [baseUrl]
// Races are driven by the dev-only autopilot (window.__voltline), so this works against `npm run dev` only.
// The online lobby shot starts its own race server on port 18199 (run `npm run server:build` first).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = new URL('../docs/screenshots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

/** Dev builds draw a tuning panel and an FPS counter over the game: hide them for the screenshots. */
const hideDevOverlays = (page) =>
  page.evaluate(() => {
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const stats = cs.position === 'fixed' && r.top < 4 && r.left < 4 && r.width < 120 && r.height < 80;
      if (el.classList.contains('lil-gui') || el.classList.contains('fps-counter') || stats) el.style.display = 'none';
    }
  });

const shot = async (page, name) => {
  await hideDevOverlays(page);
  await page.screenshot({ path: `${out}${name}.jpg`, type: 'jpeg', quality: 82 });
};

async function unlock(page) {
  await page.getByText('PRESS ENTER TO START').waitFor({ timeout: 60_000 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
}

async function race(name, track, car, { viewport = { width: 1280, height: 720 }, touch = false, wait = 22_000 } = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('voltline.name', 'LINH'));
  await page.goto(`${base}/?quick=1&track=${track}&car=${car}`);
  await unlock(page).catch(() => undefined);
  await page.waitForFunction(() => !!window.__voltline, null, { timeout: 90_000 });
  await page.evaluate(() => window.__voltline.debugAutopilot(true, true));
  await page.waitForTimeout(wait);
  await shot(page, name);
  await ctx.close();
}

// Menus
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(base);
  await unlock(page);
  await page.waitForTimeout(2500);
  await shot(page, 'title');
  await page.getByRole('button', { name: /^GARAGE/ }).click();
  await page.waitForTimeout(16_000); // the garage renders its thumbnails one by one
  await shot(page, 'car-select');
  await ctx.close();
}

// Races: one per kind of map, plus a phone-landscape frame with the touch controls.
await race('race-cat-lai', 'cat_lai', 'kestrel_gt');
await race('race-pham-van-dong', 'pham_van_dong', 'rhino_x4', { wait: 30_000 });
await race('race-monte-carlo', 'monte_carlo', 'fulmine_fx', { wait: 26_000 });
await race('race-ardennes', 'ardennes', 'fulmine_fx', { wait: 40_000 });
await race('race-hanoi', 'xa_lo_ha_noi', 'wisp_r');
await race('race-phone', 'cat_lai', 'kestrel_gt', { viewport: { width: 844, height: 390 }, touch: true });

// Online lobby with two players.
const server = spawn('node', ['dist-server/index.mjs'], { env: { ...process.env, PORT: '18199' }, stdio: 'ignore' });
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch('http://127.0.0.1:18199/health')).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const open = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    await page.addInitScript((n) => localStorage.setItem('voltline.name', n), name);
    await page.goto(`${base}/?server=ws://127.0.0.1:18199`);
    await unlock(page);
    await page.getByRole('button', { name: /^ONLINE/ }).click();
    return page;
  };
  const a = await open('LINH');
  const b = await open('NGOC LAN');
  await shot(a, 'online-hub');
  await a.getByRole('button', { name: /^CREATE ROOM/ }).click();
  await a.locator('.ol-code-val').waitFor();
  const code = (await a.locator('.ol-code-val').innerText()).replace('·', '');
  await b.getByLabel(/Room code/).fill(code);
  await b.getByRole('button', { name: 'JOIN', exact: true }).click();
  await b.getByRole('button', { name: /Enter lobby/ }).click();
  await a.locator('.mn-lobby .ol-row:not(.empty)').nth(1).waitFor();
  await a.getByRole('button', { name: /^READY UP/ }).click();
  await b.getByRole('button', { name: /^READY UP/ }).click();
  await a.waitForTimeout(1500);
  await shot(a, 'online-lobby');
} finally {
  server.kill();
}
await browser.close();
console.log(`screenshots written to ${out}`);
