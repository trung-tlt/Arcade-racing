import { expect, test, type Page } from '@playwright/test';

/** The focused element must carry the cyan selection ring (3 px #2EC5FF outline). */
async function expectRing(page: Page): Promise<void> {
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
  });
  expect(ring, 'something must be focused').not.toBeNull();
  expect(ring!.style).toBe('solid');
  expect(ring!.width).toBe('3px');
  expect(ring!.color).toBe('rgb(46, 197, 255)');
}

const keybar = (page: Page) => page.locator('.mn-keybar:visible');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('the whole game can be played with the keyboard alone: loading → race → pause → quit', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await page.goto('/');

  // Loading: no "press to start" step; the title follows by itself
  // Title: Enter/R race, G garage, S settings, C controls
  const race = page.getByRole('button', { name: /^RACE/ });
  await expect(race).toBeVisible({ timeout: 40_000 });
  await expect(race).toBeFocused();
  await expectRing(page);
  await expect(keybar(page)).toContainText('Navigate');
  await expect(keybar(page)).toContainText('Garage');
  await expect(page.locator('.mn-title .kc').first()).toBeVisible();
  await page.keyboard.press('r');

  // Car select: 3 then → picks vehicle 4 (Wisp R); Enter selects
  await expect(page.getByText('Choose your ride')).toBeVisible();
  await expect(keybar(page)).toContainText('Pick');
  await expect(page.locator('.mn-cars .pick')).toHaveCount(11);
  // 0 is the tenth vehicle (the Mira scooter) and - the eleventh (the Fulmine FX); 3 then goes back to the Rhino
  await page.keyboard.press('0');
  await expect(page.locator('.mn-cars .pick[aria-pressed="true"]')).toContainText('Mira 150');
  await page.keyboard.press('-');
  await expect(page.locator('.mn-cars .pick[aria-pressed="true"]')).toContainText('Fulmine FX');
  await page.keyboard.press('3');
  await expect(page.locator('.mn-cars .pick[aria-pressed="true"]')).toContainText('Rhino X4');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.mn-cars .pick[aria-pressed="true"]')).toContainText('Wisp R');
  await page.keyboard.press('9');
  await expect(page.locator('.mn-cars .pick[aria-pressed="true"]')).toContainText('Mantis 650R');
  await page.keyboard.press('ArrowRight'); // the tenth vehicle
  await expect(page.locator('.mn-cars .pick[aria-pressed="true"]')).toContainText('Mira 150');
  await page.keyboard.press('ArrowRight'); // the eleventh
  await expect(page.locator('.mn-cars .pick[aria-pressed="true"]')).toContainText('Fulmine FX');
  await page.keyboard.press('ArrowRight'); // wraps to the first vehicle
  await expect(page.locator('.mn-cars .pick[aria-pressed="true"]')).toContainText('Raijin RX');
  await expectRing(page);
  await page.keyboard.press('Enter');

  // Race setup: L laps, D difficulty, Enter starts
  await expect(page.getByRole('heading', { name: 'Set up the race' })).toBeVisible();
  await expect(keybar(page)).toContainText('Difficulty');
  await expect(keybar(page)).toContainText('Track');
  await expectRing(page);
  // T cycles the map (wraps): the left panel follows the selected map.
  await expect(page.locator('[data-group="track"] [aria-pressed="true"]')).toHaveText('Cat Lai Port');
  await page.keyboard.press('t'); // Cong Hoa, Hanoi and Pham Van Dong are hidden: the next map is Monte-Carlo
  await expect(page.locator('[data-group="track"] [aria-pressed="true"]')).toHaveText('Monte-Carlo Harbour');
  await expect(page.locator('[data-group="track"] .pill')).toHaveCount(4);
  await page.keyboard.press('ArrowLeft'); // the track row has focus: back to Cat Lai Port
  await expect(page.locator('.mn-setup .tname')).toHaveText('Cat Lai Port');
  await page.keyboard.press('t');
  await expect(page.locator('.mn-setup .tname')).toHaveText('Monte-Carlo Harbour');
  await page.keyboard.press('t'); // → Ardennes
  await expect(page.locator('.mn-setup .tname')).toHaveText('Ardennes Forest Circuit');
  await page.keyboard.press('t'); // → Suzuka Hills
  await expect(page.locator('.mn-setup .tname')).toHaveText('Suzuka Hills Circuit');
  await page.keyboard.press('t'); // wrapped around to Cat Lai
  await expect(page.locator('.mn-setup .tname')).toHaveText('Cat Lai Port');
  await expect(page.locator('[data-group="laps"] [aria-pressed="true"]')).toHaveText('3 laps');
  await page.keyboard.press('l');
  await expect(page.locator('[data-group="laps"] [aria-pressed="true"]')).toHaveText('5 laps');
  await page.keyboard.press('d');
  await expect(page.locator('[data-group="diff"] [aria-pressed="true"]')).toHaveText('Hard');
  await page.keyboard.press('ArrowUp'); // row 0
  await page.keyboard.press('ArrowLeft'); // 5 → 3 laps
  await expect(page.locator('[data-group="laps"] [aria-pressed="true"]')).toHaveText('3 laps');
  await page.keyboard.press('Enter');

  // Race: the menu keys must not leak in; P pauses, P resumes, Esc pauses, Q quits
  await expect(page.locator('.race-banner')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('p');
  await expect(page.getByText('PAUSED')).toBeVisible();
  await expect(keybar(page)).toContainText('Resume');
  await expectRing(page);
  await page.keyboard.press('p');
  await expect(page.getByText('PAUSED')).toBeHidden();
  await page.waitForTimeout(500);
  await expect(page.getByText('PAUSED')).toBeHidden(); // no double-trigger from the same key
  await page.keyboard.press('Escape');
  await expect(page.getByText('PAUSED')).toBeVisible();
  await page.keyboard.press('q');
  await expect(race).toBeVisible();
  expect(errors).toEqual([]);
});

test('settings and controls work from the keyboard; keys never leak between screens', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^RACE/ })).toBeVisible({ timeout: 40_000 });

  // S opens Settings; the first row (Quality) is selected
  await page.keyboard.press('s');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(keybar(page)).toContainText('Toggle');
  await expectRing(page);
  const quality = page.locator('.st-row').first();
  await expect(quality).toBeFocused();
  const before = await quality.getAttribute('aria-label');
  await page.keyboard.press('ArrowRight');
  const after = await quality.getAttribute('aria-label');
  expect(after).not.toBe(before);

  // ↓ ↓ ↓ → "Shadows" row; Space toggles it; Backspace resets everything
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowDown'); // Resolution, Shadows
  const shadows = page.locator('.st-row[aria-label^="Shadows"]');
  await expect(shadows).toBeFocused();
  const sOn = await shadows.getAttribute('aria-label');
  await page.keyboard.press('Space');
  expect(await shadows.getAttribute('aria-label')).not.toBe(sOn);
  await page.keyboard.press('Backspace');
  expect(await quality.getAttribute('aria-label')).toBe('Quality: Medium');
  expect(await shadows.getAttribute('aria-label')).toBe('Shadows: on');
  await page.keyboard.press('Escape'); // done → title
  await expect(page.getByRole('button', { name: /^RACE/ })).toBeVisible();

  // C opens Controls (menu-key table present); Backspace goes back
  await page.keyboard.press('c');
  await expect(page.getByRole('heading', { name: 'Controls' })).toBeVisible();
  await expect(page.getByText('Button hotkey')).toBeVisible();
  await expect(keybar(page)).toContainText('Back');
  await page.keyboard.press('Backspace');
  await expect(page.getByRole('button', { name: /^RACE/ })).toBeVisible();

  // The Title's keys do nothing while Settings is open (no leak)
  await page.keyboard.press('s');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('r'); // would start the race if it leaked
  await page.keyboard.press('g');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
