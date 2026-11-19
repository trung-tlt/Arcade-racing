import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAT_LAI, CONG_HOA, XA_LO } from '../src/core/Data';
import { SPONSOR_MODELS, sponsorPlacements } from '../src/world/Sponsors';
import { XALO_METRO_MODELS } from '../src/world/XaLoMetro';

const onDisk = (m: string): boolean => existsSync(`public/assets/${m}`);

describe('sponsor placements', () => {
  it('Cat Lai lists 8 start-straight banners, 3 billboards and 4 quay banners', () => {
    expect(sponsorPlacements(CAT_LAI)).toHaveLength(15);
  });
  it('Cong Hoa lists its banners and 4 rooftop billboards', () => {
    const p = sponsorPlacements(CONG_HOA);
    expect(p.length).toBeGreaterThanOrEqual(16);
    expect(p.filter((x) => x.position[1] === 9)).toHaveLength(4);
  });
  it('Hanoi Highway places its own billboards, so nothing is added here', () => {
    expect(sponsorPlacements(XA_LO)).toHaveLength(0);
  });
  it('only uses models the loader fetches, and every one exists', () => {
    for (const t of [CAT_LAI, CONG_HOA]) {
      for (const p of sponsorPlacements(t)) {
        expect(SPONSOR_MODELS).toContain(p.model);
        expect(onDisk(p.model)).toBe(true);
      }
    }
  });
});

describe('Hanoi Highway billboards', () => {
  it('are all in the metro module model list and on disk', () => {
    const boards = (XA_LO.raw as { billboards: { model: string }[] }).billboards;
    expect(boards).toHaveLength(9);
    for (const b of boards) {
      expect(XALO_METRO_MODELS).toContain(b.model);
      expect(onDisk(b.model)).toBe(true);
    }
  });
});
