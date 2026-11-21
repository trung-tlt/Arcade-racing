import type * as THREE from 'three';
import type { Assets } from '../core/Assets';
import type { Livery } from '../ai/Roster';
import { CarSim, type CarSimOptions } from '../sim/CarSim';
import { CarVisual } from './CarVisual';

export { gunConfig, type CarController, type CarKind } from '../sim/CarSim';

export interface CarOptions extends CarSimOptions {
  assets: Assets;
  scene: THREE.Scene;
  /** Underglow colour override (rivals / dummies). */
  tint?: string;
  /** Paint scheme for this car (rival Fulmine FX liveries). */
  livery?: Livery;
}

/** The browser's car: `CarSim` plus its models. */
export class Car extends CarSim {
  readonly visual: CarVisual;

  constructor(o: CarOptions) {
    super(o);
    this.visual = new CarVisual(o.assets, o.def, this.physics, o.tint, this.aim, o.livery);
    o.scene.add(this.visual.root);
  }

  protected override onFreeze(): void {
    this.visual.root.visible = false;
  }

  protected override onRespawn(): void {
    this.visual.root.visible = true;
  }

  override dispose(): void {
    this.visual.dispose();
    super.dispose();
  }
}
