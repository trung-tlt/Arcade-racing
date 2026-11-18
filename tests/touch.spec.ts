import { expect, test } from '@playwright/test';

type Dbg = { __voltline: { debugState(): { cars: { kind: string; speed: number }[] } } };
const MOBILE = { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true } as const;

const press = (sel: string, id = 11): string =>
  `document.querySelector('${sel}').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: ${id}, pointerType: 'touch' }))`;
const lift = (sel: string, id = 11): string =>
  `document.querySelector('${sel}').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: ${id}, pointerType: 'touch' }))`;

test.describe('mobile layer', () => {
  test.use(MOBILE);

  test('touch HUD renders, auto-gas drives the car, pads and pause work, no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/?touch=1&quick=1&mode=practice');
    await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
      timeout: 60_000,
    });
    await expect(page.locator('#touch-hud')).toBeVisible();
    for (const sel of [
      '.tb-left',
      '.tb-right',
      '.tb-drift',
      '.tb-fire',
      '.tb-rocket',
      '.tb-nitro',
      '.tb-brake',
      '.tb-pause',
    ]) {
      const box = await page.locator(sel).boundingBox();
      expect(box, sel).not.toBeNull();
      // every control sits fully inside the 844×390 screen and is at least 48 px (the design sizes are larger)
      expect(box?.width, sel).toBeGreaterThanOrEqual(48);
      expect(box?.x, sel).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0), sel).toBeLessThanOrEqual(844);
      expect((box?.y ?? 0) + (box?.height ?? 0), sel).toBeLessThanOrEqual(390);
    }
    // design sizes: steering pads 78, FIRE 92; left/right margins at least 44
    expect((await page.locator('.tb-left').boundingBox())?.width).toBe(78);
    expect((await page.locator('.tb-fire').boundingBox())?.width).toBe(92);
    expect((await page.locator('.tb-left').boundingBox())?.x).toBeGreaterThanOrEqual(44);

    await page.waitForFunction(() => document.querySelector('.race-banner')?.classList.contains('go'), null, {
      timeout: 15_000,
    });
    await page.waitForTimeout(3500);
    const speed = await page.evaluate(
      () => (window as unknown as Dbg).__voltline.debugState().cars.find((c) => c.kind === 'player')?.speed ?? 0,
    );
    expect(speed).toBeGreaterThan(5); // auto-gas: no gas button is pressed
    await page.evaluate(press('.tb-right'));
    await expect(page.locator('.tb-right')).toHaveClass(/down/);
    await page.evaluate(lift('.tb-right'));
    await expect(page.locator('.tb-right')).not.toHaveClass(/down/);

    // two thumbs at once: both pointers held together
    await page.evaluate(press('.tb-left', 21));
    await page.evaluate(press('.tb-fire', 22));
    await expect(page.locator('.tb-left')).toHaveClass(/down/);
    await expect(page.locator('.tb-fire')).toHaveClass(/down/);
    await page.evaluate(lift('.tb-left', 21));
    await expect(page.locator('.tb-fire')).toHaveClass(/down/);
    await page.evaluate(lift('.tb-fire', 22));

    // pause / resume
    await page.evaluate(press('.tb-pause', 31));
    await expect(page.locator('.pause-panel')).toBeVisible();
    await expect(page.locator('#touch-hud')).toBeHidden();
    await page.evaluate(() => (document.querySelector('[data-act="resume"]') as HTMLElement).click());
    await expect(page.locator('.pause-panel')).toBeHidden();
    await expect(page.locator('#touch-hud')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('left-handed layout mirrors the clusters and auto-gas off shows the GAS button', async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        'voltline.settings',
        JSON.stringify({ touchLeftHanded: true, touchAutoGas: false, mobileDefaultsApplied: true }),
      ),
    );
    await page.goto('/?touch=1&quick=1&mode=practice');
    await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
      timeout: 60_000,
    });
    const fire = await page.locator('.tb-fire').boundingBox();
    const pad = await page.locator('.tb-left').boundingBox();
    expect(fire?.x).toBeLessThan(200); // FIRE under the left thumb
    expect(pad?.x).toBeGreaterThan(500); // steering under the right thumb
    await expect(page.locator('.tb-gas')).toBeVisible();
  });

  test('swipe wheel and tilt styles swap the steering controls', async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem('voltline.settings', JSON.stringify({ touchScheme: 'wheel', mobileDefaultsApplied: true })),
    );
    await page.goto('/?touch=1&quick=1&mode=practice');
    await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
      timeout: 60_000,
    });
    await expect(page.locator('.tb-wheel')).toBeVisible();
    await expect(page.locator('.tb-left')).toBeHidden();
  });

  test('first run on a phone applies the Low preset once', async ({ page }) => {
    await page.goto('/?touch=1&quick=1&mode=practice');
    await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
      timeout: 60_000,
    });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('voltline.settings') ?? '{}'));
    expect(saved.preset).toBe('low');
    expect(saved.mobileDefaultsApplied).toBe(true);
  });
});

test.describe('portrait', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('shows the rotate screen', async ({ page }) => {
    await page.goto('/?touch=1');
    await expect(page.locator('#rotate-screen')).toBeVisible();
    await expect(page.locator('#rotate-screen h2')).toHaveText('Turn your phone sideways');
  });
});

test.describe('desktop', () => {
  test('never shows touch UI without a touch device', async ({ page }) => {
    await page.goto('/?quick=1&mode=practice');
    await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
      timeout: 60_000,
    });
    await expect(page.locator('#touch-hud')).toHaveCount(0);
    await expect(page.locator('#rotate-screen')).toBeHidden();
  });
});
