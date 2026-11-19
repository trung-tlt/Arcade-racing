import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Assets } from '../src/core/Assets';
import { CAT_LAI, CONG_HOA, XA_LO } from '../src/core/Data';
import { SPONSOR_MODELS, Sponsors, sponsorPlacements } from '../src/world/Sponsors';
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

describe('Sponsors scene', () => {
  // Stub models with the real GLBs' material names: posts/frame/steel plain, one textured print or ad face.
  const stubAssets = {
    cloneModel(path: string): THREE.Group {
      const g = new THREE.Group();
      const banner = path.includes('sponsor_banner');
      const parts = banner
        ? ['Banner_Post', 'Banner_Frame', 'Banner_Print']
        : ['Billboard_Steel', 'Billboard_Ad', 'Billboard_Lamp'];
      for (const name of parts) {
        const mat = new THREE.MeshStandardMaterial({ color: '#888888', metalness: 0.1 });
        mat.name = name;
        if (name === 'Banner_Print' || name === 'Billboard_Ad') {
          const tex = new THREE.Texture({ width: 64, height: 64 } as unknown as HTMLImageElement);
          tex.name = banner ? 'sponsor_banners' : 'sponsor_billboards';
          mat.map = tex;
        }
        if (name === 'Billboard_Lamp') {
          mat.emissive.set('#ffffff');
          mat.emissiveIntensity = 2;
        }
        g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
      }
      return g;
    },
  } as unknown as Assets;

  it.each([CAT_LAI, CONG_HOA])('bakes every board of $id into a handful of draw calls and cleans up', (track) => {
    const scene = new THREE.Scene();
    const s = new Sponsors(scene, stubAssets, track);
    let meshes = 0;
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes++;
    });
    expect(sponsorPlacements(track).length).toBeGreaterThan(10);
    expect(meshes).toBeGreaterThan(0);
    expect(meshes).toBeLessThanOrEqual(6); // the old one-InstancedMesh-per-sub-mesh version cost ~3 per model
    s.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
