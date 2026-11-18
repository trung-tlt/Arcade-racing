import { expect, test } from '@playwright/test';

interface Dbg {
  __voltline: {
    trackDef: { id: string; name: string; timeOfDay: string };
    debugState(): { position: number; cars: { kind: string; speed: number }[] };
  };
}

test('Cong Hoa Boulevard: a six-car daytime race boots, the rivals drive, and there are no console errors', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/?quick=1&track=cong_hoa');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 80_000,
  });
  const track = await page.evaluate(() => (window as unknown as Dbg).__voltline.trackDef);
  expect(track.id).toBe('cong_hoa');
  expect(track.timeOfDay).toBe('day');

  await page.waitForFunction(() => document.querySelector('.race-banner')?.classList.contains('go'), null, {
    timeout: 40_000,
  });
  await page.waitForFunction(
    () =>
      (window as unknown as Dbg).__voltline.debugState().cars.filter((c) => c.kind === 'ai' && c.speed > 10).length >=
      4,
    null,
    { timeout: 60_000 },
  );
  expect(await page.locator('.race-pos').textContent()).toMatch(/\d\/6/);
  expect(errors).toEqual([]);
});

for (const trackId of ['cat_lai', 'cong_hoa']) {
  test(`${trackId}: the player can drive away from their grid slot (nothing solid at the spawn)`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?quick=1&track=${trackId}`);
    await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
      timeout: 80_000,
    });
    await page.waitForFunction(() => document.querySelector('.race-banner')?.classList.contains('go'), null, {
      timeout: 40_000,
    });
    await page.keyboard.down('KeyW');
    await page.waitForFunction(
      () => ((window as unknown as Dbg).__voltline.debugState().cars.find((c) => c.kind === 'player')?.speed ?? 0) > 12,
      null,
      { timeout: 60_000 },
    );
    await page.keyboard.up('KeyW');
  });
}
