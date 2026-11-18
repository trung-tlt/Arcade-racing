import { expect, test } from '@playwright/test';

interface CarState {
  id: string;
  kind: string;
  t: number;
  lap: number;
  speed: number;
  place: number;
}
interface Dbg {
  __voltline: { debugState(): { position: number; drawCalls: number; cars: CarState[] } };
}

test('race mode: 6 cars on the grid, the 5 rivals drive, live position is shown', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/?quick=1');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 30_000,
  });
  const start = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState());
  expect(start.cars).toHaveLength(6);
  expect(start.cars.filter((c) => c.kind === 'ai')).toHaveLength(5);
  await page.waitForFunction(() => (window as unknown as Dbg).__voltline.debugState().position === 6, null, {
    timeout: 10_000,
  }); // player starts P6

  await page.waitForFunction(() => document.querySelector('.race-banner')?.classList.contains('go'), null, {
    timeout: 15_000,
  });
  await page.waitForTimeout(6000);
  const now = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState());
  const moving = now.cars.filter((c) => c.kind === 'ai' && c.speed > 10);
  expect(moving.length).toBeGreaterThanOrEqual(4);
  expect(await page.locator('.race-pos').textContent()).toMatch(/\d\/6/);
  await page.screenshot({ path: process.env.RACE_SHOT ?? 'test-results/race.png' });
  console.log(`RACE draw calls: ${now.drawCalls}`);
  expect(errors).toEqual([]);
});
