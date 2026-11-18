import { describe, expect, it } from 'vitest';
import harbor from '../data/tracks/cat_lai.json';
import { WEAPONS } from '../src/core/Data';
import { pickAimTarget } from '../src/combat/AutoAim';
import { Hull, type HullConfig } from '../src/combat/Damage';
import { expandPickups, grantFor, PickupField, type PickupType } from '../src/combat/Pickups';
import { PulseGun } from '../src/combat/PulseMG';
import { homingStep, RocketAmmo, splashDamage } from '../src/combat/Rockets';

const DT = 1 / 60;
const hullCfg: HullConfig = {
  maxHp: 100,
  respawnDelaySec: WEAPONS.wreck.respawnDelaySec,
  invulnerableSec: WEAPONS.wreck.invulnerableSec,
  smokeBelow: WEAPONS.damageStates[0].above,
  fireBelow: WEAPONS.damageStates[1].above,
};
const hullAt = (hp: number): Hull => {
  const h = new Hull(hullCfg);
  h.damage(100 - hp, 'x');
  return h;
};

describe('Hull', () => {
  it('maps HP to damage states', () => {
    expect(hullAt(61).state).toBe('ok');
    expect(hullAt(59).state).toBe('smoke');
    expect(hullAt(29).state).toBe('fire');
    expect(hullAt(0).state).toBe('wrecked');
  });
  it('wrecks at 0, respawns after 2 s with a 2 s shield', () => {
    const h = new Hull(hullCfg);
    expect(h.damage(150, 'rival')).toEqual({ applied: 100, wrecked: true });
    expect(h.wrecked).toBe(true);
    expect(h.lastAttacker).toBe('rival');
    expect(h.respawnIn).toBeCloseTo(2, 5);
    let ev: 'respawn' | null = null;
    let t = 0;
    while (!ev && t < 5) {
      ev = h.update(DT);
      t += DT;
    }
    expect(ev).toBe('respawn');
    expect(t).toBeCloseTo(2, 1);
    expect(h.hp).toBe(100);
    expect(h.wrecked).toBe(false);
    expect(h.invulnerable).toBe(true);
    expect(h.damage(50, 'rival').applied).toBe(0);
    for (let i = 0; i < 125; i++) h.update(DT);
    expect(h.invulnerable).toBe(false);
    expect(h.damage(50, 'rival').applied).toBe(50);
  });
  it('ignores damage and healing while wrecked', () => {
    const h = new Hull(hullCfg);
    h.damage(100, 'a');
    expect(h.damage(10, 'b')).toEqual({ applied: 0, wrecked: false });
    expect(h.lastAttacker).toBe('a');
    h.heal(50);
    expect(h.hp).toBe(0);
  });
  it('heal clamps at max', () => {
    const h = hullAt(80);
    h.heal(30);
    expect(h.hp).toBe(100);
  });
});

describe('PulseGun', () => {
  const cfg = { ...WEAPONS.pulse_mg };
  it('fires immediately, then at exactly 10 shots/s', () => {
    const g = new PulseGun({ ...cfg, heatPerShot: 0 }); // isolate the fire rate from overheating
    expect(g.update(DT, true, true)).toBe(1);
    let shots = 0;
    for (let i = 0; i < 60; i++) shots += g.update(DT, true, true);
    expect(shots).toBe(10);
    shots = 0;
    for (let i = 0; i < 60; i++) shots += g.update(DT, true, true);
    expect(shots).toBe(10);
  });
  it('overheats after ~3 s, locks 1.5 s, then fires again', () => {
    const g = new PulseGun(cfg);
    let t = 0;
    let shots = 0;
    while (!g.locked && t < 10) {
      shots += g.update(DT, true, true);
      t += DT;
    }
    expect(g.justOverheated).toBe(true);
    expect(t).toBeGreaterThan(2.8);
    expect(t).toBeLessThan(3.2);
    expect(shots).toBeGreaterThanOrEqual(29);
    expect(g.update(DT, true, true)).toBe(0);
    expect(g.justOverheated).toBe(false);
    let locked = DT;
    let fired = 0;
    while (g.locked && locked < 5) {
      fired += g.update(DT, true, true);
      locked += DT;
    }
    expect(fired).toBe(0);
    expect(locked).toBeCloseTo(cfg.overheatLockoutSec, 1);
    expect(g.heat).toBeCloseTo(cfg.heatAfterLockout, 5);
    expect(g.update(DT, true, true)).toBe(1);
  });
  it('cools while idle', () => {
    const g = new PulseGun(cfg);
    for (let i = 0; i < 60; i++) g.update(DT, true, true);
    const hot = g.heat;
    expect(hot).toBeGreaterThan(0.3);
    for (let i = 0; i < 60; i++) g.update(DT, false, true);
    expect(g.heat).toBeCloseTo(Math.max(0, hot - cfg.coolPerSec), 2);
  });
  it('fires nothing when disabled but still cools', () => {
    const g = new PulseGun(cfg);
    for (let i = 0; i < 30; i++) g.update(DT, true, true);
    const hot = g.heat;
    let shots = 0;
    for (let i = 0; i < 30; i++) shots += g.update(DT, true, false);
    expect(shots).toBe(0);
    expect(g.heat).toBeLessThan(hot);
  });
});

describe('pickAimTarget', () => {
  const o = { x: 0, y: 0, z: 0 };
  const fwd = { x: 0, y: 0, z: 1 };
  const at = (deg: number, d: number) => ({
    x: Math.sin((deg * Math.PI) / 180) * d,
    y: 0,
    z: Math.cos((deg * Math.PI) / 180) * d,
  });
  it('accepts inside the cone and rejects outside it or beyond range', () => {
    expect(pickAimTarget(o, fwd, [{ id: 'in', pos: at(5, 50) }], 8, 120)?.id).toBe('in');
    expect(pickAimTarget(o, fwd, [{ id: 'out', pos: at(12, 50) }], 8, 120)).toBeNull();
    expect(pickAimTarget(o, fwd, [{ id: 'far', pos: at(0, 130) }], 8, 120)).toBeNull();
  });
  it('picks the smallest angle, then nearest, and returns a unit direction', () => {
    const r = pickAimTarget(
      o,
      fwd,
      [
        { id: 'wide', pos: at(6, 20) },
        { id: 'tight', pos: at(2, 90) },
      ],
      8,
      120,
    );
    expect(r?.id).toBe('tight');
    expect(Math.hypot(r!.dir.x, r!.dir.y, r!.dir.z)).toBeCloseTo(1, 6);
    expect(r!.dist).toBeCloseTo(90, 5);
    const tie = pickAimTarget(
      o,
      fwd,
      [
        { id: 'far', pos: at(3, 80) },
        { id: 'near', pos: at(3, 30) },
      ],
      8,
      120,
    );
    expect(tie?.id).toBe('near');
  });
});

describe('rockets', () => {
  const angle = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
    Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z)));
  it('turns at most maxTurnRad toward the target and stays unit length', () => {
    const dir = { x: 0, y: 0, z: 1 };
    const to = { x: 10, y: 0, z: 0 };
    const out = homingStep(dir, to, 0.1);
    expect(angle(dir, out)).toBeCloseTo(0.1, 6);
    expect(out.x).toBeGreaterThan(0);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6);
  });
  it('snaps onto the target when within the limit and handles opposite vectors', () => {
    const near = homingStep({ x: 0, y: 0, z: 1 }, { x: 0.01, y: 0, z: 5 }, 0.5);
    expect(near.z).toBeGreaterThan(0.999);
    const back = homingStep({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -3 }, 0.2);
    expect(angle({ x: 0, y: 0, z: 1 }, back)).toBeCloseTo(0.2, 6);
  });
  it('splash falls off linearly across the radius', () => {
    const r = WEAPONS.hornet_rocket.splashRadiusM;
    const d = WEAPONS.hornet_rocket.damage;
    expect(splashDamage(d, 0, r)).toBe(d);
    expect(splashDamage(d, r / 2, r)).toBeCloseTo(d / 2, 6);
    expect(splashDamage(d, r, r)).toBe(0);
    expect(splashDamage(d, r + 1, r)).toBe(0);
  });
  it('tracks ammo', () => {
    const a = new RocketAmmo();
    expect(a.consume()).toBe(false);
    a.add(WEAPONS.hornet_rocket.ammoPerPickup);
    expect(a.consume()).toBe(true);
    expect(a.consume()).toBe(true);
    expect(a.consume()).toBe(false);
  });
});

describe('pickups', () => {
  const defs = expandPickups(harbor.pickups);
  const respawn: Record<PickupType, number> = {
    rocket: WEAPONS.pickups.rocket.respawnSec,
    repair: WEAPONS.pickups.repair.respawnSec,
    nitro: WEAPONS.pickups.nitro.respawnSec,
  };
  it('expands the real track data: 6 clusters, 16 items, sequential ids', () => {
    expect(harbor.pickups).toHaveLength(6);
    expect(defs).toHaveLength(16);
    expect(defs.map((d) => d.id)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(() => expandPickups([{ t: 0, items: [{ type: 'bogus', lane: 0 }] }])).toThrow();
  });
  it('take → unavailable → respawns after the delay', () => {
    const f = new PickupField(defs, respawn);
    expect(f.take(0)).toBe(defs[0].type);
    expect(f.take(0)).toBeNull();
    expect(f.isAvailable(0)).toBe(false);
    expect(f.respawnProgress(0)).toBeCloseTo(0, 5);
    let back: number[] = [];
    let t = 0;
    while (back.length === 0 && t < 20) {
      back = f.update(DT);
      t += DT;
    }
    expect(back).toEqual([0]);
    expect(t).toBeCloseTo(respawn[defs[0].type], 1);
    expect(f.isAvailable(0)).toBe(true);
    expect(f.respawnProgress(0)).toBe(1);
  });
  it('looks up grants', () => {
    const grants: Record<PickupType, Record<string, number>> = {
      rocket: WEAPONS.pickups.rocket.grants,
      repair: WEAPONS.pickups.repair.grants,
      nitro: WEAPONS.pickups.nitro.grants,
    };
    expect(grantFor('rocket', grants)).toEqual({ rockets: 2 });
    expect(grantFor('repair', grants)).toEqual({ hp: 30 });
    expect(grantFor('nitro', grants)).toEqual({ nitroBars: 1 });
  });
});
