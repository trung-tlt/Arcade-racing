import { expect, test, type Page } from '@playwright/test';

interface Dbg {
  __voltline: {
    debugState(): { memory: { geometries: number; textures: number } };
    debugFinishRace(): void;
  };
  __voltlineApp: { state(): string; cycle(n: number): Promise<void> };
}

const shot = async (page: Page, name: string): Promise<void> => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/${name}.png` });
};

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('a new player can go title → car select → setup → race → pause → quit', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.getByText('PRESS ENTER TO START')).toBeVisible({ timeout: 30_000 });
  await shot(page, '1-loading');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('button', { name: /^RACE/ })).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '2-title');
  await page.getByRole('button', { name: /^RACE/ }).click();

  await expect(page.getByText('Choose your ride')).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '3-carselect');
  await page
    .getByRole('button', { name: /Wisp R/ })
    .first()
    .click();
  await page.getByRole('button', { name: /select/i }).click();

  await expect(page.getByRole('heading', { name: 'Set up the race' })).toBeVisible();
  await shot(page, '4-setup');
  await page.getByRole('button', { name: /START RACE/i }).click();

  await expect(page.locator('.race-banner')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByText('PAUSED')).toBeVisible();
  await shot(page, '5-pause');
  await page.keyboard.press('Escape'); // resume
  await expect(page.getByText('PAUSED')).toBeHidden();
  await page.waitForTimeout(600); // pause must not immediately re-trigger
  await expect(page.getByText('PAUSED')).toBeHidden();

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Quit to main menu/ }).click();
  await expect(page.getByRole('button', { name: /^RACE/ })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Dbg).__voltlineApp.state())).toBe('title');
  expect(errors).toEqual([]);
});

test('finishing a race shows the results table, and RACE AGAIN restarts', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?quick=1');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => document.querySelector('.race-banner')?.classList.contains('go'), null, {
    timeout: 15_000,
  });
  await page.evaluate(() => (window as unknown as Dbg).__voltline.debugFinishRace());
  await expect(page.getByText(/You finished/)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.res-table tbody tr')).toHaveCount(6);
  await shot(page, '6-results');
  await page.getByRole('button', { name: /RACE AGAIN/i }).click();
  await expect(page.locator('.race-banner')).toBeVisible();
  expect(errors).toEqual([]);
});

test('restarting a race 20 times does not grow GPU resources', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await page.goto('/?quick=1');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 30_000,
  });
  await page.evaluate(() => (window as unknown as Dbg).__voltlineApp.cycle(2));
  await page.waitForTimeout(1500);
  const warm = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState().memory);
  await page.evaluate(() => (window as unknown as Dbg).__voltlineApp.cycle(20));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState().memory);
  console.log(`MEM warm=${JSON.stringify(warm)} after20=${JSON.stringify(after)}`);
  expect(after.geometries).toBeLessThanOrEqual(warm.geometries);
  expect(after.textures).toBeLessThanOrEqual(warm.textures);
  expect(errors).toEqual([]);
});
