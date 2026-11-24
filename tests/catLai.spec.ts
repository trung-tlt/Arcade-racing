import { expect, test } from '@playwright/test';

interface Probe {
  drawCalls: number;
  triangles: number;
  names: string[];
  playerY: number;
  catLaiChildren: string[];
  items: number;
  stacks: number;
  boards: number;
  ferryPositions: [number, number][];
}
interface Stats {
  phase: string;
  laps: number[];
  recoveries: number;
  stuckSec: number;
  wrecked: boolean;
}
type Dbg = {
  __voltline: {
    debugTeleport(t: number): void;
    debugAutopilot(on: boolean, fight?: boolean): void;
    debugAiHoldFire(on: boolean): void;
    debugFastForward(s: number): Record<string, Stats>;
    drawCalls: number;
    triangles: number;
    car: { physics: { curr: { p: { y: number } } } };
    catLai: {
      items: unknown[];
      stacks: unknown[];
      boards: unknown[];
      group: { children: { name: string; position: { x: number; z: number } }[] };
    } | null;
    scene: { children: { name: string }[] };
  };
};

const probe = (): Probe => {
  const g = (window as unknown as Dbg).__voltline;
  const c = g.catLai;
  return {
    drawCalls: g.drawCalls,
    triangles: g.triangles,
    names: g.scene.children.map((o) => o.name),
    playerY: g.car.physics.curr.p.y,
    catLaiChildren: c?.group.children.map((o) => o.name) ?? [],
    items: c?.items.length ?? -1,
    stacks: c?.stacks.length ?? -1,
    boards: c?.boards.length ?? -1,
    ferryPositions: c?.group.children.filter((o) => o.name === 'ferry').map((o) => [o.position.x, o.position.z]) ?? [],
  };
};

const open = async (page: import('@playwright/test').Page, errors: string[], mode = 'race'): Promise<void> => {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?quick=1&mode=${mode}&roster=data&track=cat_lai`);
  await page.waitForFunction(() => (window as unknown as { __voltline?: unknown }).__voltline !== undefined, null, {
    timeout: 180_000,
  });
};

// Map 1 (Cat Lai Port v2): the river, slab, props and yard build, the car stays on the road 2 m above the river all
// round the lap, and the frame stays inside the draw-call budget.
test('Cat Lai builds its port and stays inside the draw-call budget at every section', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  await open(page, errors);
  await page.waitForTimeout(2_500);
  const grid = await page.evaluate(probe);
  expect(grid.names).toContain('cat_lai');
  for (const part of ['sky', 'land', 'port_slab', 'river', 'quay_wall', 'far_bank_strip', 'lane_paint', 'osm_roads'])
    expect(grid.catLaiChildren, part).toContain(part);
  expect(grid.catLaiChildren.filter((n) => n === 'ferry')).toHaveLength(2);
  expect(grid.stacks).toBeGreaterThan(10_000);
  expect(grid.items).toBeGreaterThan(850);
  expect(grid.boards).toBeGreaterThan(8);
  expect(grid.drawCalls).toBeLessThan(350);
  expect(grid.triangles).toBeLessThan(450_000);

  // NTD, Gate B, the quay, yard lane 7, the north road and the admin link: the car settles on the 2 m deck.
  for (const t of [0.05, 0.126, 0.25, 0.4, 0.55, 0.75, 0.95]) {
    await page.evaluate((tt) => (window as unknown as Dbg).__voltline.debugTeleport(tt), t);
    await page.waitForTimeout(2_500);
    const p = await page.evaluate(probe);
    expect(p.drawCalls, `draw calls at t=${t}`).toBeLessThan(350);
    expect(p.triangles, `triangles at t=${t}`).toBeLessThan(450_000);
    expect(p.playerY, `car height at t=${t}`).toBeGreaterThan(1.4);
    expect(p.playerY, `car height at t=${t}`).toBeLessThan(4);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the Cat Lai ferry sails between its landings', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  await open(page, errors);
  await page.waitForTimeout(2_500);
  const a = (await page.evaluate(probe)).ferryPositions;
  await page.waitForTimeout(6_000);
  const b = (await page.evaluate(probe)).ferryPositions;
  expect(a).toHaveLength(2);
  // Within 6 s a boat mid-crossing has moved metres (700 m in ~108 s); the pair never sits still together.
  const moved = a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]));
  expect(Math.max(...moved)).toBeGreaterThan(3);
  expect(errors, errors.join('\n')).toEqual([]);
});

// A human-driven lap (the dev autopilot stands in for the player: same AI controls, no rubber band) must finish all
// three laps on the new road without wedging against the cranes, the gate islands or the container stacks. Practice
// mode: no rivals, so cars that have finished and stopped on the line (the generic AI) cannot block the last lap.
test('an autopilot player finishes 3 laps of Cat Lai without getting stuck', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  await open(page, errors, 'practice');
  await page.evaluate(() => (window as unknown as Dbg).__voltline.debugAutopilot(true, false));
  let me: Stats | undefined;
  for (let sim = 0; sim < 1200; sim += 30) {
    me = (await page.evaluate(() => (window as unknown as Dbg).__voltline.debugFastForward(30))).player;
    if (me.phase === 'finished') break;
  }
  expect(me?.phase, 'player finished').toBe('finished');
  expect(me?.laps).toHaveLength(3);
  expect(me?.stuckSec, 'seconds wedged').toBeLessThan(6);
  expect(me?.wrecked).toBe(false);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('restarting a Cat Lai race several times leaves one world and no errors', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  await open(page, errors);
  await page.evaluate(() =>
    (window as unknown as { __voltlineApp: { cycle(n: number): Promise<void> } }).__voltlineApp.cycle(3),
  );
  await page.waitForTimeout(1_500);
  const p = await page.evaluate(probe);
  expect(p.names.filter((n) => n === 'cat_lai')).toHaveLength(1);
  expect(errors, errors.join('\n')).toEqual([]);
});
