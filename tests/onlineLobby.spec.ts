import { expect, test, type Page } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';

// The online menus through the real UI, against a real server with the strict lobby rules (no SOLO_START).
const PORT = 18124;
const SERVER = `ws://127.0.0.1:${PORT}`;
let server: ChildProcess | null = null;

test.beforeAll(async () => {
  execSync('npm run server:build', { stdio: 'ignore' });
  server = spawn('node', ['dist-server/index.mjs'], {
    env: { ...process.env, PORT: String(PORT), REMATCH_SEC: '180' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('race server did not start');
});
test.afterAll(() => server?.kill());

const shot = async (page: Page, name: string): Promise<void> => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/${name}.png` });
};

async function toHub(page: Page, server = SERVER): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?server=${server}`);
  await expect(page.getByText('PRESS ENTER TO START')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^ONLINE/ })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /^ONLINE/ }).click();
  await expect(page.getByRole('heading', { name: 'Race online' })).toBeVisible();
  return errors;
}

test('hub: bad code, unreachable server and the code filter', async ({ page }) => {
  const errors = await toHub(page);
  await shot(page, 'hub-idle');
  const code = page.getByLabel(/Room code/);
  await code.fill('o0i1abc-d');
  await expect(code).toHaveValue('ABCD'); // O, 0, I, 1 and punctuation dropped, upper-cased
  await page.getByRole('button', { name: 'JOIN', exact: true }).click();
  await expect(page.getByText('Enter all 6 characters.')).toBeVisible();
  await code.fill('vx7·m4qzz'); // a code pasted as displayed (with the dot), plus extra
  await expect(code).toHaveValue('VX7M4Q');
  await code.fill('ZZZZZZ');
  await page.getByRole('button', { name: 'JOIN', exact: true }).click();
  await expect(page.getByText('No room with that code')).toBeVisible();
  await shot(page, 'hub-notfound');

  // A server nobody is listening on.
  const down = await page.context().newPage();
  await toHub(down, 'ws://127.0.0.1:1');
  await down.getByRole('button', { name: /^QUICK MATCH/ }).click();
  await expect(down.getByText('Can’t reach the race server')).toBeVisible({ timeout: 10_000 });
  await shot(down, 'hub-down');
  expect(errors).toEqual([]);
});

test('two players: create, join by code, ready up, host starts', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await browser.newPage();
  const guest = await browser.newPage();
  const errors = [...(await toHub(host)), ...(await toHub(guest))];

  await host.getByRole('button', { name: /^CREATE ROOM/ }).click();
  await expect(host.getByRole('heading', { name: /Lobby/ })).toBeVisible();
  const codeText = (await host.locator('.ol-code-val').innerText()).replace('·', '');
  expect(codeText).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  await expect(host.getByText('ONLINE ROOM · YOU ARE HOST')).toBeVisible();
  await shot(host, 'lobby-host-alone');
  // Alone: START is not allowed.
  await expect(host.getByRole('button', { name: /START RACE/ })).toHaveAttribute('aria-disabled', 'true');

  await guest.getByLabel(/Room code/).fill(codeText);
  await guest.getByRole('button', { name: 'JOIN', exact: true }).click();
  await expect(guest.getByText(/Room found/)).toBeVisible();
  await shot(guest, 'hub-found');
  await guest.getByRole('button', { name: /Enter lobby/ }).click();
  await expect(guest.getByText(/Only the host can change the track and laps/)).toBeVisible();
  await expect(host.locator('.ol-row:not(.empty)')).toHaveCount(2);

  // The host picks a track; the guest sees it.
  await host.getByRole('button', { name: 'Next track' }).click();
  await expect(guest.locator('.ol-trackname b')).toHaveText('Cong Hoa Boulevard');
  await expect(guest.getByRole('button', { name: /^READY UP/ })).toBeVisible();

  await host.getByRole('button', { name: /^READY UP/ }).click();
  await expect(host.getByText(/1\/2 ready · waiting on/)).toBeVisible();
  await guest.getByRole('button', { name: /^READY UP/ }).click();
  await expect(host.getByText('Everyone is ready · countdown starts for all')).toBeVisible();
  await shot(host, 'lobby-all-ready');
  await shot(guest, 'lobby-guest');

  await host.getByRole('button', { name: /START RACE/ }).click();
  // Both browsers build the race and the countdown begins.
  await expect(host.locator('canvas#game')).toBeVisible({ timeout: 60_000 });
  await expect(guest.locator('canvas#game')).toBeVisible({ timeout: 60_000 });
  // On the grid the other human is a few metres away: their name tag (board 40) is up, with a position chip.
  const tag = host.locator('.ot-tag:not([hidden])');
  await expect(tag.first()).toBeVisible({ timeout: 30_000 });
  await expect(tag.locator('.ot-chip').first()).toHaveText(/^P\d$/);
  await shot(host, 'race-nametags');
  expect(errors).toEqual([]);
  await Promise.all([host.close(), guest.close()]); // a live race page would starve the next test
});

test('a race to the flag: online results, then a rematch loads a second race', async ({ browser }) => {
  test.setTimeout(420_000);
  const host = await browser.newPage();
  const guest = await browser.newPage();
  const errors = [...(await toHub(host)), ...(await toHub(guest))];
  await host.getByRole('button', { name: /^CREATE ROOM/ }).click();
  const code = (await host.locator('.ol-code-val').innerText()).replace('·', '');
  await host
    .getByRole('button', { name: /^LAPS|^1$/ })
    .first()
    .click(); // 1 lap
  await guest.getByLabel(/Room code/).fill(code);
  await guest.getByRole('button', { name: 'JOIN', exact: true }).click();
  await guest.getByRole('button', { name: /Enter lobby/ }).click();
  await expect(host.locator('.ol-row:not(.empty)')).toHaveCount(2);
  await expect(host.locator('.pill.on')).toHaveText('1');
  await host.getByRole('button', { name: /^READY UP/ }).click();
  await guest.getByRole('button', { name: /^READY UP/ }).click();
  await host.getByRole('button', { name: /START RACE/ }).click();

  const drive = async (page: Page): Promise<void> => {
    await expect(page.locator('canvas#game')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => !!(window as unknown as { __voltline?: unknown }).__voltline);
    await page.evaluate(() =>
      (
        window as unknown as { __voltline: { debugAutopilot(on: boolean, fight: boolean): void } }
      ).__voltline.debugAutopilot(true, false),
    );
  };
  await Promise.all([drive(host), drive(guest)]);

  // The server closes the race once both humans finish: the results board replaces the game.
  const seen = async (page: Page, who: string): Promise<void> => {
    try {
      await expect(page.getByText(/ONLINE RESULTS/)).toBeVisible({ timeout: 300_000 });
    } catch (e) {
      const where = await page.evaluate(() => ({
        state: (window as unknown as { __voltlineApp?: { state(): string } }).__voltlineApp?.state() ?? '?',
        screens: [...document.querySelectorAll<HTMLElement>('.mn')]
          .filter((el) => !el.hidden)
          .map((el) => el.className),
      }));
      throw new Error(`${who} never showed the online results: ${JSON.stringify(where)}\n${String(e)}`);
    }
  };
  await Promise.all([seen(host, 'host'), seen(guest, 'guest')]);
  await expect(host.locator('.ol-orow')).toHaveCount(6);
  await shot(host, 'results-host');
  await expect(host.locator('.ol-orow .badge')).toHaveText('YOU');

  await host.getByRole('button', { name: /^REMATCH/ }).click();
  await expect(host.getByText('1 of 2 want a rematch')).toBeVisible();
  await shot(host, 'results-vote');
  await guest.getByRole('button', { name: /^REMATCH/ }).click();
  // Everyone said yes: the same race loads again on both.
  await expect(host.locator('canvas#game')).toBeVisible({ timeout: 60_000 });
  await expect(guest.locator('canvas#game')).toBeVisible({ timeout: 60_000 });
  await expect(host.getByText(/ONLINE RESULTS/)).toBeHidden();
  expect(errors).toEqual([]);
});
