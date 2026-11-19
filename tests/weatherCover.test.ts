import { describe, expect, it } from 'vitest';
import { AUDIO, PHAM_VAN_DONG } from '../src/core/Data';
import { coverFactor, coversFromTrack } from '../src/weather/cover';
import { SplashPool } from '../src/weather/SplashPool';
import { rearAnchor, rotateByQuat } from '../src/weather/geom';

const W = AUDIO.weather;

describe('rain under the ring-road overpass', () => {
  const boxes = coversFromTrack(PHAM_VAN_DONG.raw, W.overpassHalfXM, W.overpassHalfZM, W.overpassDeckHeightM);
  it('builds one cover from the track JSON (position [90, 0, -1925], deck at 8 m)', () => {
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ x: 90, z: -1925, deckY: 8 });
  });
  it('halves the rain under the deck, not beside it or on top', () => {
    expect(coverFactor(boxes, 90, 0, -1925, 0.5)).toBe(0.5);
    expect(coverFactor(boxes, 100, -2.4, -1920, 0.5)).toBe(0.5);
    expect(coverFactor(boxes, 90, 9, -1925, 0.5)).toBe(1); // on the deck
    expect(coverFactor(boxes, 200, 0, -1925, 0.5)).toBe(1);
    expect(coverFactor(boxes, 90, 0, -1800, 0.5)).toBe(1);
  });
  it('maps without an overpass have no cover', () => {
    expect(coversFromTrack({}, 1, 1, 8)).toEqual([]);
  });
});

describe('geometry helpers', () => {
  it('rotateByQuat: identity and a 90 degree turn about Y', () => {
    const out = { x: 0, y: 0, z: 0 };
    rotateByQuat({ x: 0, y: 0, z: 0, w: 1 }, 1, 2, 3, out);
    expect(out).toEqual({ x: 1, y: 2, z: 3 });
    const h = Math.SQRT1_2;
    rotateByQuat({ x: 0, y: h, z: 0, w: h }, 0, 0, 1, out); // +Z turned left about +Y... to +X
    expect(out.x).toBeCloseTo(1, 6);
    expect(out.z).toBeCloseTo(0, 6);
  });
  it('rearAnchor takes the rear wheels only', () => {
    const a = rearAnchor([
      { x: 0.9, y: 0.3, z: 1.4, rear: false, radius: 0.3 },
      { x: 0.9, y: 0.3, z: -1.4, rear: true, radius: 0.3 },
      { x: -0.9, y: 0.3, z: -1.4, rear: true, radius: 0.3 },
    ]);
    expect(a.halfTrack).toBeCloseTo(0.9);
    expect(a.z).toBeCloseTo(-1.4);
    expect(a.y).toBeCloseTo(0);
  });
});

describe('splash pool', () => {
  it('recycles a full pool without growing and fades particles out', async () => {
    const THREE = await import('three');
    const scene = new THREE.Scene();
    const pool = new SplashPool(scene, new THREE.Texture(), 8);
    for (let i = 0; i < 30; i++) pool.emit(0, 0, 0, 0, 1, 0, 0.5, 0.5, 1, 0.5);
    pool.update(0.01, 600);
    expect(pool.active).toBe(8);
    for (let i = 0; i < 60; i++) pool.update(0.02, 600);
    expect(pool.active).toBe(0);
    expect(pool.points.visible).toBe(false);
    pool.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
