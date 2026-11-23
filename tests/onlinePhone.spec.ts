import { expect, test, type Page } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';

// The online screens on a phone-sized landscape viewport, and the client budget (draw calls, triangles) in a 6-car online race.
const PORT = 18125;
const SERVER = `ws://127.0.0.1:${PORT}`;
let server: ChildProcess | null = null;

test.beforeAll(async () => {
  execSync('npm run server:build', { stdio: 'ignore' });
  server = spawn('node', ['dist-server/index.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('race server did not start');
});
test.afterAll(() => server?.kill());

const shot = async (page: Page, name: string): Promise<void> => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/${name}.png` });
};

/** Elements of the visible menu screen that stick out past the viewport (sideways, or below the fold). */
async function overflow(page: Page): Promise<{ sideways: string[]; below: string[] }> {
  return page.evaluate(() => {
    const out = { sideways: [] as string[], below: [] as string[] };
    const screen = [...document.querySelectorAll<HTMLElement>('#screens > .mn')].find((e) => !e.hidden);
    if (!screen) return out;
    for (const el of screen.querySelectorAll<HTMLElement>('button, input, h2, .ol-row, .ol-state')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const label = `${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0]} "${(el.textContent ?? '').trim().slice(0, 24)}"`;
      if (r.right > innerWidth + 1 || r.left < -1) out.sideways.push(label);
      if (r.bottom > innerHeight + 1) out.below.push(label);
    }
    return out;
  });
}

async function openOnline(page: Page, named: boolean): Promise<void> {
  if (named)
    await page.addInitScript(() => localStorage.setItem('voltline.name', `P${Math.floor(Math.random() * 900)}`));
  await page.goto(`/?server=${SERVER}`);
  await expect(page.getByText(/PRESS ENTER TO START|TAP TO START/i)).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^ONLINE/ })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /^ONLINE/ }).click();
}

test('phone landscape: name, hub, lobby fit the screen; a 6-car online race stays in the draw budget', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const phone = await (
    await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true })
  ).newPage();
  const desktop = await browser.newPage();
  const report: Record<string, unknown> = {};

  await openOnline(phone, false);
  await expect(phone.getByRole('heading', { name: 'Pick a racer name' })).toBeVisible();
  await phone.getByLabel('RACER NAME').fill('Ngọc Lan');
  await shot(phone, 'phone-name-accents');
  report.name = await overflow(phone);
  await phone.getByLabel('RACER NAME').fill('Ngoc Lan');
  await phone.getByRole('button', { name: /^CONTINUE/ }).click();
  await expect(phone.getByRole('heading', { name: 'Race online' })).toBeVisible();
  await shot(phone, 'phone-hub');
  report.hub = await overflow(phone);
  await phone.getByLabel(/Room code/).fill('ZZZZZZ');
  await phone.getByRole('button', { name: 'JOIN', exact: true }).click();
  await expect(phone.getByText('No room with that code')).toBeVisible();
  await shot(phone, 'phone-hub-notfound');
  report.hubError = await overflow(phone);

  await phone.getByRole('button', { name: /^CREATE ROOM/ }).click();
  await expect(phone.getByRole('heading', { name: /Lobby/ })).toBeVisible();
  await shot(phone, 'phone-lobby-alone');
  report.lobbyAlone = await overflow(phone);
  const code = (await phone.locator('.ol-code-val').innerText()).replace('·', '');

  await openOnline(desktop, true);
  await desktop.getByLabel(/Room code/).fill(code);
  await desktop.getByRole('button', { name: 'JOIN', exact: true }).click();
  await desktop.getByRole('button', { name: /Enter lobby/ }).click();
  await expect(phone.locator('.mn-lobby .ol-row:not(.empty)')).toHaveCount(2);
  await shot(phone, 'phone-lobby-two');
  report.lobbyTwo = await overflow(phone);
  await phone.getByRole('button', { name: /^READY UP/ }).click();
  await desktop.getByRole('button', { name: /^READY UP/ }).click();
  await expect(phone.getByText('Everyone is ready · countdown starts for all')).toBeVisible();
  await shot(phone, 'phone-lobby-ready');
  await phone.getByRole('button', { name: /START RACE/ }).click();

  // The loading layer, then the race itself.
  await phone
    .locator('.orr-loading .orr-card')
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  await shot(phone, 'phone-loading');
  report.loading = await phone.evaluate(() => {
    const c = document.querySelector('.orr-card')?.getBoundingClientRect();
    return c
      ? { w: Math.round(c.width), h: Math.round(c.height), fits: c.bottom <= innerHeight && c.right <= innerWidth }
      : null;
  });
  for (const p of [phone, desktop]) {
    await expect(p.locator('canvas#game')).toBeVisible({ timeout: 60_000 });
    await p.waitForFunction(() => !!(window as unknown as { __voltline?: unknown }).__voltline);
    await p.evaluate(() =>
      (
        window as unknown as { __voltline: { debugAutopilot(on: boolean, fight: boolean): void } }
      ).__voltline.debugAutopilot(true, true),
    );
  }
  await phone.waitForTimeout(15_000); // past the countdown, cars moving, other cars in view
  await shot(phone, 'phone-race');
  await shot(desktop, 'desktop-race');
  const stats = async (p: Page): Promise<{ drawCalls: number; triangles: number }> =>
    p.evaluate(() => {
      const s = (
        window as unknown as { __voltline: { debugState(): { drawCalls: number; triangles: number } } }
      ).__voltline.debugState();
      return { drawCalls: s.drawCalls, triangles: s.triangles };
    });
  // Sample a few times: the peak is what the budget is about.
  const peak = { phone: { drawCalls: 0, triangles: 0 }, desktop: { drawCalls: 0, triangles: 0 } };
  for (let i = 0; i < 10; i++) {
    for (const [k, p] of [
      ['phone', phone],
      ['desktop', desktop],
    ] as const) {
      const s = await stats(p);
      peak[k].drawCalls = Math.max(peak[k].drawCalls, s.drawCalls);
      peak[k].triangles = Math.max(peak[k].triangles, s.triangles);
    }
    await phone.waitForTimeout(800);
  }
  report.peak = peak;
  console.log('PHONE REPORT', JSON.stringify(report, null, 1));

  for (const k of ['name', 'hub', 'hubError', 'lobbyAlone', 'lobbyTwo'] as const) {
    expect((report[k] as { sideways: string[] }).sideways, `${k} sticks out sideways`).toEqual([]);
  }
  expect(peak.phone.drawCalls).toBeLessThan(350);
  expect(peak.desktop.drawCalls).toBeLessThan(350);
  expect(peak.phone.triangles).toBeLessThan(400_000);
  expect(peak.desktop.triangles).toBeLessThan(400_000);
  await Promise.all([phone.close(), desktop.close()]);
});
