import { expect, test } from '@playwright/test';

interface Probe {
  drawCalls: number;
  triangles: number;
  names: string[];
  lamps: number;
  playerY: number;
  terrainChunks: number;
}
type Dbg = {
  __voltline: {
    debugTeleport(t: number): void;
    drawCalls: number;
    triangles: number;
    car: { physics: { curr: { p: { y: number } } } };
    ardennes: {
      gantry: { lenses: { emissiveIntensity: number }[] };
      group: { children: { name: string; children: unknown[] }[] };
    } | null;
    scene: { children: { name: string }[] };
  };
};

const probe = (): Probe => {
  const g = (window as unknown as Dbg).__voltline;
  const a = g.ardennes;
  return {
    drawCalls: g.drawCalls,
    triangles: g.triangles,
    names: g.scene.children.map((c) => c.name),
    lamps: a?.gantry.lenses.filter((l) => l.emissiveIntensity > 1).length ?? -1,
    playerY: g.car.physics.curr.p.y,
    terrainChunks: a?.group.children.find((c) => c.name === 'terrain')?.children.length ?? 0,
  };
};

// Map 6 (Ardennes Forest Circuit): the terrain, forest and furniture build, the car stays on the land it is dropped
// on at the top and bottom of Eau Rouge, and the frame stays inside the draw-call budget.
test('Ardennes builds its world, holds the car on the hills and stays under 350 draw calls', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?quick=1&mode=race&roster=data&track=ardennes');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 180_000,
  });
  await page.waitForTimeout(2_500);
  const grid = await page.evaluate(probe);
  expect(grid.names).toContain('ardennes');
  expect(grid.terrainChunks).toBeGreaterThanOrEqual(6);
  expect(grid.drawCalls).toBeLessThan(350);

  // Bottom of Eau Rouge (about 30 m) and the Raidillon crest (about 60 m): the car settles on the road at each.
  for (const [t, y] of [
    [0.1422, 30],
    [0.1619, 60],
    [0.3, 88],
  ] as const) {
    await page.evaluate((tt) => (window as unknown as Dbg).__voltline.debugTeleport(tt), t);
    await page.waitForTimeout(2_500);
    const p = await page.evaluate(probe);
    expect(p.drawCalls, `draw calls at t=${t}`).toBeLessThan(350);
    expect(Math.abs(p.playerY - y), `car height at t=${t}`).toBeLessThan(14);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('restarting an Ardennes race several times leaves one world and no errors', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?quick=1&mode=race&roster=data&track=ardennes');
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 180_000,
  });
  await page.evaluate(() =>
    (window as unknown as { __voltlineApp: { cycle(n: number): Promise<void> } }).__voltlineApp.cycle(3),
  );
  await page.waitForTimeout(1_500);
  const p = await page.evaluate(probe);
  expect(p.names.filter((n) => n === 'ardennes')).toHaveLength(1);
  expect(errors, errors.join('\n')).toEqual([]);
});
