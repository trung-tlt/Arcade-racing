import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { LIGHTING, getCarDef } from '../core/Data';
import type { CarPreview, PreviewFactory } from './types';
import { hideCarDecals } from '../vehicle/CarVisual';

const FOV = 32;
const SPIN_RAD_PER_SEC = 0.5;
const SWAY_RAD = 0.02;
const SWAY_HZ = 0.12;
const APPEAR_SEC = 0.4;
const MAX_DT = 0.1;

interface MaterialState {
  mat: THREE.Material;
  baseOpacity: number;
  baseTransparent: boolean;
}

/** Live turntable: one car on a dark stand with a paint-coloured ring, rendered into `container`. */
export class Showroom implements CarPreview {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  private readonly pivot = new THREE.Group();
  private readonly stand: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshStandardMaterial;
  private readonly observer: ResizeObserver;
  private readonly lights: THREE.Light[] = [];

  private car: THREE.Group | null = null;
  private carId = '';
  private states: MaterialState[] = [];
  private appear = 1;
  private fading = false;

  private radius = 2.5;
  private height = 1.4;
  private aspect = 1;

  private raf = 0;
  private running = false;
  private last = 0;
  private spin = 0;
  private time = 0;
  private readonly lookAt = new THREE.Vector3();

  constructor(
    private readonly container: HTMLElement,
    private readonly assets: Assets,
    carId: string,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = LIGHTING.exposure;
    const cv = this.renderer.domElement;
    cv.style.position = 'absolute';
    cv.style.inset = '0';
    cv.style.width = '100%';
    cv.style.height = '100%';
    cv.style.display = 'block';
    container.appendChild(cv);

    // Lights: cool sky/ground fill, a bright key from front-right, a neon rim from behind-left, an orange kicker.
    const hemi = new THREE.HemisphereLight('#7F9CD8', '#0E1116', 2.4);
    const key = new THREE.DirectionalLight('#FFFFFF', 4.2);
    key.position.set(5, 7, 6);
    const rim = new THREE.DirectionalLight('#2EC5FF', 5);
    rim.position.set(-6, 3, -5);
    const kicker = new THREE.DirectionalLight('#FF6A1A', 1.6);
    kicker.position.set(6, 1.5, -4);
    this.lights.push(hemi, key, rim, kicker);
    this.scene.add(hemi, key, rim, kicker);

    // Stand: unit-sized and scaled to the car in frame().
    this.stand = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 0.12, 64),
      new THREE.MeshStandardMaterial({ color: '#161B23', metalness: 0.6, roughness: 0.5 }),
    );
    this.stand.position.y = -0.06;
    this.ringMat = new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#2EC5FF', emissiveIntensity: 2.2 });
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 8, 96), this.ringMat);
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.y = 0.01;
    this.scene.add(this.stand, this.ring, this.pivot);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.loadCar(carId);
  }

  setCar(carId: string): void {
    if (carId === this.carId) return;
    this.loadCar(carId);
  }

  show(): void {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  hide(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.hide();
    this.observer.disconnect();
    this.disposeCar();
    this.stand.geometry.dispose();
    (this.stand.material as THREE.Material).dispose();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    for (const l of this.lights) l.dispose();
    this.scene.clear();
    this.renderer.domElement.remove();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private loadCar(carId: string): void {
    const def = getCarDef(carId);
    this.disposeCar();
    this.carId = carId;

    const car = this.assets.cloneModel(def.file);
    hideCarDecals(car);
    const paint = new THREE.Color(def.paint);
    const states: MaterialState[] = [];
    car.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m instanceof THREE.MeshStandardMaterial && m.name === 'Underglow') m.emissive.copy(paint);
        states.push({ mat: m, baseOpacity: m.opacity, baseTransparent: m.transparent });
      }
    });

    // Centre on the turntable axis with the wheels on the stand.
    const box = new THREE.Box3().setFromObject(car);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    car.position.set(-centre.x, -box.min.y, -centre.z);
    this.pivot.add(car);

    this.car = car;
    this.states = states;
    this.radius = 0.5 * Math.hypot(size.x, size.z);
    this.height = size.y;
    this.ringMat.emissive.copy(paint);
    this.fitView();

    // Fade / scale in.
    this.appear = 0;
    this.fading = true;
    for (const s of this.states) {
      s.mat.transparent = true;
      s.mat.opacity = 0;
    }
    this.pivot.scale.setScalar(0.85);
    if (this.running) return;
    this.renderOnce();
  }

  private disposeCar(): void {
    if (!this.car) return;
    for (const s of this.states) s.mat.dispose(); // geometry + textures belong to Assets
    this.pivot.remove(this.car);
    this.car = null;
    this.states = [];
  }

  /** Scale the stand to the car and place the camera so the whole turntable circle fits. */
  private fitView(): void {
    const r = this.radius;
    this.stand.scale.set(r * 1.25, 1, r * 1.25);
    this.ring.scale.setScalar(r * 1.12);

    const t = Math.tan((FOV * Math.PI) / 360);
    const fitW = (r * 1.4) / (t * this.aspect);
    const fitH = (this.height * 0.6 + r * 0.36) / t;
    const dist = Math.max(fitW, fitH) + r * 0.3;
    this.camera.position.set(0, this.height * 1.05 + r * 0.25, dist);
    this.lookAt.set(0, this.height * 0.35, 0);
    this.camera.lookAt(this.lookAt);
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.aspect = w / h;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.fitView();
    if (!this.running) this.renderOnce();
  }

  private renderOnce(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(MAX_DT, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.spin += SPIN_RAD_PER_SEC * dt;
    this.pivot.rotation.y = this.spin;
    this.pivot.rotation.x = Math.sin(this.time * SWAY_HZ * Math.PI * 2) * SWAY_RAD;

    if (this.fading) {
      this.appear = Math.min(1, this.appear + dt / APPEAR_SEC);
      const e = 1 - (1 - this.appear) * (1 - this.appear); // ease-out
      this.pivot.scale.setScalar(0.85 + 0.15 * e);
      const done = this.appear >= 1;
      for (const s of this.states) {
        s.mat.opacity = s.baseOpacity * e;
        if (done) {
          s.mat.transparent = s.baseTransparent;
          s.mat.opacity = s.baseOpacity;
          s.mat.needsUpdate = true;
        }
      }
      if (done) this.fading = false;
    }
    this.renderOnce();
  };
}

export function makeShowroomFactory(assets: Assets): PreviewFactory {
  return (container, carId) => new Showroom(container, assets, carId);
}
