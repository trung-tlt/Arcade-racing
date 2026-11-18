import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const cars = JSON.parse(readFileSync('data/cars.json', 'utf8')) as { id: string }[];

interface Dbg {
  __voltline: { debugState(): { cars: { id: string; vehicle: string; kind: string; speed: number; hp: number }[] } };
  __voltlineApp: { start(id: string, mode?: string): Promise<void> };
}

test('every vehicle in the garage boots, drives and renders without console errors', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/?mode=practice');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 40_000,
  });

  for (const car of cars) {
    await page.evaluate((id) => (window as unknown as Dbg).__voltlineApp.start(id), car.id);
    await page.waitForFunction(() => document.querySelector('.race-banner')?.classList.contains('go'), null, {
      timeout: 30_000,
    });
    await page.keyboard.down('KeyW');
    // Software rendering runs slower than real time, so wait for the vehicle to move rather than for a fixed time.
    await page
      .waitForFunction(
        () =>
          ((window as unknown as Dbg).__voltline.debugState().cars.find((c) => c.kind === 'player')?.speed ?? 0) > 6,
        null,
        { timeout: 40_000 },
      )
      .catch(() => undefined);
    await page.waitForTimeout(500);
    const me = await page.evaluate(
      () => (window as unknown as Dbg).__voltline.debugState().cars.find((c) => c.kind === 'player') ?? null,
    );
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/veh-${car.id}.png` });
    await page.keyboard.up('KeyW');
    console.log(`VEH ${car.id} speed=${me?.speed.toFixed(1)} m/s`);
    const inPlay = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState().cars[0].vehicle);
    expect(inPlay, 'the requested vehicle must be the one in play').toBe(car.id);
    expect(me, car.id).not.toBeNull();
    expect(me!.speed, `${car.id} should be moving`).toBeGreaterThan(4);
  }
  expect(errors).toEqual([]);
});
