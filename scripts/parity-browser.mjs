// Runs an AI-only race in the real browser game (player on autopilot, fire held) and prints per-car lap times, so
// the headless sim can be compared against it. Usage (dev server on :5173):
//   CHROMIUM_PATH=... [FIGHT=1] node scripts/parity-browser.mjs [trackId ...]  > out.json
// FIGHT=1 lets the rivals shoot (default holds fire) and counts wrecks.
import { chromium } from '@playwright/test';

const ALL = ['cat_lai', 'cong_hoa', 'xa_lo_ha_noi', 'pham_van_dong', 'monte_carlo', 'ardennes'];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const base = process.env.BASE_URL ?? 'http://localhost:5173';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const out = {};
for (const id of ids) {
  const page = await browser.newPage();
  await page.goto(`${base}/?quick=1&track=${id}&roster=data&car=kestrel_gt`);
  await page.waitForFunction(() => window.__voltline !== undefined, null, { timeout: 60_000 });
  const fight = process.env.FIGHT === '1';
  out[id] = await page.evaluate((fight) => {
    const g = window.__voltline;
    g.debugAutopilot(true);
    g.debugAiHoldFire(!fight);
    const wrecks = {};
    g.events.on('carWrecked', (e) => {
      wrecks[e.carId] = (wrecks[e.carId] ?? 0) + 1;
    });
    let res = {};
    for (let i = 0; i < 12; i++) {
      res = g.debugFastForward(60); // up to 12 simulated minutes
      if (Object.values(res).every((c) => c.phase === 'finished')) break;
    }
    return Object.fromEntries(
      Object.entries(res).map(([k, v]) => [
        k,
        { time: v.timeSec, laps: v.laps, recoveries: v.recoveries, place: v.place, wrecks: wrecks[k] ?? 0 },
      ]),
    );
  }, fight);
  await page.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close();
