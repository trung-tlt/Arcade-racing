import * as THREE from 'three';
import type { TrackDef } from '../core/Data';
import { roadWidthAt } from '../core/Data';
import type { TrackPath } from '../world/TrackPath';
import { WEATHER_FX } from './config';

/** The standing water in the dip: a flat strip at `flood.waterY` following the road across the flooded stretch. */
export class FloodWater {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene, track: TrackDef, path: TrackPath) {
    const def = track.weather;
    if (!def) throw new Error('FloodWater needs a track with weather');
    const fl = def.flood;
    const fx = WEATHER_FX.flood;
    const pad = fx.planeMarginM / path.lengthM;
    const t0 = fl.fromT - pad;
    const t1 = fl.toT + pad;
    const rows = Math.max(2, Math.ceil(((t1 - t0) * path.lengthM) / 4));
    const pos = new Float32Array((rows + 1) * 2 * 3);
    const idx: number[] = [];
    for (let r = 0; r <= rows; r++) {
      const t = t0 + ((t1 - t0) * r) / rows;
      const p = path.pointAt(t);
      const tg = path.tangentAt(t);
      const h = Math.hypot(tg.x, tg.z) || 1;
      const lx = tg.z / h;
      const lz = -tg.x / h;
      const half = roadWidthAt(track, t) / 2 + 3;
      for (let s = 0; s < 2; s++) {
        const k = (r * 2 + s) * 3;
        const side = s === 0 ? 1 : -1;
        pos[k] = p.x + lx * half * side;
        pos[k + 1] = fl.waterY + fx.surfaceLiftM;
        pos[k + 2] = p.z + lz * half * side;
      }
      if (r < rows) {
        const a = r * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.mat = new THREE.MeshStandardMaterial({
      color: fl.waterColor,
      roughness: 0.08,
      metalness: 0.3,
      transparent: true,
      opacity: fx.waterAlpha,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'flood_water';
    this.mesh.renderOrder = 3;
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
