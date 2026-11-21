import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BakedTrack } from './BakedColliders';

/** Node-only: the baked colliders for a map, or null if `scripts/bake-colliders.mjs` hasn't been run for it. */
export function loadBaked(trackId: string, root = process.cwd()): BakedTrack | null {
  const file = resolve(root, 'data/colliders', `${trackId}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as BakedTrack) : null;
}
