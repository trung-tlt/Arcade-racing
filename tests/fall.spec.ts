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

type Probe = {
  __voltline: {
    debugTeleport(t: number): void;
    debugFastForward(s: number): void;
    debugState(): { pos: { x: number; y: number; z: number } };
    world: {
      castRay(
        ray: { origin: { x: number; y: number; z: number }; dir: { x: number; y: number; z: number } },
        maxToi: number,
        solid: boolean,
        flags?: number,
        groups?: number,
        exCollider?: unknown,
        exBody?: unknown,
        filter?: (c: { parent(): { bodyType(): number } | null }) => boolean,
      ): { timeOfImpact: number } | null;
    };
  };
};

// Map 5 is narrow and 40 m up in places: a parked car rammed by the field must not stay pressed under the road.
test('a parked car on Monte-Carlo is never left under the road', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/?quick=1&mode=race&roster=data&track=monte_carlo');
  await page.waitForFunction(() => (window as unknown as Partial<Dbg>).__voltline !== undefined, null, {
    timeout: 90_000,
  });
  for (const t of [0.02, 0.1, 0.2, 0.28, 0.5, 0.8]) {
    await page.evaluate((x) => (window as unknown as Dbg).__voltline.debugTeleport(x), t);
    let under = 0;
    for (let s = 0; s < 25; s++) {
      await page.evaluate(() => (window as unknown as Dbg).__voltline.debugFastForward(1));
      // How far the car sits below the fixed collider just above it (the road), the same test the game recovers on.
      const depth = await page.evaluate(() => {
        const g = (window as unknown as Probe).__voltline;
        const p = g.debugState().pos;
        const hit = g.world.castRay(
          { origin: { x: p.x, y: p.y + 2.5, z: p.z }, dir: { x: 0, y: -1, z: 0 } },
          8,
          true,
          undefined,
          undefined,
          undefined,
          undefined,
          (c) => c.parent()?.bodyType() === 1,
        );
        return hit ? p.y - (p.y + 2.5 - hit.timeOfImpact) : 0;
      });
      under = depth < -0.6 ? under + 1 : 0;
      expect(under, `t=${t} after ${s + 1}s: ${depth.toFixed(2)} m under the road`).toBeLessThan(3);
    }
  }
});
