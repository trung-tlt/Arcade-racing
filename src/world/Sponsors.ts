import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import type { TrackDef } from '../core/Data';
import { InstancedModel } from './InstancedModel';
import { drawDistance } from './Windowed';

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

/** Printed trackside banners and billboards, one instanced set per model, culled by distance. */
export class Sponsors {
  private readonly group = new THREE.Group();
  private readonly sets: InstancedModel[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    assets: Assets,
    track: TrackDef,
  ) {
    const byModel = new Map<string, SponsorPlacement[]>();
    for (const p of sponsorPlacements(track)) byModel.set(p.model, [...(byModel.get(p.model) ?? []), p]);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const reach = drawDistance(track.daylight, 20);
    for (const [model, items] of byModel) {
      const set = new InstancedModel(this.group, assets, model, items.length);
      items.forEach((p, i) => {
        q.setFromAxisAngle(up, THREE.MathUtils.degToRad(p.yawDeg));
        set.set(i, m.compose(pos.set(...p.position), q, one));
      });
      set.commit();
      set.window(reach);
      this.sets.push(set);
    }
    scene.add(this.group);
  }

  dispose(): void {
    for (const s of this.sets) s.dispose();
    this.scene.remove(this.group);
  }
}
