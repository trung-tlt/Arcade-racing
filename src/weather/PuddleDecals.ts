import * as THREE from 'three';
import type { WeatherDef } from '../core/Data';
import { WEATHER_FX } from './config';
import type { PuddleSpot } from './puddleSpots';

/** All puddles as flat decals on the road surface, merged into one mesh (one draw call). */
export class PuddleDecals {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene, tex: THREE.Texture, def: WeatherDef['puddles'], spots: readonly PuddleSpot[]) {
    const fx = WEATHER_FX.puddle;
    const n = spots.length;
    const pos = new Float32Array(n * 4 * 3);
    const uv = new Float32Array(n * 4 * 2);
    const idx: number[] = [];
    const corners = [
      [-1, -1, 0, 0],
      [1, -1, 1, 0],
      [1, 1, 1, 1],
      [-1, 1, 0, 1],
    ];
    spots.forEach((s, i) => {
      const half = s.radiusM * fx.decalScale;
      // Road-following axes: forward climbs with the pitch, left is horizontal; each puddle is turned by a fixed
      // pseudo-random angle so the repeated blob does not look stamped.
      const cp = Math.cos(s.pitch);
      const fwd = [s.tx * cp, Math.sin(s.pitch), s.tz * cp];
      const left = [s.tz, 0, -s.tx];
      const a = (i * 2.399963) % (Math.PI * 2);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (let c = 0; c < 4; c++) {
        const [u, v, tu, tv] = corners[c];
        const k = (i * 4 + c) * 3;
        for (let d = 0; d < 3; d++) {
          const f = ca * fwd[d] + sa * left[d];
          const l = -sa * fwd[d] + ca * left[d];
          const base = d === 0 ? s.x : d === 1 ? s.y + fx.liftM : s.z;
          pos[k + d] = base + (f * v + l * u) * half;
        }
        uv[(i * 4 + c) * 2] = tu;
        uv[(i * 4 + c) * 2 + 1] = tv;
      }
      const b = i * 4;
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      roughness: def.material.roughness,
      metalness: def.material.metalness,
      polygonOffset: true,
      polygonOffsetFactor: def.material.polygonOffset,
      polygonOffsetUnits: def.material.polygonOffset,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'puddles';
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);
  }

  setEnvMap(env: THREE.Texture | null, intensity: number): void {
    this.mat.envMap = env;
    this.mat.envMapIntensity = intensity;
    this.mat.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
