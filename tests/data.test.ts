import { describe, expect, it } from 'vitest';
import tracks from '../data/tracks/cat_lai.json';
import { CARS, WEAPONS, validateCars, validateTrack, validateWeapons } from '../src/core/Data';

describe('data files', () => {
  it('cars.json matches schema', () => expect(validateCars(CARS)).toEqual([]));
  it('weapons.json matches schema', () => expect(validateWeapons(WEAPONS)).toEqual([]));
  it('cat_lai.json matches schema', () => expect(validateTrack(tracks)).toEqual([]));
  it('rejects broken cars', () => {
    expect(validateCars([{ id: 'x' }]).length).toBeGreaterThan(0);
    expect(validateCars([])).not.toEqual([]);
  });
});

describe('vehicle garage', () => {
  it('has the 9 vehicles with the expected types', () => {
    expect(CARS.map((c) => c.id)).toEqual([
      'kestrel_gt',
      'rhino_x4',
      'wisp_r',
      'warden_px',
      'bastion_m8',
      'sable_rs',
      'hauler_ht',
      'truongson_av8',
      'mantis_650r',
    ]);
    expect(CARS.filter((c) => c.vehicleType === 'apc8x8')).toHaveLength(1);
    expect(CARS.filter((c) => c.vehicleType === 'bike')).toHaveLength(1);
  });
  it('rejects a bike without lean or an APC with 4 wheels', () => {
    const bike = { ...CARS.find((c) => c.id === 'mantis_650r')!, maxLeanDeg: undefined };
    expect(validateCars([bike]).join()).toContain('maxLeanDeg');
    const apc = { ...CARS.find((c) => c.id === 'truongson_av8')!, wheels: CARS[0].wheels };
    expect(validateCars([apc]).length).toBeGreaterThan(0);
  });
});
