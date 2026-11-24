import { expect, test, type Page } from '@playwright/test';

type Dbg = {
  __voltline: {
    view: { camera: string; hud: string; cycleCamera(): string; cycleHud(): string };
    debugFastForward(s: number): void;
  };
};

const cls = (page: Page): Promise<string> => page.evaluate(() => document.body.className);
const boot = async (page: Page, url: string): Promise<void> => {
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as Partial<Dbg>).__voltline !== undefined, null, {
    timeout: 60_000,
  });
};

test.describe('first-person HUD', () => {
  test('H cycles full → minimal → off; the countdown stays on screen in every mode', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await boot(page, '/?quick=1&mode=race&roster=data&track=cong_hoa');
    expect(await cls(page)).toContain('hud-full');
    for (const [mode, c] of [
      ['minimal', 'hud-min'],
      ['off', 'hud-off'],
      ['full', 'hud-full'],
    ]) {
      await page.keyboard.press('h');
      await expect(page.locator('body')).toHaveClass(new RegExp(c), { timeout: 5000 });
      expect(await page.evaluate(() => (window as unknown as Dbg).__voltline.view.hud), mode).toBe(mode);
      // The race banner (3-2-1 / lights) is never hidden by a HUD mode while the countdown runs.
      await expect(page.locator('.race-banner')).toBeVisible({ timeout: 1500 });
    }
    expect(errors).toEqual([]);
  });

  test('hood and cockpit show the visor; minimal drops the panels and off hides it all', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page, '/?quick=1&mode=race&roster=data&track=cong_hoa');
    // chase: no visor layer
    await expect(page.locator('.fpv')).toBeHidden();
    await page.evaluate(() => {
      const v = (window as unknown as Dbg).__voltline.view;
      v.cycleCamera();
      v.cycleCamera();
    });
    await expect(page.locator('body')).toHaveClass(/view-cockpit/);
    await page.evaluate(() => (window as unknown as Dbg).__voltline.debugFastForward(6));
    await expect(page.locator('.fpv')).toBeVisible();
    await expect(page.locator('.fpv-pos')).toBeVisible();
    await expect(page.locator('.fpv-weapons')).toBeVisible();
    await expect(page.locator('.fpv-reticle')).toBeVisible();
    // the HTML speedo is on the 3D dash in the cockpit
    await expect(page.locator('.hud-speed')).toBeHidden();
    await page.keyboard.press('h');
    await expect(page.locator('.fpv-weapons')).toBeHidden();
    await expect(page.locator('.fpv-pos')).toBeVisible();
    await expect(page.locator('.fpv-hull')).toBeVisible();
    await page.keyboard.press('h');
    await expect(page.locator('.fpv')).toBeHidden();
  });

  test('the Controls screen lists look back, camera, HUD and mirror', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await page.getByText(/press .* to start/i).waitFor({ timeout: 60_000 });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /RACE/ })).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('c');
    for (const t of ['Look back', 'Camera: chase / hood / cockpit', 'HUD: full / minimal / off', 'Rear-view mirror']) {
      await expect(page.getByText(t, { exact: true })).toBeVisible();
    }
  });
});
