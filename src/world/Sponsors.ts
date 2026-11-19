import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Assets } from '../core/Assets';
import type { TrackDef } from '../core/Data';
import { mergePropMaterials } from '../vehicle/MergeMaterials';

const BANNERS = ['emesoft', 'capturemann', 'craftmann', 'voltline'].map((n) => `models/props/sponsor_banner_${n}.glb`);
const BILLBOARDS = ['capturemann', 'craftmann', 'emesoft', 'voltline'].map(
  (n) => `models/props_xalo/billboard_${n}.glb`,
);

/** Sponsor models placed from a track's JSON (Hanoi Highway places its own billboards in XaLoMetro). */
export const SPONSOR_MODELS: string[] = [...BANNERS, ...BILLBOARDS];

export interface SponsorPlacement {
  model: string;
  position: [number, number, number];
  yawDeg: number;
}

function isPlacement(v: unknown): v is SponsorPlacement {
  const p = v as Partial<SponsorPlacement> | null;
  return (
    !!p &&
    typeof p.model === 'string' &&
    Array.isArray(p.position) &&
    p.position.length === 3 &&
    p.position.every((n) => Number.isFinite(n)) &&
    Number.isFinite(p.yawDeg)
  );
}

function list(v: unknown): SponsorPlacement[] {
  return Array.isArray(v) ? v.filter(isPlacement) : [];
}

/**
 * Every sponsor banner / billboard a track lists: Cat Lai `sponsors.{banners,billboards,quayBanners}`, Cong Hoa
 * `dressing.{sponsorBanners.items,rooftopBillboards}`. Malformed entries are dropped.
 */
export function sponsorPlacements(track: TrackDef): SponsorPlacement[] {
  const raw = track.raw as {
    sponsors?: Record<string, unknown>;
    dressing?: { sponsorBanners?: { items?: unknown }; rooftopBillboards?: unknown };
  };
  return [
    ...list(raw.sponsors?.banners),
    ...list(raw.sponsors?.billboards),
    ...list(raw.sponsors?.quayBanners),
    ...list(raw.dressing?.sponsorBanners?.items),
    ...list(raw.dressing?.rooftopBillboards),
  ];
}

/** Identity of a draw: merged vertex-colour materials by name, textured ones by texture name + size (each GLB embeds its own copy). */
function materialKey(m: THREE.Material): string {
  if (m.userData.shared) return m.name;
  const s = m as THREE.MeshStandardMaterial;
  const img = s.map?.image as { width?: number; height?: number } | null | undefined;
  const tex = s.map ? (s.map.name ? `${s.map.name}:${img?.width}x${img?.height}` : s.map.uuid) : '';
  return `${m.name}|${tex}|${s.color?.getHex() ?? 0}|${s.emissive?.getHex() ?? 0}|${s.emissiveIntensity ?? 0}`;
}

/**
 * Printed trackside banners and billboards. Every placement is baked into one static mesh per material for the whole
 * map, so the set costs about five draw calls however many boards the track lists. (Chunking and distance culling were
 * tried: on a day map the fog never hides a chunk, so each extra chunk only adds draws.)
 */
export class Sponsors {
  private readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly protos: THREE.Object3D[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    assets: Assets,
    track: TrackDef,
  ) {
    this.group.name = 'sponsors';
    const protos = new Map<string, THREE.Object3D>();
    const buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const place = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    for (const p of sponsorPlacements(track)) {
      let proto = protos.get(p.model);
      if (!proto) {
        proto = assets.cloneModel(p.model);
        mergePropMaterials(proto);
        proto.updateMatrixWorld(true);
        protos.set(p.model, proto);
        this.protos.push(proto);
      }
      q.setFromAxisAngle(up, THREE.MathUtils.degToRad(p.yawDeg));
      place.compose(new THREE.Vector3(...p.position), q, one);
      proto.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
        const key = materialKey(o.material);
        let b = buckets.get(key);
        if (!b) {
          b = { material: o.material, geos: [] };
          buckets.set(key, b);
        }
        world.multiplyMatrices(place, o.matrixWorld);
        b.geos.push(o.geometry.clone().applyMatrix4(world));
      });
    }

    for (const [key, b] of buckets) {
      const common = Object.keys(b.geos[0].attributes).filter((a) => b.geos.every((g) => g.getAttribute(a)));
      for (const g of b.geos) for (const a of Object.keys(g.attributes)) if (!common.includes(a)) g.deleteAttribute(a);
      const merged = mergeGeometries(b.geos, false);
      b.geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.name = `sponsors:${key}`;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    scene.add(this.group);
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose();
    const freed = new Set<THREE.Material>();
    for (const p of this.protos) {
      p.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m.userData.shared || freed.has(m)) continue;
          freed.add(m);
          m.dispose();
        }
      });
    }
    this.scene.remove(this.group);
  }
}
