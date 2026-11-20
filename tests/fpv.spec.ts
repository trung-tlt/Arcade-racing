import { expect, test } from '@playwright/test';

interface Fpv {
  view: string;
  hud: string;
  mirror: boolean;
  hasRig: boolean;
  rigVisible: boolean;
  carHidden: boolean;
  riderHidden: boolean;
  lookBack: number;
  fov: number;
  blend: number;
  threat: boolean;
}
type Dbg = {
  __voltline: {
    debugFpv(): Fpv;
    debugFastForward(s: number): unknown;
    debugState(): { drawCalls: number; triangles: number; memory: { geometries: number; textures: number } };
  };
  __voltlineApp: { cycle(n: number): Promise<void> };
};
const fpv = (page: import('@playwright/test').Page): Promise<Fpv> =>
  page.evaluate(() => (window as unknown as Dbg).__voltline.debugFpv());

async function boot(page: import('@playwright/test').Page, car: string, errors: string[]): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?quick=1&mode=practice&track=cong_hoa&car=${car}`);
  await page.waitForFunction(() => (window as unknown as Partial<Dbg>).__voltline !== undefined, null, {
    timeout: 90_000,
  });
  await page.waitForTimeout(1500);
}

test('V cycles chase → hood → cockpit: the rig shows, the car hides, C looks back, H and M toggle', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  await boot(page, 'kestrel_gt', errors);
  expect((await fpv(page)).view).toBe('chase');

  await page.keyboard.press('v');
  await expect.poll(async () => (await fpv(page)).view).toBe('hood');
  await page.keyboard.press('v');
  await expect.poll(async () => (await fpv(page)).view).toBe('cockpit');
  await expect.poll(async () => (await fpv(page)).rigVisible, { timeout: 30_000 }).toBe(true);
  const inside = await fpv(page);
  expect(inside.hasRig).toBe(true);
  expect(inside.carHidden).toBe(true);
  expect(inside.fov).toBeCloseTo(64, 0);
  expect(await page.locator('.view-toast').textContent()).toContain('COCKPIT');

  // Look over the shoulder while C is held; the cockpit hides, then comes back.
  await page.keyboard.down('c');
  await expect.poll(async () => (await fpv(page)).lookBack, { timeout: 30_000 }).toBeGreaterThan(0.9);
  expect((await fpv(page)).rigVisible).toBe(false);
  await page.keyboard.up('c');
  await expect.poll(async () => (await fpv(page)).rigVisible, { timeout: 30_000 }).toBe(true);

  await page.keyboard.press('h');
  await expect.poll(async () => (await fpv(page)).hud).toBe('minimal');
  await page.keyboard.press('m');
  await expect.poll(async () => (await fpv(page)).mirror).toBe(false);
  await page.keyboard.press('m');
  await expect.poll(async () => (await fpv(page)).mirror).toBe(true);

  // The scene still renders (draw calls and triangles) and the player's car is visible again in chase view.
  const st = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState());
  expect(st.drawCalls).toBeGreaterThan(20);
  expect(st.drawCalls).toBeLessThan(350);
  await page.keyboard.press('v');
  await expect.poll(async () => (await fpv(page)).view).toBe('chase');
  expect((await fpv(page)).carHidden).toBe(false);
  expect(errors.filter((e) => !/GL Driver Message|ReadPixels/.test(e))).toEqual([]);
});

test('a helmet vehicle keeps its body and hides only the rider in the driver view', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  await boot(page, 'mantis_650r', errors);
  await page.keyboard.press('v');
  await expect.poll(async () => (await fpv(page)).view).toBe('hood');
  await page.keyboard.press('v');
  await expect.poll(async () => (await fpv(page)).view).toBe('cockpit');
  await expect.poll(async () => (await fpv(page)).riderHidden, { timeout: 30_000 }).toBe(true);
  const f = await fpv(page);
  expect(f.hasRig).toBe(false);
  expect(f.carHidden).toBe(false);
  expect(f.fov).toBeCloseTo(70, 0);
  expect(errors.filter((e) => !/GL Driver Message|ReadPixels/.test(e))).toEqual([]);
});

test('restarting a race 20 times in the cockpit view does not grow memory', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  await boot(page, 'kestrel_gt', errors);
  await page.keyboard.press('v');
  await expect.poll(async () => (await fpv(page)).view).toBe('hood');
  await page.keyboard.press('v');
  await expect.poll(async () => (await fpv(page)).view).toBe('cockpit');
  await page.evaluate(() => (window as unknown as Dbg).__voltlineApp.cycle(2));
  await page.waitForTimeout(1500);
  const a = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState().memory);
  await page.evaluate(() => (window as unknown as Dbg).__voltlineApp.cycle(20));
  await page.waitForTimeout(1500);
  const b = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState().memory);
  expect(b.geometries).toBeLessThanOrEqual(a.geometries + 5);
  expect(b.textures).toBeLessThanOrEqual(a.textures + 5);
  expect(errors.filter((e) => !/GL Driver Message|ReadPixels/.test(e))).toEqual([]);
});
