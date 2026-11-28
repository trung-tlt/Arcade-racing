import { describe, expect, it } from 'vitest';
import tracks from '../data/tracks/cat_lai.json';
import ardennes from '../data/tracks/ardennes.json';
import monteCarlo from '../data/tracks/monte_carlo.json';
import { CARS, WEAPONS, validateCars, validateTrack, validateWeapons } from '../src/core/Data';

describe('data files', () => {
  it('cars.json matches schema', () => expect(validateCars(CARS)).toEqual([]));
  it('weapons.json matches schema', () => expect(validateWeapons(WEAPONS)).toEqual([]));
  it('cat_lai.json matches schema', () => expect(validateTrack(tracks)).toEqual([]));
  it('monte_carlo.json matches schema (9 checkpoints)', () => expect(validateTrack(monteCarlo)).toEqual([]));
  it('ardennes.json matches schema (8 checkpoints)', () => expect(validateTrack(ardennes)).toEqual([]));
  it('rejects a track with too few checkpoints', () => {
    const bad = { ...monteCarlo, checkpoints: monteCarlo.checkpoints.slice(0, 5) };
    expect(validateTrack(bad).join()).toContain('checkpoints');
  });
  it('rejects broken cars', () => {
    expect(validateCars([{ id: 'x' }]).length).toBeGreaterThan(0);
    expect(validateCars([])).not.toEqual([]);
  });
});

describe('vehicle garage', () => {
  it('has the 11 vehicles with the expected types', () => {
    expect(CARS.map((c) => c.id)).toEqual([
      'raijin_rx',
      'kestrel_gt',
      'facet_xt',
      'wisp_r',
      'warden_px',
      'velora_s',
      'bento_ev',
      'truongson_av8',
      'mantis_650r',
      'mira_150',
      'fulmine_fx',
    ]);
    expect(CARS.filter((c) => c.vehicleType === 'apc8x8')).toHaveLength(1);
    expect(CARS.filter((c) => c.vehicleType === 'bike')).toHaveLength(2);
  });
  it('flags the open-wheel racer and validates its data', () => {
    const f = CARS.find((c) => c.id === 'fulmine_fx')!;
    expect(f.openWheel).toBe(true);
    expect(f.downforce).toBeGreaterThan(0);
    expect(f.turretYawDeg).toBe(10);
    expect(CARS.filter((c) => c.openWheel)).toHaveLength(1);
    expect(validateCars([{ ...f, downforce: -1 }]).join()).toContain('downforce');
    expect(validateCars([{ ...f, openWheel: 'yes' }]).join()).toContain('openWheel');
    expect(validateCars([{ ...f, fpv: { mode: 'tank' } }]).join()).toContain('fpv');
  });
  it('rejects a bike without lean or an APC with 4 wheels', () => {
    const bike = { ...CARS.find((c) => c.id === 'mantis_650r')!, maxLeanDeg: undefined };
    expect(validateCars([bike]).join()).toContain('maxLeanDeg');
    const apc = { ...CARS.find((c) => c.id === 'truongson_av8')!, wheels: CARS[0].wheels };
    expect(validateCars([apc]).length).toBeGreaterThan(0);
  });
});
