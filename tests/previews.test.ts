import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRACKS } from '../src/core/Data';

describe('map preview images', () => {
  it('ships an in-game render for every map', () => {
    for (const t of TRACKS) {
      const file = `public/assets/ui/previews/${t.id}.jpg`;
      expect(existsSync(file), file).toBe(true);
      expect(statSync(file).size, file).toBeGreaterThan(20_000);
    }
  });
});
