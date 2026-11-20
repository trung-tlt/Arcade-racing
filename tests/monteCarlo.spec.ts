import { expect, test } from '@playwright/test';

interface Probe {
  drawCalls: number;
  triangles: number;
  exposure: number;
  tunnel: number;
  names: string[];
  lamps: number;
}
type Dbg = {
  __voltline: {
    debugTeleport(t: number): void;
    drawCalls: number;
    triangles: number;
    renderer: { toneMappingExposure: number };
    monte: { tunnelAmount: number; gantry: { lenses: { emissiveIntensity: number }[] } } | null;
    scene: { children: { name: string }[] };
  };
};

const probe = (): Probe => {
  const g = (window as unknown as Dbg).__voltline;
  return {
    drawCalls: g.drawCalls,
    triangles: g.triangles,
    exposure: g.renderer.toneMappingExposure,
    tunnel: g.monte?.tunnelAmount ?? -1,
    names: g.scene.children.map((c) => c.name),
    lamps: g.monte?.gantry.lenses.filter((l) => l.emissiveIntensity > 1).length ?? -1,
  };
};

// Map 5 (Monte-Carlo Harbour): the circuit builds, stays inside the draw-call budget, and the tunnel dims the exposure.
test('Monte-Carlo Harbour builds its world, keeps under 350 draw calls and darkens in the tunnel', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?quick=1&mode=race&roster=data&track=monte_carlo');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 120_000,
  });
  await page.waitForTimeout(2_500);
  const grid = await page.evaluate(probe);
  expect(grid.names).toContain('monte_carlo');
  expect(grid.drawCalls).toBeLessThan(350);
  const bright = grid.exposure;

  // Daylight: the same exposure all the way up to the tunnel mouth.
  await page.evaluate(() => (window as unknown as Dbg).__voltline.debugTeleport(0.3));
  await page.waitForTimeout(1_500);
  const casino = await page.evaluate(probe);
  expect(casino.drawCalls).toBeLessThan(350);
  expect(casino.tunnel).toBeLessThan(0.05);
  expect(casino.exposure).toBeCloseTo(bright, 2);

  // Inside the tunnel the exposure drops by about 1.5 EV and the reverb amount rises.
  await page.evaluate(() => (window as unknown as Dbg).__voltline.debugTeleport(0.52));
  await page.waitForTimeout(3_000);
  const dark = await page.evaluate(probe);
  expect(dark.tunnel).toBeGreaterThan(0.9);
  expect(dark.exposure).toBeLessThan(bright * 0.45);
  expect(dark.exposure).toBeGreaterThan(bright * 0.3);
  expect(dark.drawCalls).toBeLessThan(350);

  // And back out in daylight.
  await page.evaluate(() => (window as unknown as Dbg).__voltline.debugTeleport(0.62));
  await page.waitForTimeout(3_000);
  const out = await page.evaluate(probe);
  expect(out.tunnel).toBeLessThan(0.1);
  expect(out.exposure).toBeGreaterThan(bright * 0.9);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('restarting a Monte-Carlo race several times leaves no errors', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?quick=1&mode=race&roster=data&track=monte_carlo');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 120_000,
  });
  await page.evaluate(() =>
    (window as unknown as { __voltlineApp: { cycle(n: number): Promise<void> } }).__voltlineApp.cycle(3),
  );
  await page.waitForTimeout(1_500);
  const p = await page.evaluate(probe);
  expect(p.names.filter((n) => n === 'monte_carlo')).toHaveLength(1);
  expect(errors, errors.join('\n')).toEqual([]);
});
