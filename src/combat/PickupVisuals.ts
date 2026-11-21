import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { COMBAT, WEAPONS, type TrackDef } from '../core/Data';
import { pickupPositions } from '../sim/pickupPositions';
import { InstancedModel } from '../world/InstancedModel';
import { drawDistance } from '../world/Windowed';
import type { TrackPath } from '../world/TrackPath';
import type { PickupDef, PickupField, PickupType } from './Pickups';

export const PICKUP_MODELS = (Object.keys(WEAPONS.pickups) as PickupType[]).map((k) => WEAPONS.pickups[k].model);

/** The cubes are 1.2 m wide: past this distance they are specks even in thin haze. */
const PICKUP_DRAW_M = 350;

const base = new THREE.Matrix4();

/** Holo-cube pickups on the track: instanced per type, bob the whole cube, spin the `icon`, hide while taken. */
export class PickupVisuals {
  readonly group = new THREE.Group();
  /** World position (x,y,z) of every pickup, indexed by pickup id. */
  readonly positions: THREE.Vector3[] = [];
  private readonly models = new Map<PickupType, InstancedModel>();
  /** Pickup id → instance index inside its type's model. */
  private readonly slot: number[] = [];
  private time = 0;

  constructor(
    private readonly scene: THREE.Scene,
    assets: Assets,
    defs: readonly PickupDef[],
    path: TrackPath,
    track: TrackDef,
  ) {
    this.group.name = 'pickups';
    const counts = new Map<PickupType, number>();
    for (const d of defs) {
      this.slot[d.id] = counts.get(d.type) ?? 0;
      counts.set(d.type, this.slot[d.id] + 1);
    }
    for (const [type, n] of counts) {
      this.models.set(type, new InstancedModel(this.group, assets, WEAPONS.pickups[type].model, n));
    }
    for (const [id, v] of pickupPositions(defs, path, track).entries()) {
      if (v) this.positions[id] = new THREE.Vector3(v.x, v.y, v.z);
    }
    // Pickups are tiny and spread over the whole lap: draw a type only while one of its cubes is within the fog's reach.
    for (const [type, model] of this.models) {
      const xz: number[] = [];
      for (const d of defs) {
        if (d.type !== type) continue;
        xz.push(this.positions[d.id].x, this.positions[d.id].z);
      }
      model.gate(new Float32Array(xz), Math.min(drawDistance(track.daylight, 4), PICKUP_DRAW_M));
    }
    scene.add(this.group);
  }

  update(dt: number, field: PickupField): void {
    this.time += dt;
    const spin = this.time * COMBAT.pickupSpinRadPerSec;
    for (const d of field.defs) {
      const m = this.models.get(d.type) as InstancedModel;
      const i = this.slot[d.id];
      if (!field.isAvailable(d.id)) {
        m.hide(i);
        continue;
      }
      const p = this.positions[d.id];
      const bob = Math.sin((this.time * COMBAT.pickupBobHz + d.id * 0.7) * Math.PI * 2) * COMBAT.pickupBobM;
      base.makeTranslation(p.x, p.y + bob - COMBAT.pickupHeightM + COMBAT.pickupHeightM, p.z);
      m.set(i, base, spin);
    }
    for (const m of this.models.values()) m.commit();
  }

  dispose(): void {
    for (const m of this.models.values()) m.dispose();
    this.scene.remove(this.group);
  }
}
