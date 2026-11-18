import { expect, test } from '@playwright/test';

test('practice mode: boots, counts down, and the car drives forward for 5 s with no console errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/?mode=practice');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 30_000,
  });
  await expect(page.locator('.race-banner')).toBeVisible(); // 3-2-1 countdown

  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => document.querySelector('.race-banner')?.classList.contains('go'), null, {
    timeout: 10_000,
  });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: process.env.SMOKE_SHOT ?? 'test-results/smoke.png' });

  const speed = Number(await page.locator('.hud-speed-val').textContent());
  const time = await page.locator('.race-time').textContent();
  await page.keyboard.up('KeyW');

  expect(speed).toBeGreaterThan(20);
  expect(time).not.toBe('0:00.000');
  expect(errors).toEqual([]);
});
