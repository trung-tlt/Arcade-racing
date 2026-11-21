// Dumps each map's static Rapier colliders from the real browser world into data/colliders/<track>.json, so the
// headless server sim can rebuild them without loading models. Usage (dev server on :5173):
//   CHROMIUM_PATH=... node scripts/bake-colliders.mjs [trackId ...]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const ALL = ['cat_lai', 'cong_hoa', 'xa_lo_ha_noi', 'pham_van_dong', 'monte_carlo'];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const base = process.env.BASE_URL ?? 'http://localhost:5173';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
mkdirSync('data/colliders', { recursive: true });
for (const id of ids) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?quick=1&track=${id}&roster=data`);
  await page.waitForFunction(() => window.__voltline !== undefined, null, { timeout: 60_000 });
  const dump = await page.evaluate(() => {
    const g = window.__voltline;
    const r = (n) => Math.round(n * 1e4) / 1e4;
    const out = { static: [], kinematic: [] };
    g.world.forEachCollider((c) => {
      const parent = c.parent();
      const type = parent ? parent.bodyType() : 1; // Rapier: Dynamic 0, Fixed 1, KinematicPosition 2, KinematicVelocity 3
      if (type === 0) return; // cars and rockets
      const t = c.translation();
      const q = c.rotation();
      const s = c.shapeType();
      const rec = {
        src:
          parent && parent.handle === g.track.body.handle
            ? 'track'
            : c.handle === g.env.collider.handle
              ? 'ground'
              : 'scenery',
        shape: s === 1 ? 'cuboid' : s === 6 ? 'trimesh' : s === 9 ? 'convex' : 'other:' + s,
        t: [r(t.x), r(t.y), r(t.z)],
        q: [r(q.x), r(q.y), r(q.z), r(q.w)],
        friction: r(c.friction()),
        restitution: r(c.restitution()),
        events: c.activeEvents(),
        sensor: c.isSensor(),
      };
      if (s === 1) {
        const h = c.halfExtents();
        rec.he = [r(h.x), r(h.y), r(h.z)];
      } else {
        rec.v = Array.from(c.vertices(), r);
        const idx = c.indices();
        if (idx) rec.i = Array.from(idx);
      }
      if (type === 1) out.static.push(rec);
      else out.kinematic.push({ ...rec, body: parent.handle });
    });
    return out;
  });
  const bySrc = {};
  for (const c of dump.static) bySrc[c.src] = (bySrc[c.src] ?? 0) + 1;
  const other = dump.static.filter((c) => c.shape.startsWith('other')).length;
  writeFileSync(
    `data/colliders/${id}.json`,
    JSON.stringify({ track: id, static: dump.static, kinematic: dump.kinematic }),
  );
  console.log(
    id,
    'static',
    JSON.stringify(bySrc),
    'kinematic',
    dump.kinematic.length,
    'unsupported',
    other,
    'errors',
    errors.length,
  );
  await page.close();
}
await browser.close();
