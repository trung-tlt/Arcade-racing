import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { CARS, LIGHTING, type CarDef } from '../core/Data';

export interface CarThumbs {
  /** Data URL of the vehicle's picture, rendered on first request ('' if rendering is impossible). */
  get(carId: string): string;
  /** Free the GL context early (it is also freed automatically once every car has been rendered). */
  dispose(): void;
}

const WIDTH = 320;
const HEIGHT = 200;
const FOV = 28;
const MARGIN = 0.88;
/** Camera direction from the car's centre: front three-quarter, slightly above. */
const VIEW_DIR = new THREE.Vector3(0.72, 0.38, 0.9).normalize();

/** Relative luminance (0..1) of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

export interface CardColors {
  bg: string;
  fg: string;
  border: string;
}

/**
 * Colours of the SELECTED card: filled with the vehicle's paint, dark text on light paints, light text on mid paints.
 * Near-black paints (the police car) would vanish against the dark screen, so they get a steel fill + light outline.
 */
export function selectedCardColors(paint: string): CardColors {
  const l = luminance(paint);
  if (l < 0.12) return { bg: '#2a3240', fg: '#e8ecf2', border: '#e8ecf2' };
  return { bg: paint, fg: l > 0.45 ? '#0e1116' : '#ffffff', border: paint };
}

/**
 * Distance from `centre` along `dir` (unit, pointing towards the camera) at which a perspective camera with the given
 * vertical FOV (degrees) and aspect sees every point in `points`, times `margin`.
 */
export function fitDistance(
  points: readonly THREE.Vector3[],
  centre: THREE.Vector3,
  dir: THREE.Vector3,
  vfovDeg: number,
  aspect: number,
  margin = 1,
): number {
  const tanV = Math.tan((vfovDeg * Math.PI) / 360);
  const tanH = tanV * aspect;
  // Camera basis: forward looks at the centre (-dir); right/up span the image plane.
  const fwd = dir.clone().multiplyScalar(-1);
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  let dist = 0;
  const rel = new THREE.Vector3();
  for (const p of points) {
    rel.copy(p).sub(centre);
    const x = rel.dot(right);
    const y = rel.dot(up);
    const z = rel.dot(fwd); // positive = further from the camera than the centre
    // The point is at depth (dist + z) and must satisfy |x| <= tanH * depth, |y| <= tanV * depth.
    dist = Math.max(dist, Math.abs(x) / tanH - z, Math.abs(y) / tanV - z);
  }
  return Math.max(dist, 0.01) * margin;
}

function boxCorners(box: THREE.Box3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) out.push(new THREE.Vector3(x, y, z));
  return out;
}

/** Soft contact shadow so the car doesn't float on the transparent background. */
function shadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/**
 * Renders each vehicle's real GLB into a small transparent PNG (one frame, lazily, cached). One offscreen WebGL
 * context is created on first use and released as soon as every vehicle has been rendered (or on dispose()).
 */
export function makeThumbnailRenderer(assets: Assets): CarThumbs {
  const cache = new Map<string, string>();
  let gl: {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    shadow: THREE.Mesh;
    shadowTex: THREE.CanvasTexture;
    lights: THREE.Light[];
  } | null = null;

  const release = (): void => {
    if (!gl) return;
    gl.shadow.geometry.dispose();
    (gl.shadow.material as THREE.Material).dispose();
    gl.shadowTex.dispose();
    for (const l of gl.lights) l.dispose();
    gl.scene.clear();
    gl.renderer.dispose();
    gl.renderer.forceContextLoss();
    gl = null;
  };

  const init = (): NonNullable<typeof gl> | null => {
    try {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(WIDTH, HEIGHT, false);
      renderer.setClearColor(0x000000, 0);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = LIGHTING.exposure;
      const scene = new THREE.Scene();
      // Same rig as the live showroom: sky fill, white key front-right, neon rim, orange kicker.
      const hemi = new THREE.HemisphereLight('#7F9CD8', '#0E1116', 2.4);
      const key = new THREE.DirectionalLight('#FFFFFF', 4.2);
      key.position.set(5, 7, 6);
      const rim = new THREE.DirectionalLight('#2EC5FF', 5);
      rim.position.set(-6, 3, -5);
      const kicker = new THREE.DirectionalLight('#FF6A1A', 1.6);
      kicker.position.set(6, 1.5, -4);
      scene.add(hemi, key, rim, kicker);
      const shadowTex = shadowTexture();
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
      );
      shadow.rotation.x = -Math.PI / 2;
      scene.add(shadow);
      return {
        renderer,
        scene,
        camera: new THREE.PerspectiveCamera(FOV, WIDTH / HEIGHT, 0.1, 100),
        shadow,
        shadowTex,
        lights: [hemi, key, rim, kicker],
      };
    } catch {
      return null;
    }
  };

  const render = (def: CarDef): string => {
    gl ??= init();
    if (!gl) return '';
    const { renderer, scene, camera, shadow } = gl;
    const car = assets.cloneModel(def.file);
    const paint = new THREE.Color(def.paint);
    car.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m instanceof THREE.MeshStandardMaterial && m.name === 'Underglow') m.emissive.copy(paint);
      }
    });
    // Wheels on y = 0, centred on x/z.
    const box = new THREE.Box3().setFromObject(car);
    const c0 = box.getCenter(new THREE.Vector3());
    car.position.set(-c0.x, -box.min.y, -c0.z);
    scene.add(car);
    const fitted = new THREE.Box3().setFromObject(car);
    const centre = fitted.getCenter(new THREE.Vector3());
    const size = fitted.getSize(new THREE.Vector3());
    const dist = fitDistance(boxCorners(fitted), centre, VIEW_DIR, FOV, WIDTH / HEIGHT, MARGIN);
    camera.position.copy(centre).addScaledVector(VIEW_DIR, dist);
    camera.lookAt(centre);
    shadow.scale.set(size.x * 1.7, size.z * 1.35, 1);
    shadow.position.set(0, 0.01, 0);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    scene.remove(car);
    car.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose(); // geometry belongs to Assets
    });
    return url;
  };

  return {
    get(carId: string): string {
      const hit = cache.get(carId);
      if (hit !== undefined) return hit;
      const def = CARS.find((c) => c.id === carId);
      if (!def) return '';
      const url = render(def);
      cache.set(carId, url);
      if (cache.size >= CARS.length) release();
      return url;
    },
    dispose: release,
  };
}
