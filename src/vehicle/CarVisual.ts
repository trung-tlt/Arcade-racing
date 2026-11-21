import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { COMBAT, type CarDef } from '../core/Data';
import type { CarPhysics } from './CarPhysics';
import { DistanceCull } from '../world/Windowed';
import { mergeCarMaterials } from './MergeMaterials';
import type { Livery } from '../ai/Roster';
import { approachAngle } from './Turret';

const FLAME_TEX = 'textures/fx_nitro_flame.png';

export type { TurretAim } from '../sim/CarSim';
import type { TurretAim } from '../sim/CarSim';

const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const leanQ = new THREE.Quaternion();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/** Beyond this distance from the camera a car draws only its chassis (wheels and gun are a few pixels). */
const DETAIL_DISTANCE_M = 70;

export class CarVisual {
  readonly root: THREE.Group;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly detail: DistanceCull;
  private shadowOn = true;
  /** One entry per cars.json wheel: the node plus the physics wheels (layout indices) that drive it. */
  private readonly wheels: { node: THREE.Object3D; baseY: number; radius: number; idx: number[] }[] = [];
  private readonly spin: number[] = [];
  private tail: THREE.MeshStandardMaterial | null = null;
  private sirenRed: THREE.MeshStandardMaterial | null = null;
  private sirenBlue: THREE.MeshStandardMaterial | null = null;
  private sirenT = 0;
  private readonly gunMount: THREE.Object3D | null;
  private gunYaw = 0;
  private readonly flames: THREE.Sprite[] = [];
  private flameT = 0;

  constructor(
    assets: Assets,
    def: CarDef,
    private readonly physics: CarPhysics,
    tint?: string,
    private readonly aim?: TurretAim,
    livery?: Livery,
  ) {
    this.root = assets.cloneModel(def.file);
    // A livery recolours the body and its accent parts (baked into the merged geometry, so it costs no extra draws).
    mergeCarMaterials(
      this.root,
      (m) => m.name.startsWith('wheel_'),
      livery ? { Paint: livery.paint, Paint_Accent: livery.accent, Caliper: livery.accent } : undefined,
    );
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        this.meshes.push(o);
      }
    });

    const layout = physics.wheelLayout;
    for (const wd of def.wheels) {
      const node = this.root.getObjectByName(wd.name);
      if (!node) throw new Error(`${def.id}: model is missing ${wd.name}`);
      node.rotation.order = 'YXZ';
      const idx: number[] = [];
      layout.forEach((l, i) => {
        if (l.visual === wd.name) idx.push(i);
      });
      this.wheels.push({ node, baseY: wd.y, radius: idx.length ? layout[idx[0]].radius : wd.radius, idx });
      this.spin.push(0);
    }
    this.gunMount = this.root.getObjectByName('gun_mount') ?? null;

    // Detail LOD: past DETAIL_DISTANCE_M the wheels and gun mount (7+ draw calls) are too small to see, so don't draw them.
    // The cull object stays at the root's origin with an identity transform, so reparenting keeps every pose unchanged.
    this.detail = new DistanceCull(new THREE.Vector3(), DETAIL_DISTANCE_M, 3);
    this.root.add(this.detail);
    for (const w of this.wheels) this.detail.add(w.node);
    if (this.gunMount) this.detail.add(this.gunMount);

    // Materials are already cloned per instance by Assets.cloneModel, so tinting is safe.
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!(m instanceof THREE.MeshStandardMaterial)) continue;
        if (m.name === 'Underglow') m.emissive.set(livery?.glow ?? tint ?? def.paint);
        if (m.name === 'Light_Tail') this.tail = m;
        if (m.name === 'Light_Siren_Red') this.sirenRed = m;
        if (m.name === 'Light_Siren_Blue') this.sirenBlue = m;
      }
    });

    const tex = assets.texture(FLAME_TEX);
    for (const name of ['exhaust_L', 'exhaust_R']) {
      const pipe = this.root.getObjectByName(name);
      if (!pipe) continue;
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      );
      s.position.z = -0.6;
      s.scale.set(0.7, 0.7, 1);
      s.visible = false;
      pipe.add(s);
      this.flames.push(s);
    }
  }

  /**
   * The player's own view from inside the car: `all` hides every mesh (the cockpit rig stands in for it), `rider` hides
   * only the rider so the fairing, bars and halo frame the view, `none` is the normal outside look. Meshes are toggled
   * rather than the root, so wrecks, respawn blinking and distance culling keep working unchanged.
   */
  setFirstPerson(mode: 'none' | 'all' | 'rider'): void {
    for (const m of this.meshes) m.visible = mode !== 'all';
    const rider = this.root.getObjectByName('rider');
    if (rider) rider.visible = mode === 'none';
  }

  /** Interpolates the body between the last two physics steps and animates wheels / lights / turret. */
  /** Cars far from the camera skip the shadow pass (every mesh is drawn twice otherwise). */
  setCastShadow(on: boolean): void {
    if (on === this.shadowOn) return;
    this.shadowOn = on;
    for (const m of this.meshes) m.castShadow = on;
  }

  update(alpha: number, dt: number): void {
    const { prev, curr } = this.physics;
    this.root.position.set(
      prev.p.x + (curr.p.x - prev.p.x) * alpha,
      prev.p.y + (curr.p.y - prev.p.y) * alpha,
      prev.p.z + (curr.p.z - prev.p.z) * alpha,
    );
    this.detail.center.copy(this.root.position);
    tmpQ.set(prev.q.x, prev.q.y, prev.q.z, prev.q.w);
    tmpQ2.set(curr.q.x, curr.q.y, curr.q.z, curr.q.w);
    this.root.quaternion.copy(tmpQ.slerp(tmpQ2, alpha));
    // Bike lean is purely visual: tilt the render root about its own forward axis, never the physics body.
    if (this.physics.leanRad !== 0) {
      leanQ.setFromAxisAngle(Z_AXIS, this.physics.leanRad);
      this.root.quaternion.multiply(leanQ);
    }

    const conn = this.physics.wheels;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      if (w.idx.length === 0) continue;
      let steer = 0;
      let susp = 0;
      for (const j of w.idx) {
        steer += conn[j].steerAngle;
        susp += conn[j].suspensionLength;
      }
      const n = w.idx.length;
      this.spin[i] += (this.physics.forwardSpeed * dt) / w.radius;
      w.node.rotation.x = this.spin[i];
      w.node.rotation.y = steer / n;
      // Hub height = connection point − current suspension length.
      w.node.position.y = w.baseY + (this.physics.suspensionRest - susp / n);
    }

    if (this.tail) this.tail.emissiveIntensity = this.physics.braking ? 4 : 1;

    if (this.sirenRed && this.sirenBlue) {
      this.sirenT += dt;
      const redOn = Math.floor(this.sirenT * COMBAT.sirenHz * 2) % 2 === 0;
      this.sirenRed.emissiveIntensity = redOn ? COMBAT.sirenOnIntensity : COMBAT.sirenOffIntensity;
      this.sirenBlue.emissiveIntensity = redOn ? COMBAT.sirenOffIntensity : COMBAT.sirenOnIntensity;
    }

    if (this.gunMount && this.aim) {
      let target = 0;
      if (this.aim.holdSec > 0) {
        this.aim.holdSec -= dt;
        target = this.aim.yawRad;
      }
      this.gunYaw = approachAngle(this.gunYaw, target, COMBAT.turret.yawRateRadPerSec * dt);
      this.gunMount.rotation.y = this.gunYaw;
    }

    this.flameT += dt * 40;
    const on = this.physics.nitroActive;
    for (const f of this.flames) {
      f.visible = on;
      if (on) f.scale.setScalar(0.7 + 0.25 * Math.sin(this.flameT + f.id));
    }
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m.userData.shared) m.dispose();
        }
      }
      if (o instanceof THREE.Sprite) o.material.dispose();
    });
    this.root.removeFromParent();
  }
}
