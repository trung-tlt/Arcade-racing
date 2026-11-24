import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { LIGHTING, type TrackDef } from '../core/Data';

/** Pack lighting numbers read dark in this renderer; data/lighting.json scales them per time of day. */
export function lightingScale(tod: TrackDef['timeOfDay']): {
  hemiMul: number;
  sunMul: number;
  exposureMul: number;
  fogMul: number;
  /** Ground colour of a map whose land is not the default day grey. */
  landColor?: string;
} {
  if (tod === 'dusk') return LIGHTING.dusk;
  if (tod === 'storm') return LIGHTING.storm;
  return { hemiMul: 1, sunMul: 1, exposureMul: 1, fogMul: 1 };
}

const NIGHT_OFFSET = new THREE.Vector3(-40, 80, -30);

export class Lighting {
  private readonly hemi: THREE.HemisphereLight;
  private readonly moon: THREE.DirectionalLight;

  private readonly baseHemi: number;
  private readonly offset = NIGHT_OFFSET.clone();
  private readonly shadowHalf: number;

  /** Night maps use data/lighting.json (moon); day maps use the track's own `dressing.lighting` (sun, sky, haze). */
  constructor(
    private readonly scene: THREE.Scene,
    track: TrackDef,
    assets: Assets,
  ) {
    const day = track.daylight;
    const k = lightingScale(track.timeOfDay);
    if (day) {
      const sky = assets.texture(day.sky);
      scene.background = sky;
      scene.fog = new THREE.FogExp2(day.fog.color, day.fog.density);
      scene.fog.color.multiplyScalar(k.fogMul); // a storm's haze is darker than the pack's grey reads here
      this.offset.set(-day.sun.dir[0], -day.sun.dir[1], -day.sun.dir[2]).normalize().multiplyScalar(110);
      this.shadowHalf = 70;
    } else {
      scene.background = new THREE.Color('#0E1116');
      scene.fog = new THREE.FogExp2('#0E1116', 0.006);
      this.shadowHalf = 60;
    }

    // The pack's dusk numbers read dark in this renderer; data/lighting.json scales them to the design render.
    this.hemi = day
      ? new THREE.HemisphereLight(day.hemi.sky, day.hemi.ground, day.hemi.intensity * k.hemiMul)
      : new THREE.HemisphereLight(LIGHTING.hemi.sky, LIGHTING.hemi.ground, LIGHTING.hemi.intensity);
    this.baseHemi = this.hemi.intensity;
    this.moon = day
      ? new THREE.DirectionalLight(day.sun.color, day.sun.intensity * k.sunMul)
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
    // Follow the car's height too: on a hill (Map 6 climbs 100 m) a light fixed near y = 0 would sit under the road.
    const y = target.y;
    this.moon.target.position.set(x, y, z);
    this.moon.position.set(x + this.offset.x, y + this.offset.y, z + this.offset.z);
  }

  /** Transient flash (lightning): hemisphere intensity = base × (1 + boost). 0 restores the normal level. */
  setHemiBoost(boost: number): void {
    this.hemi.intensity = this.baseHemi * (1 + boost);
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
