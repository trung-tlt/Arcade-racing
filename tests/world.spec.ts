import { expect, test } from '@playwright/test';

interface State {
  airborne: boolean;
  nitroBars: number;
  rockets: number;
  hp: number;
  heat: number;
  pos: { x: number; y: number; z: number };
}
interface Dbg {
  __voltline: { debugState(): State; debugTeleport(t: number): void };
}

async function boot(page: import('@playwright/test').Page, errors: string[]): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?mode=practice');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => document.querySelector('.race-banner')?.classList.contains('go'), null, {
    timeout: 15_000,
  });
}

// Skipped: the only jump ramp was on Map 1 v1's reefer-lane shortcut, which went with the night map. Track.buildRamps and
// `ramps` in a track JSON still work; no shipped map uses one.
test.skip('driving over the jump ramp launches the car and disables the gun while airborne', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  await page.evaluate(() => (window as unknown as Dbg).__voltline.debugTeleport(0.45));
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyJ');
  await page.waitForFunction(() => (window as unknown as Dbg).__voltline.debugState().airborne, null, {
    timeout: 20_000,
  });
  const air = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState());
  expect(air.heat).toBeLessThan(0.99);
  await page.screenshot({ path: process.env.RAMP_SHOT ?? 'test-results/ramp.png' });
  await page.keyboard.up('KeyJ');
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});

test('driving through a pickup cluster grants its item', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  const before = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState());
  // Cat Lai's cluster at t=0.4351 on the quay straight: rocket / nitro / rocket across the lanes. The centre lane (0) is
  // a nitro pickup, 43 m ahead of the drop point.
  await page.evaluate(() => (window as unknown as Dbg).__voltline.debugTeleport(0.423));
  await page.keyboard.down('KeyW');
  await page.waitForFunction(
    (n) => (window as unknown as Dbg).__voltline.debugState().nitroBars > n,
    before.nitroBars,
    { timeout: 20_000 },
  );
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});
