import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { HANDLING, RACE, TRACKS } from '../src/core/Data';
import { loadBaked } from '../src/sim/bakedNode';
import { buildTrackColliders, computeTrackShape } from '../src/sim/TrackColliders';
import { relaxTightBends } from '../src/world/relaxBends';
import { TrackPath } from '../src/world/TrackPath';

beforeAll(async () => {
  await RAPIER.init();
});

describe('baked colliders', () => {
  for (const def of TRACKS) {
    it(`${def.id}: the browser's track colliders equal the ones sim/ builds`, () => {
      const baked = loadBaked(def.id);
      expect(baked, 'run scripts/bake-colliders.mjs').not.toBeNull();
      const path = new TrackPath(
        relaxTightBends(def.spline.points, RACE.track.minTurnRadiusM),
        RACE.track.sampleSpacingM,
        RACE.track.projectWindowSamples,
      );
      const world = new RAPIER.World({ x: 0, y: HANDLING.world.gravity, z: 0 });
      const { body } = buildTrackColliders(RAPIER, world, def, path, computeTrackShape(def, path));
      const built: { v: Float32Array; i: Uint32Array }[] = [];
      for (let k = 0; k < body.numColliders(); k++) {
        const c = body.collider(k);
        built.push({ v: c.vertices(), i: c.indices() as Uint32Array });
      }
      const ref = (baked?.static ?? []).filter((c) => c.src === 'track');
      expect(built.length).toBe(ref.length);
      for (const r of ref) {
        const ref_v = r.v as number[];
        const errs = built
          .filter((b) => b.v.length === ref_v.length && b.i.length === r.i?.length)
          .map((b) => b.v.reduce((m, x, k) => Math.max(m, Math.abs(x - ref_v[k])), 0));
        expect(errs.length, 'same vertex/index counts').toBeGreaterThan(0);
        expect(Math.min(...errs)).toBeLessThan(2e-3);
      }
    });
  }
});
