import { expect, test } from '@playwright/test';

interface UiAudioState {
  unlocked: boolean;
  contextState: string;
  musicWanted: boolean;
  musicPlaying: boolean;
  musicMuted: boolean;
  musicDucked: boolean;
  log: string[];
}
const state = (page: import('@playwright/test').Page): Promise<UiAudioState> =>
  page.evaluate(() => (window as unknown as { __voltlineUiAudio: UiAudioState }).__voltlineUiAudio);

test('menu sounds and music: unlock on first key, sounds follow the menus, music stops for the race', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  // The title comes up by itself once loaded; audio stays locked until the first input (a browser rule).
  await expect(page.getByRole('button', { name: /^RACE/ })).toBeVisible({ timeout: 40_000 });
  expect((await state(page)).unlocked).toBe(false);
  expect((await state(page)).musicWanted).toBe(true); // queued: it starts as soon as the first input unlocks audio

  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await state(page)).unlocked).toBe(true);
  await expect.poll(async () => (await state(page)).log, { timeout: 15_000 }).toContain('music_start');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await state(page)).log).toContain('focus_move');

  // M mutes and unmutes the music on the Title screen.
  await page.keyboard.press('m');
  expect((await state(page)).musicMuted).toBe(true);
  await page.keyboard.press('m');
  expect((await state(page)).musicMuted).toBe(false);

  // Title → Car select (R = race): a confirm. Switch vehicles, select, then back out and in again.
  await page.keyboard.press('r');
  await expect(page.getByText('Choose your ride')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await state(page)).log).toContain('vehicle_switch');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^RACE/ })).toBeVisible();
  expect((await state(page)).log).toContain('back');
  await page.keyboard.press('r');
  await page.keyboard.press('Enter');
  expect((await state(page)).log).toContain('vehicle_confirm');

  // Race setup: T changes the track, L changes laps, an arrow past the end is blocked.
  await expect(page.getByRole('heading', { name: 'Set up the race' })).toBeVisible();
  await page.keyboard.press('t');
  await page.keyboard.press('l');
  await page.keyboard.press('ArrowDown'); // L focused the laps row; one step down is the difficulty row
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight'); // past the last difficulty
  const mid = (await state(page)).log;
  expect(mid).toContain('track_switch');
  expect(mid).toContain('toggle_on');
  expect(mid).toContain('blocked');
  expect((await state(page)).musicWanted).toBe(true);

  await page.getByRole('button', { name: /START RACE/i }).click();
  await expect.poll(async () => (await state(page)).log).toContain('start_race');
  expect((await state(page)).musicWanted).toBe(false); // faded out for the race
  await expect(page.locator('.race-banner')).toBeVisible({ timeout: 40_000 });

  // Pause: the menu music returns at 40%, and goes away again on resume.
  await page.keyboard.press('Escape');
  await expect(page.getByText('PAUSED')).toBeVisible();
  await expect.poll(async () => (await state(page)).musicDucked).toBe(true);
  expect((await state(page)).musicWanted).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByText('PAUSED')).toBeHidden();
  await expect.poll(async () => (await state(page)).musicWanted).toBe(false);
  expect((await state(page)).log).toContain('screen_transition');

  expect(errors).toEqual([]);
});

test('the Settings screen has a Music slider and its keys play slider / toggle / blocked sounds', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^RACE/ })).toBeVisible({ timeout: 40_000 });
  await page.keyboard.press('s');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  const music = page.locator('.st-row', { hasText: 'Music' });
  await expect(music).toBeVisible();
  await music.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(music).toHaveAttribute('aria-label', 'Music: 70');
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight');
  const log = (await state(page)).log;
  expect(log).toContain('slider_step');
  expect(log).toContain('blocked'); // already at 100
  await page.keyboard.press('Backspace');
  expect((await state(page)).log).toContain('toggle_off');
  await expect(music).toHaveAttribute('aria-label', 'Music: 80');
  expect(errors).toEqual([]);
});
