import { expect, test } from '@playwright/test';

interface Dbg {
  __voltline: {
    debugState(): {
      takedowns: number;
      score: number;
      heat: number;
      cars: { id: string; hp: number; wrecked: boolean }[];
    };
  };
}

test('player can wreck a dummy with the Pulse MG and it respawns', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  // Cong Hoa: a straight start with the dummies dead ahead (Cat Lai opens with a bend, so holding W alone ends in its wall).
  await page.goto('/?mode=practice&track=cong_hoa');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => document.querySelector('.race-banner')?.classList.contains('go'), null, {
    timeout: 15_000,
  });

  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyJ');
  await page.waitForFunction(
    () =>
      (window as unknown as Dbg).__voltline
        .debugState()
        .cars.some((c) => c.id.startsWith('dummy') && (c.wrecked || c.hp < 100)),
    null,
    { timeout: 40_000 },
  );
  const hit = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState());
  expect(hit.heat).toBeGreaterThan(0);
  await page.screenshot({ path: process.env.COMBAT_SHOT ?? 'test-results/combat.png' });

  await page.waitForFunction(() => (window as unknown as Dbg).__voltline.debugState().takedowns >= 1, null, {
    timeout: 60_000,
  });
  const done = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState());
  expect(done.score).toBeGreaterThanOrEqual(250);
  await page.keyboard.up('KeyJ');
  await page.waitForFunction(
    () =>
      (window as unknown as Dbg).__voltline
        .debugState()
        .cars.filter((c) => c.id.startsWith('dummy'))
        .every((c) => !c.wrecked),
    null,
    { timeout: 15_000 },
  );
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});
