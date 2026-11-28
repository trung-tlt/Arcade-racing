import { expect, test, type Page } from '@playwright/test';

/** Loading prompt → Title → Car select → Race setup, by keyboard. */
async function toRaceSetup(page: Page, url: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await expect(page.getByRole('button', { name: /^RACE/ })).toBeVisible({ timeout: 40_000 });
  await page.keyboard.press('Enter');
  await expect(page.getByText('Choose your ride')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Set up the race' })).toBeVisible();
  return errors;
}

const pills = (page: Page) => page.locator('[data-group="track"] .pill');
const picked = (page: Page, group: string) => page.locator(`[data-group="${group}"] [aria-pressed="true"]`);

test('race setup lists the 4 visible maps (Cong Hoa, Hanoi and Pham Van Dong are hidden)', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await toRaceSetup(page, '/');
  await expect(pills(page)).toHaveCount(4);
  await expect(pills(page)).toHaveText([
    'Cat Lai Port',
    'Monte-Carlo Harbour',
    'Ardennes Forest Circuit',
    'Suzuka Hills Circuit',
  ]);

  // The start screen is Cat Lai with 3 laps; T walks Monte-Carlo → Ardennes → Suzuka and wraps.
  await expect(picked(page, 'laps')).toHaveText('3 laps');
  await page.keyboard.press('l');
  await expect(picked(page, 'laps')).toHaveText('5 laps');
  await page.keyboard.press('t'); // Monte-Carlo
  await expect(page.locator('.mn-setup .tname')).toHaveText('Monte-Carlo Harbour');
  await expect(picked(page, 'laps')).toHaveText('5 laps');
  await page.keyboard.press('t'); // Ardennes
  await expect(page.locator('.mn-setup .tname')).toHaveText('Ardennes Forest Circuit');
  await expect(picked(page, 'laps')).toHaveText('5 laps');
  await page.keyboard.press('t'); // Suzuka Hills
  await expect(page.locator('.mn-setup .tname')).toHaveText('Suzuka Hills Circuit');
  await expect(picked(page, 'laps')).toHaveText('5 laps');
  await page.keyboard.press('t'); // wraps to Cat Lai
  await expect(page.locator('.mn-setup .tname')).toHaveText('Cat Lai Port');
  await expect(picked(page, 'laps')).toHaveText('5 laps');
  await page.keyboard.press('ArrowLeft'); // clamps at the first map
  await expect(page.locator('[data-group="laps"] .pill')).toHaveText(['1 lap', '3 laps', '5 laps']);

  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('the four map buttons use short labels and all fit on one row', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await toRaceSetup(page, '/?touch=1');
    await expect(pills(page)).toHaveCount(4);
    // The DOM keeps the full names; CSS paints the short label (`::after`) and hides the full text on phones.
    const labels = await pills(page).evaluateAll((els) =>
      els.map((e) => ({
        short: getComputedStyle(e, '::after').content.replace(/"/g, ''),
        size: getComputedStyle(e).fontSize,
      })),
    );
    expect(labels.map((l) => l.short)).toEqual(['Cat Lai', 'Monaco', 'Ardennes', 'Suzuka']);
    expect(labels.every((l) => l.size === '0px')).toBe(true);
    const boxes = await pills(page).evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { top: Math.round(r.top), right: r.right, left: r.left };
      }),
    );
    expect(new Set(boxes.map((b) => b.top)).size).toBe(1); // one row
    expect(Math.max(...boxes.map((b) => b.right))).toBeLessThanOrEqual(844);
    expect(errors).toEqual([]);
  });
});

test('Pham Van Dong boots as a six-car storm race with no console errors, and the player can drive', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?quick=1&mode=race&track=pham_van_dong&car=kestrel_gt');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 60_000,
  });
  type Dbg = {
    __voltline: { debugState(): { cars: unknown[]; pos: { z: number } }; debugFastForward(s: number): void };
  };
  const state = () => page.evaluate(() => (window as unknown as Dbg).__voltline.debugState());
  expect((await state()).cars).toHaveLength(6);
  await page.keyboard.down('w');
  // Step the simulation until the car has left the grid (the countdown eats the first seconds, and a loaded machine
  // renders slowly), rather than assuming a fixed amount is enough.
  for (let i = 0; i < 10 && (await state()).pos.z > -50; i++) {
    await page.evaluate(() => (window as unknown as Dbg).__voltline.debugFastForward(5));
  }
  await page.keyboard.up('w');
  expect((await state()).pos.z).toBeLessThan(-50); // north is -Z: the car left the grid
  expect(errors.filter((e) => !/AudioContext/.test(e))).toEqual([]);
});
