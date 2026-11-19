import { expect, test } from '@playwright/test';

type Dbg = {
  __voltline: {
    debugTeleport(t: number): void;
    debugFastForward(s: number): void;
    debugState(): { pos: { y: number } };
  };
};

// A car parked on Hanoi Highway is rammed by rivals and traffic. It must never end up under the street or in the pit:
// the road stops it, or it is stood back up / put back on the track.
test('a parked car on Hanoi Highway never ends up under the road or in the pit', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?quick=1&mode=race&roster=data&track=xa_lo_ha_noi');
  await page.waitForFunction(() => (window as unknown as Partial<Dbg>).__voltline !== undefined, null, {
    timeout: 60_000,
  });
  for (const t of [0.1, 0.2, 0.5, 0.7]) {
    await page.evaluate((x) => (window as unknown as Dbg).__voltline.debugTeleport(x), t);
    for (let s = 0; s < 30; s++) {
      await page.evaluate(() => (window as unknown as Dbg).__voltline.debugFastForward(1));
      const y = await page.evaluate(() => (window as unknown as Dbg).__voltline.debugState().pos.y);
      // the underpass dips to about -3.5 m; anything lower is the sheet under the road or the pit (-10)
      expect(y, `t=${t} after ${s + 1}s`).toBeGreaterThan(-4);
    }
  }
});
