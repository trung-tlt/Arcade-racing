import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { FPV, type CarDef } from '../core/Data';
import { dashReadout, dueForRedraw, mirrorSpec, type DashReadout } from './FpvMath';

export const COCKPIT_RIG = 'models/cars/cockpit_rig.glb';

/** What the dash screen needs each frame. */
export interface CockpitFrame {
  steer: number;
  speedMps: number;
  reversing: boolean;
  gear: number;
  rpm: number;
  nitroBars: number;
  mph: boolean;
}

const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpEuler = new THREE.Euler();
const Z = new THREE.Vector3(0, 0, 1);

/**
 * The player's cockpit: the shared rig (dash with a live screen, wheel and hands, mirror with a rear-view render) in
 * its own scene and camera, drawn after the world so it never clips walls. The rig's origin is the driver's eye, so the
 * cockpit camera sits at the head's offset from it and the world camera is placed from the same head pose.
 */
export class CockpitView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(64, 16 / 9, FPV.near.cockpit, 30);
  readonly rig: THREE.Group;
  /** Mirror camera position and the fixed muzzle point, in car space (the rig's empties plus the eye). */
  readonly mirrorPos = new THREE.Vector3();
  readonly muzzlePos = new THREE.Vector3();
  private readonly wheel: THREE.Object3D | null;
  private readonly wheelBase = new THREE.Quaternion();
  private wheelAngle = 0;
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x333344, 1);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private mainHemi: THREE.HemisphereLight | null = null;
  private mainSun: THREE.DirectionalLight | null = null;
  private readonly owned: { dispose(): void }[] = [];

  // Dash screen
  private readonly dashCanvas: HTMLCanvasElement | null;
  private readonly dashCtx: CanvasRenderingContext2D | null;
  private readonly dashTex: THREE.CanvasTexture | null;
  private dashAcc = 1;
  private readonly dashHz: number;

  // Mirror
  private readonly mirrorRT: THREE.WebGLRenderTarget | null;
  private readonly mirrorCam: THREE.PerspectiveCamera;
  private readonly glass: THREE.Mesh | null;
  private readonly glassEdge: THREE.LineSegments | null;
  private readonly glassMat: THREE.MeshBasicMaterial | null;
  private mirrorAcc = 1;
  private readonly mirrorFps: number;
  private mirrorOn = true;
  /** Draw calls the last mirror render cost: skipped while the rest of the frame plus this would break the budget. */
  private mirrorCalls = 0;
  private threat = false;

  get mirrorThreat(): boolean {
    return this.threat;
  }

  constructor(assets: Assets, def: CarDef, low: boolean) {
    const f = def.fpv;
    if (!f || f.mode !== 'cockpit') throw new Error(`${def.id}: no cockpit rig`);
    this.rig = assets.cloneModel(f.rig ?? COCKPIT_RIG);
    this.rig.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false; // the camera sits inside the rig
      }
    });
    this.scene.add(this.rig, this.hemi, this.sun);
    this.sun.position.set(0, 1, 0);
    this.scene.add(this.sun.target);

    // Per-car colours: the bonnet takes the paint, the accent lights the trim.
    const tint = f.tint ?? { paint: def.paint, accent: def.paint };
    this.forMaterial('Cockpit_Paint', (m) => m.color.set(tint.paint));
    this.forMaterial('Cockpit_Accent', (m) => {
      m.color.set(tint.accent);
      m.emissive.set(tint.accent);
    });

    // Steering wheel: the node is tilted, so turn it about its own axis on top of that tilt.
    this.wheel = this.rig.getObjectByName('steering_wheel') ?? null;
    if (this.wheel) this.wheelBase.copy(this.wheel.quaternion);
    const mir = this.rig.getObjectByName('rear_mirror_cam');
    const mz = this.rig.getObjectByName('muzzle_fpv');
    this.mirrorPos.set(f.eye[0], f.eye[1], f.eye[2]).add(mir?.position ?? tmpV.set(-0.36, 0.35, -0.8));
    this.muzzlePos.set(f.eye[0], f.eye[1], f.eye[2]).add(mz?.position ?? tmpV.set(-0.36, 0.42, 0.6));

    // Dash screen: a canvas redrawn a few times a second.
    this.dashHz = low ? FPV.dash.lowHz : FPV.dash.hz;
    this.dashCanvas = document.createElement('canvas');
    this.dashCanvas.width = this.dashCanvas.height = FPV.dash.size;
    this.dashCtx = this.dashCanvas.getContext('2d');
    this.dashTex = new THREE.CanvasTexture(this.dashCanvas);
    this.dashTex.colorSpace = THREE.SRGBColorSpace;
    this.owned.push(this.dashTex);
    this.forMaterial('Dash_Screen', (m) => {
      m.map = null;
      m.color.set(0x000000);
      m.emissive.set(0xffffff);
      m.emissiveMap = this.dashTex;
      m.emissiveIntensity = 1.1;
      m.needsUpdate = true;
    });

    // Mirror: the glass shows a small render from behind the car, flipped so it reads as a mirror.
    const spec = mirrorSpec(low, FPV.mirror);
    this.mirrorFps = spec.fps;
    this.mirrorCam = new THREE.PerspectiveCamera(
      FPV.mirror.fovDeg,
      spec.width / spec.height,
      FPV.mirror.near,
      FPV.mirror.far,
    );
    this.mirrorRT = new THREE.WebGLRenderTarget(spec.width, spec.height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    this.mirrorRT.texture.wrapS = THREE.RepeatWrapping;
    this.mirrorRT.texture.repeat.x = -1;
    this.mirrorRT.texture.offset.x = 1;
    this.owned.push(this.mirrorRT);
    let glass: THREE.Mesh | null = null;
    this.rig.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.Material && o.material.name === 'Mirror_Glass')
        glass = o;
    });
    this.glass = glass;
    this.glassMat = glass ? new THREE.MeshBasicMaterial({ map: this.mirrorRT.texture, fog: false }) : null;
    if (glass && this.glassMat) {
      (glass as THREE.Mesh).material = this.glassMat;
      this.owned.push(this.glassMat);
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry((glass as THREE.Mesh).geometry, 30),
        new THREE.LineBasicMaterial({ color: FPV.mirror.threatColor, toneMapped: false }),
      );
      edge.visible = false;
      edge.frustumCulled = false;
      (glass as THREE.Mesh).add(edge);
      this.owned.push(edge.geometry, edge.material as THREE.Material);
      this.glassEdge = edge;
    } else this.glassEdge = null;
  }

  private forMaterial(name: string, fn: (m: THREE.MeshStandardMaterial) => void): void {
    this.rig.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m instanceof THREE.MeshStandardMaterial && m.name === name) fn(m);
      }
    });
  }

  setMirror(on: boolean): void {
    this.mirrorOn = on;
    if (this.glass) this.glass.visible = on;
  }

  /** Red outline and tint on the mirror while a rocket is locked on the player. */
  setMirrorThreat(on: boolean): void {
    this.threat = on;
    if (this.glassEdge) this.glassEdge.visible = on;
    this.glassMat?.color.set(on ? 0xff9aae : 0xffffff);
  }

  /** The head: where the cockpit camera sits relative to the eye, and how it is turned (radians). */
  update(
    dt: number,
    f: CockpitFrame,
    head: { x: number; y: number; z: number; yaw: number; roll: number; pitch: number },
    aspect: number,
    fov: number,
    carQuat: THREE.Quaternion,
    scene: THREE.Scene,
  ): void {
    // Camera: head offset and rotation inside the cabin (the cabin itself never moves in this scene).
    this.camera.position.set(head.x, head.y, head.z);
    tmpEuler.set(head.pitch, head.yaw + Math.PI, -head.roll, 'YXZ');
    this.camera.quaternion.setFromEuler(tmpEuler);
    if (this.camera.aspect !== aspect || this.camera.fov !== fov) {
      this.camera.aspect = aspect;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // Wheel follows the steering (hands are its children).
    if (this.wheel) {
      const goal = f.steer * FPV.wheel.radPerSteer;
      this.wheelAngle += (goal - this.wheelAngle) * (1 - Math.exp(-dt / FPV.wheel.rateSec));
      tmpQ.setFromAxisAngle(Z, this.wheelAngle);
      this.wheel.quaternion.copy(this.wheelBase).multiply(tmpQ);
    }

    // Same light as the world, expressed in cabin space: the sun direction un-rotated by the car's orientation.
    this.syncLights(scene, carQuat);

    this.dashAcc += dt;
    if (dueForRedraw(this.dashAcc, this.dashHz)) {
      this.dashAcc = 0;
      this.drawDash(dashReadout(f.speedMps, f.reversing, f.gear, f.rpm, f.nitroBars, f.mph));
    }
  }

  private syncLights(scene: THREE.Scene, carQuat: THREE.Quaternion): void {
    if (!this.mainHemi || !this.mainSun) {
      scene.traverse((o) => {
        if (o instanceof THREE.HemisphereLight && !this.mainHemi) this.mainHemi = o;
        if (o instanceof THREE.DirectionalLight && !this.mainSun) this.mainSun = o;
      });
    }
    this.scene.environment = scene.environment;
    this.scene.environmentIntensity = scene.environmentIntensity;
    if (this.mainHemi) {
      this.hemi.color.copy(this.mainHemi.color);
      this.hemi.groundColor.copy(this.mainHemi.groundColor);
      this.hemi.intensity = this.mainHemi.intensity;
    }
    if (this.mainSun) {
      this.sun.color.copy(this.mainSun.color);
      this.sun.intensity = this.mainSun.intensity;
      // Direction the light travels from the sun to its target, in world space, then into the cabin's frame.
      tmpV.copy(this.mainSun.position).sub(this.mainSun.target.position).normalize();
      tmpQ.copy(carQuat).invert();
      tmpV.applyQuaternion(tmpQ);
      this.sun.position.copy(tmpV).multiplyScalar(10);
    }
  }

  /** Renders the rear view into the mirror texture at its own rate (30 fps; 15 on Low). */
  renderMirror(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    dt: number,
    carPos: THREE.Vector3,
    carQuat: THREE.Quaternion,
    /** Draw calls of the rest of the frame (the main pass), to keep the whole frame inside the budget. */
    mainCalls = 0,
  ): void {
    this.mirrorAcc += dt;
    if (!this.mirrorOn || !this.mirrorRT || !dueForRedraw(this.mirrorAcc, this.mirrorFps)) return;
    if (mainCalls + this.mirrorCalls > FPV.mirror.maxTotalCalls) return; // busy frame: keep the last picture
    this.mirrorAcc = 0;
    const before = renderer.info.render.calls;
    // The camera looks down its own −Z, which is the car's rear when it shares the car's orientation.
    this.mirrorCam.position.copy(this.mirrorPos).applyQuaternion(carQuat).add(carPos);
    this.mirrorCam.quaternion.copy(carQuat);
    this.mirrorCam.updateMatrixWorld(true);
    const shadow = renderer.shadowMap.autoUpdate;
    const prev = renderer.getRenderTarget();
    renderer.shadowMap.autoUpdate = false; // reuse the shadow map the main pass just drew
    renderer.setRenderTarget(this.mirrorRT);
    renderer.render(scene, this.mirrorCam);
    renderer.setRenderTarget(prev);
    renderer.shadowMap.autoUpdate = shadow;
    this.mirrorCalls = renderer.info.render.calls - before;
  }

  /** Where tracers start in this view: the rig's muzzle point in world space. */
  muzzleWorld(carPos: THREE.Vector3, carQuat: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.muzzlePos).applyQuaternion(carQuat).add(carPos);
  }

  private drawDash(d: DashReadout): void {
    const c = this.dashCtx;
    const cv = this.dashCanvas;
    if (!c || !cv) return;
    const w = cv.width;
    const h = cv.height;
    c.fillStyle = '#06090d';
    c.fillRect(0, 0, w, h);
    // Revs: an arc across the top that turns orange near the limit.
    const cx = w / 2;
    const cy = h * 0.62;
    const r = w * 0.4;
    c.lineWidth = w * 0.045;
    c.lineCap = 'round';
    c.strokeStyle = '#1b2430';
    c.beginPath();
    c.arc(cx, cy, r, Math.PI * 0.8, Math.PI * 2.2);
    c.stroke();
    c.strokeStyle = d.rpm > 0.85 ? '#ff6a1a' : '#2ec5ff';
    c.beginPath();
    c.arc(cx, cy, r, Math.PI * 0.8, Math.PI * (0.8 + 1.4 * d.rpm));
    c.stroke();
    // Speed, unit and gear.
    c.fillStyle = '#e8ecf2';
    c.textAlign = 'center';
    c.font = `700 ${w * 0.27}px "Space Grotesk", Inter, sans-serif`;
    c.fillText(d.speed, cx, cy + w * 0.09);
    c.fillStyle = '#9aa4b5';
    c.font = `600 ${w * 0.07}px Inter, sans-serif`;
    c.fillText(d.unit, cx, cy + w * 0.2);
    c.fillStyle = '#ffb37a';
    c.font = `700 ${w * 0.12}px "Space Grotesk", Inter, sans-serif`;
    c.fillText(d.gear, cx, cy - w * 0.22);
    // Nitro: three bars along the bottom.
    for (let i = 0; i < 3; i++) {
      const fill = Math.min(1, Math.max(0, d.nitroBars - i));
      const bw = w * 0.22;
      const x = cx - bw * 1.6 + i * (bw + w * 0.03);
      c.fillStyle = '#1b2430';
      c.fillRect(x, h * 0.9, bw, h * 0.05);
      c.fillStyle = '#2ec5ff';
      c.fillRect(x, h * 0.9, bw * fill, h * 0.05);
    }
    if (this.dashTex) this.dashTex.needsUpdate = true;
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.rig.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
    });
    this.scene.clear();
  }
}
