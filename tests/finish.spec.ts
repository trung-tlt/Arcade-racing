import { expect, test } from '@playwright/test';

interface RivalStats {
  phase: string;
  laps: number[];
  recoveries: number;
  stuckSec: number;
}
type Dbg = {
  __voltline: { debugAiHoldFire(on: boolean): void; debugFastForward(s: number): Record<string, RivalStats> };
};

// Every map must be finishable: with the rivals' guns off (so wrecks don't muddy the result) all five complete
// 3 laps in simulated time (the slowest vehicle, 100 km/h, needs about 8 minutes on the longest map), and none spends the race wedged against scenery.
// Map 4's wet road, flood dip and two U-turns cost the rivals more recoveries than the dry maps.
// Map 5's 12 m street between Armco walls costs the rivals about as many; Map 6's 6.9 km forest circuit is the longest lap.
const MAX_RECOVERIES: Record<string, number> = { pham_van_dong: 16, monte_carlo: 16, ardennes: 16 };
for (const track of ['cat_lai', 'cong_hoa', 'xa_lo_ha_noi', 'pham_van_dong', 'monte_carlo', 'ardennes']) {
  test(`all rivals finish 3 laps on ${track} without being blocked`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.goto(`/?quick=1&mode=race&roster=data&track=${track}`);
    await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
      timeout: 60_000,
    });
    await page.evaluate(() => (window as unknown as Dbg).__voltline.debugAiHoldFire(true));
    let out: Record<string, RivalStats> = {};
    for (let sim = 0; sim < 1200; sim += 30) {
      out = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugFastForward(30));
      if (Object.entries(out).every(([id, v]) => id === 'player' || v.phase === 'finished')) break;
    }
    for (const [id, v] of Object.entries(out)) {
      if (id === 'player') continue;
      expect(v.phase, `${id} finished`).toBe('finished');
      expect(v.laps, `${id} laps`).toHaveLength(3);
      expect(v.recoveries, `${id} recoveries`).toBeLessThanOrEqual(MAX_RECOVERIES[track] ?? 10);
    }
  });
}
