import * as THREE from 'three';
import type { WeatherDef } from '../core/Data';
import type { Lighting } from '../world/Lighting';
import { WEATHER_FX } from './config';
import { flashLevel, LightningScheduler, type Strike } from './lightning';

/** Storm lightning: a double flash of the hemisphere light, a bolt sprite on the skyline, then thunder. */
export class LightningFx {
  private readonly scheduler: LightningScheduler;
  private readonly bolt: THREE.Mesh;
  private readonly boltMat: THREE.MeshBasicMaterial;
  private flashT = -1;
  private thunderIn = -1;
  private readonly fwd = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    tex: THREE.Texture,
    private readonly lighting: Lighting,
    private readonly cfg: WeatherDef['lightning'],
    private readonly onThunder: () => void,
    rng: () => number = Math.random,
  ) {
    const fx = WEATHER_FX.lightning;
    this.scheduler = new LightningScheduler(cfg, fx.sectorDeg, rng);
    this.boltMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      opacity: 0,
    });
    this.bolt = new THREE.Mesh(new THREE.PlaneGeometry(fx.boltHeightM * fx.boltAspect, fx.boltHeightM), this.boltMat);
    this.bolt.visible = false;
    this.bolt.renderOrder = 10;
    this.bolt.name = 'lightning_bolt';
    scene.add(this.bolt);
  }

  /** Force a strike now (also what the timer calls). */
  strike(s: Strike, camPos: THREE.Vector3, camera: THREE.Camera): void {
    const fx = WEATHER_FX.lightning;
    camera.getWorldDirection(this.fwd);
    const heading = Math.atan2(this.fwd.x, this.fwd.z) + (s.azimuthDeg * Math.PI) / 180;
    const [d0, d1] = fx.boltDistanceM;
    const dist = d0 + (d1 - d0) * s.distanceK;
    const x = camPos.x + Math.sin(heading) * dist;
    const z = camPos.z + Math.cos(heading) * dist;
    this.bolt.position.set(x, camPos.y + fx.boltHeightM * 0.4, z);
    this.bolt.rotation.y = Math.atan2(camPos.x - x, camPos.z - z);
    this.flashT = 0;
    this.thunderIn = s.thunderDelaySec;
  }

  get flashing(): boolean {
    return this.flashT >= 0;
  }

  update(dt: number, camPos: THREE.Vector3, camera: THREE.Camera): void {
    const next = this.scheduler.update(dt);
    if (next) this.strike(next, camPos, camera);
    if (this.flashT >= 0) {
      this.flashT += dt;
      const level = flashLevel(this.flashT, this.cfg.flash, WEATHER_FX.lightning.flashPattern);
      // The pack's hemiBoost (4) whites the screen out here; hemiBoostScale in weatherFx.json tames it.
      this.lighting.setHemiBoost(level * this.cfg.flash.hemiBoost * WEATHER_FX.lightning.hemiBoostScale);
      this.boltMat.opacity = level * WEATHER_FX.lightning.boltAlpha;
      this.bolt.visible = level > 0;
      if (this.flashT >= this.cfg.flash.durationSec) {
        this.flashT = -1;
        this.lighting.setHemiBoost(0);
        this.bolt.visible = false;
      }
    }
    if (this.thunderIn >= 0) {
      this.thunderIn -= dt;
      if (this.thunderIn < 0) this.onThunder();
    }
  }

  dispose(): void {
    this.lighting.setHemiBoost(0);
    this.bolt.removeFromParent();
    this.bolt.geometry.dispose();
    this.boltMat.dispose();
  }
}
