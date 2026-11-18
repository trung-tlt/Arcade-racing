import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DistanceCull, InstanceWindow, fogCullDistance, selectWithin, windowInstances } from '../src/world/Windowed';

describe('fogCullDistance', () => {
  it('matches the exp² fog formula', () => {
    // factor = 1 - exp(-(d·density)²); at the returned distance the object is (1 - tail) fogged.
    const d = fogCullDistance(0.006, 0.02);
    expect(1 - Math.exp(-((d * 0.006) ** 2))).toBeCloseTo(0.98, 5);
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(340);
    expect(fogCullDistance(0.0022)).toBeGreaterThan(800); // the day map sees much further
  });
});

describe('selectWithin', () => {
  const xz = new Float32Array([0, 0, 10, 0, 0, 30, -50, 50, 100, 100]);
  it('returns the indices inside the radius, in order', () => {
    const out = new Uint32Array(5);
    const n = selectWithin(xz, 0, 0, 31, out);
    expect(Array.from(out.subarray(0, n))).toEqual([0, 1, 2]);
  });
  it('is empty when nothing is near', () => {
    const out = new Uint32Array(5);
    expect(selectWithin(xz, 500, 500, 10, out)).toBe(0);
  });
  it('includes points exactly on the radius', () => {
    const out = new Uint32Array(5);
    expect(selectWithin(new Float32Array([5, 0]), 0, 0, 5, out)).toBe(1);
  });
});

function mesh(positions: [number, number][]): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), positions.length);
  const mat = new THREE.Matrix4();
  positions.forEach(([x, z], i) => m.setMatrixAt(i, mat.makeTranslation(x, 0, z)));
  return m;
}

describe('InstanceWindow', () => {
  it('draws only instances near the camera and keeps their matrices and colours aligned', () => {
    const m = mesh([
      [0, 0],
      [20, 0],
      [500, 0],
      [-30, 0],
    ]);
    m.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array([1, 1, 1, 0.5, 0.5, 0.5, 0.2, 0.2, 0.2, 0.9, 0.9, 0.9]),
      3,
    );
    const win = windowInstances([m], 40);
    expect(win).not.toBeNull();
    expect(m.count).toBe(0); // nothing is drawn before the camera is known
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 5, 0);
    (m.onBeforeRender as unknown as (r: unknown, s: unknown, c: THREE.Camera) => void)(null, null, cam);
    expect(m.count).toBe(3); // instances 0, 1 and 3
    const a = m.instanceMatrix.array;
    expect([a[12], a[28], a[44]]).toEqual([0, 20, -30]);
    expect(Array.from(m.instanceColor.array.subarray(0, 9))).toEqual(
      [1, 1, 1, 0.5, 0.5, 0.5, 0.9, 0.9, 0.9].map((v) => Math.fround(v)),
    );
    // Move away: the far instance becomes the only one near.
    cam.position.set(500, 5, 0);
    (m.onBeforeRender as unknown as (r: unknown, s: unknown, c: THREE.Camera) => void)(null, null, cam);
    expect(m.count).toBe(1);
    expect(m.instanceMatrix.array[12]).toBe(500);
  });
  it('gives zero instances (no draw call) when the camera is far from everything', () => {
    const m = mesh([[0, 0]]);
    windowInstances([m], 10);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(1000, 0, 1000);
    (m.onBeforeShadow as unknown as (r: unknown, o: unknown, c: THREE.Camera) => void)(null, null, cam);
    expect(m.count).toBe(0);
  });
  it('shares one selection between sub-meshes of a model', () => {
    const a = mesh([
      [0, 0],
      [300, 0],
    ]);
    const b = mesh([
      [0, 0],
      [300, 0],
    ]);
    const win = windowInstances([a, b], 50) as InstanceWindow;
    const cam = new THREE.PerspectiveCamera();
    (a.onBeforeRender as unknown as (r: unknown, s: unknown, c: THREE.Camera) => void)(null, null, cam);
    (b.onBeforeRender as unknown as (r: unknown, s: unknown, c: THREE.Camera) => void)(null, null, cam);
    expect([a.count, b.count]).toEqual([1, 1]);
    expect(win.version).toBe(1);
  });
});

describe('DistanceCull', () => {
  it('shows children inside the distance and hides them outside', () => {
    const c = new DistanceCull(new THREE.Vector3(0, 0, 0), 100, 10);
    const child = new THREE.Object3D();
    c.add(child);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(105, 0, 0);
    c.update(cam);
    expect(child.visible).toBe(true); // 105 - 10 < 100
    cam.position.set(120, 0, 0);
    c.update(cam);
    expect(child.visible).toBe(false);
  });
});
