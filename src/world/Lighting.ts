import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { LIGHTING, type TrackDef } from '../core/Data';

const NIGHT_OFFSET = new THREE.Vector3(-40, 80, -30);

export class Lighting {
  private readonly hemi: THREE.HemisphereLight;
  private readonly moon: THREE.DirectionalLight;

  private readonly offset = NIGHT_OFFSET.clone();
  private readonly shadowHalf: number;

  /** Night maps use data/lighting.json (moon); day maps use the track's own `dressing.lighting` (sun, sky, haze). */
  constructor(
    private readonly scene: THREE.Scene,
    track: TrackDef,
    assets: Assets,
  ) {
    const day = track.daylight;
    if (day) {
      const sky = assets.texture(day.sky);
      scene.background = sky;
      scene.fog = new THREE.FogExp2(day.fog.color, day.fog.density);
      this.offset.set(-day.sun.dir[0], -day.sun.dir[1], -day.sun.dir[2]).normalize().multiplyScalar(110);
      this.shadowHalf = 70;
    } else {
      scene.background = new THREE.Color('#0E1116');
      scene.fog = new THREE.FogExp2('#0E1116', 0.006);
      this.shadowHalf = 60;
    }

    this.hemi = day
      ? new THREE.HemisphereLight(day.hemi.sky, day.hemi.ground, day.hemi.intensity)
      : new THREE.HemisphereLight(LIGHTING.hemi.sky, LIGHTING.hemi.ground, LIGHTING.hemi.intensity);
    this.moon = day
      ? new THREE.DirectionalLight(day.sun.color, day.sun.intensity)
      : new THREE.DirectionalLight(LIGHTING.moon.color, LIGHTING.moon.intensity);
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(2048, 2048);
    const cam = this.moon.shadow.camera;
    cam.left = -this.shadowHalf;
    cam.right = this.shadowHalf;
    cam.top = this.shadowHalf;
    cam.bottom = -this.shadowHalf;
    cam.near = 1;
    cam.far = 300;
    this.moon.shadow.bias = -0.0005;
    this.moon.shadow.normalBias = 0.05;
    scene.add(this.hemi, this.moon, this.moon.target);
  }

  update(target: THREE.Vector3): void {
    // Snap to the shadow texel grid so shadows don't shimmer while following.
    const texel = (this.shadowHalf * 2) / 2048;
    const x = Math.round(target.x / texel) * texel;
    const z = Math.round(target.z / texel) * texel;
    this.moon.target.position.set(x, 0, z);
    this.moon.position.set(x + this.offset.x, this.offset.y, z + this.offset.z);
  }

  setShadows(on: boolean): void {
    this.moon.castShadow = on;
  }

  dispose(): void {
    this.moon.shadow.map?.dispose();
    this.scene.remove(this.hemi, this.moon, this.moon.target);
    this.hemi.dispose();
    this.moon.dispose();
  }
}
