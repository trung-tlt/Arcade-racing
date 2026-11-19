import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { AudioBus } from '../audio/AudioBus';
import type { Assets } from '../core/Assets';
import { AUDIO, RACE, type TrackDef, type WeatherDef } from '../core/Data';
import { userSettings } from '../core/Settings';
import { touchInput } from '../core/TouchInput';
import type { Car } from '../vehicle/Car';
import type { Lighting } from '../world/Lighting';
import type { TrackPath } from '../world/TrackPath';
import { WEATHER_FX } from './config';
import { coversFromTrack } from './cover';
import { inFlood } from './flood';
import { FloodWater } from './FloodWater';
import { rearAnchor, rotateByQuat } from './geom';
import { composeSurface } from './grip';
import { LightningFx } from './LightningFx';
import { PuddleDecals } from './PuddleDecals';
import { PuddleTracker, puddleSpots } from './puddleSpots';
import { Rain } from './Rain';
import { rainIntensityAt, rainParticleCount } from './rainConfig';
import { SplashPool } from './SplashPool';
import { WeatherAudio } from './WeatherAudio';

/** Every file the storm needs, for the loaders in main.ts / Sfx.ts (also listed in the Map 4 asset lists). */
export const WEATHER_TEXTURES: string[] = [
  'textures/fx_rain_streaks.png',
  'textures/fx_splash.png',
  'textures/fx_lightning.png',
  'textures/pvd_puddle.png',
];
export const WEATHER_SFX: string[] = [
  AUDIO.weather.rainLoop.file,
  AUDIO.weather.thunder.file,
  AUDIO.weather.splash.file,
];

export interface WeatherDeps {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.Camera;
  assets: Assets;
  /** A track with a `weather` block. */
  track: TrackDef;
  path: TrackPath;
  /** `track.roadMaterials` (Track.ts): the wet road gets its reflection map from here. */
  roadMaterials: readonly THREE.MeshStandardMaterial[];
  /** Null = silent (tests, or audio not loaded). */
  audio: AudioBus | null;
  lighting: Lighting;
  /** Player, rivals and dummies: all feel the wet road, puddles and flood. */
  getCars: () => readonly Car[];
}

interface Scratch {
  x: number;
  y: number;
  z: number;
}

/**
 * Map 4's monsoon storm: rain, the wet road look, puddles (grip + splash), the flooded dip, tyre spray, lightning with
 * thunder, and the rain ambience. Gameplay multipliers go into every car's `CarPhysics` each fixed step.
 */
export class WeatherSystem {
  private readonly def: WeatherDef;
  private readonly rain: Rain;
  private readonly splash: SplashPool;
  private readonly puddles: PuddleDecals;
  private readonly flood: FloodWater;
  private readonly lightning: LightningFx;
  private readonly sound: WeatherAudio;
  private readonly tracker: PuddleTracker;
  private readonly envTex: THREE.Texture;
  private readonly reduced: boolean;
  private intensity: number;
  private readonly carT = new Map<string, number>();
  private readonly sprayAcc = new Map<string, number>();
  private readonly lat = { x: 0, y: 0, z: 0 } as Scratch;
  private readonly fwd = { x: 0, y: 0, z: 0 } as Scratch;
  private readonly cam = new THREE.Vector3();
  private readonly size = new THREE.Vector2();

  constructor(private readonly deps: WeatherDeps) {
    const { track, assets, scene } = deps;
    if (!track.weather) throw new Error(`${track.id} has no weather block`);
    this.def = track.weather;
    const def = this.def;
    this.reduced = userSettings.preset === 'low' || touchInput.enabled;
    this.intensity = rainIntensityAt(def, 0);

    // Dim studio reflections so lamps and car lights streak on the wet tarmac.
    const pmrem = new THREE.PMREMGenerator(deps.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    for (const m of deps.roadMaterials) {
      m.envMap = this.envTex;
      m.envMapIntensity = WEATHER_FX.envMapIntensity;
      m.needsUpdate = true;
    }

    this.rain = new Rain(
      scene,
      assets.texture(def.rain.particles.texture),
      def.rain,
      rainParticleCount(def, this.reduced),
    );
    this.splash = new SplashPool(scene, assets.texture(def.spray.texture), WEATHER_FX.spray.poolSize);
    const spots = puddleSpots(def, deps.path, RACE.track.roadY);
    this.puddles = new PuddleDecals(scene, assets.texture(def.puddles.decal), def.puddles, spots);
    this.puddles.setEnvMap(this.envTex, WEATHER_FX.envMapIntensity);
    this.flood = new FloodWater(scene, track, deps.path);
    this.flood.setEnvMap(this.envTex, WEATHER_FX.envMapIntensity);
    this.tracker = new PuddleTracker(spots, WEATHER_FX.puddle);

    const W = AUDIO.weather;
    this.sound = new WeatherAudio(
      deps.audio,
      coversFromTrack(track.raw, W.overpassHalfXM, W.overpassHalfZM, W.overpassDeckHeightM),
      def.audio.underBridgeMute,
      def.audio.volumeFromIntensity,
    );
    this.lightning = new LightningFx(scene, assets.texture(WEATHER_TEXTURES[2]), deps.lighting, def.lightning, () =>
      this.sound.thunder(),
    );
  }

  /** The current rain intensity 0..1 (eases between laps). */
  get rainIntensity(): number {
    return this.intensity;
  }

  /**
   * One fixed step. Call it BEFORE the cars' `preStep` so the grip multipliers are in place. `lap` is 0-based
   * (the first lap is 0); the camera position is read from `deps.camera`.
   */
  update(dt: number, lap: number): void {
    const { camera, path, getCars } = this.deps;
    const def = this.def;
    camera.getWorldPosition(this.cam);
    const target = rainIntensityAt(def, lap);
    const fade = AUDIO.weather.rainFadePerSec * 0.25 * dt;
    this.intensity += Math.max(-fade, Math.min(fade, target - this.intensity));

    const cars = getCars();
    for (const c of cars) this.updateCar(c, dt, path);

    this.rain.update(dt, this.cam, this.intensity);
    this.lightning.update(dt, this.cam, camera);
    this.splash.update(dt, this.pixelsPerUnit());
    const listener = cars[0]?.physics.curr.p ?? this.cam;
    this.sound.update(this.intensity, listener.x, listener.y, listener.z);
  }

  /** Trigger a lightning strike now (tests and screenshots): flash, bolt, then thunder. */
  forceStrike(): void {
    this.lightning.strike({ thunderDelaySec: 0.8, azimuthDeg: 0, distanceK: 0.3 }, this.cam, this.deps.camera);
  }

  /** Where the puddles are (tests): world x, z and radius. */
  debugPuddles(): { x: number; z: number; r: number }[] {
    return this.tracker.spotList().map((s) => ({ x: s.x, z: s.z, r: s.radiusM }));
  }

  /** Current surface multipliers of a car (tests). */
  debugSurface(carId: string): { grip: number; drag: number; brake: number; puddle: boolean } | null {
    const c = this.deps.getCars().find((x) => x.id === carId);
    if (!c) return null;
    return {
      grip: c.physics.surfaceGripMul,
      drag: c.physics.dragMul,
      brake: c.physics.brakeDistanceMul,
      puddle: this.tracker.gripActive(carId),
    };
  }

  private pixelsPerUnit(): number {
    const cam = this.deps.camera;
    this.deps.renderer.getDrawingBufferSize(this.size);
    const fov = cam instanceof THREE.PerspectiveCamera ? cam.fov : 60;
    return this.size.y / (2 * Math.tan((fov * Math.PI) / 360));
  }

  private updateCar(c: Car, dt: number, path: TrackPath): void {
    const ph = c.physics;
    const p = ph.curr.p;
    const t = this.alongTrack(path, c.id, p.x, p.z);
    const speed = ph.speedMps;

    const entered = this.tracker.update(c.id, p.x, p.z, dt);
    const flooded = inFlood(this.def, t, p.y, WEATHER_FX.flood.depthTestMarginM);
    const m = composeSurface(this.def, this.tracker.gripActive(c.id), flooded);
    ph.surfaceGripMul = m.grip;
    ph.brakeDistanceMul = m.brakeDistance;
    ph.dragMul = m.drag;

    if (entered && speed > WEATHER_FX.puddle.splashMinSpeedMps) {
      const k = (Math.random() * 2 - 1) * ((WEATHER_FX.puddle.yawKickDegS * Math.PI) / 180);
      ph.addYawKick(k);
      this.burst(p.x, entered.y, p.z, speed, WEATHER_FX.puddle.burstParticles, 1);
      const range = AUDIO.weather.splashRangeM;
      const d = Math.hypot(p.x - this.cam.x, p.y - this.cam.y, p.z - this.cam.z);
      this.sound.splash(Math.max(0, 1 - d / range));
    }

    if (speed < 2 || c.hull.wrecked) return;
    const sp = WEATHER_FX.spray;
    const from = this.def.spray.fromRearWheelsAboveKmh / 3.6;
    if (flooded) {
      this.emitRate(
        c.id,
        dt,
        WEATHER_FX.flood.bowWaveParticlesPerSec * Math.min(1, speed / 20) * (this.reduced ? 0.5 : 1),
        () => this.bowWave(c, speed),
      );
    } else if (!this.reduced && speed > from) {
      const top = sp.topSpeedKmh / 3.6;
      const k = Math.min(1, Math.max(0.15, (speed - from) / Math.max(1, top - from)));
      this.emitRate(c.id, dt, sp.particlesPerSecAtTop * k, () => this.spray(c, speed));
    }
  }

  /**
   * Along-track t of a car: a windowed search around its last t, redone over the whole lap after a jump (respawn,
   * reset, teleport) when the windowed answer is nowhere near the car.
   */
  private alongTrack(path: TrackPath, id: string, x: number, z: number): number {
    let t = path.project(x, z, this.carT.get(id));
    const i = Math.floor((t - Math.floor(t)) * path.count) % path.count;
    const dx = x - path.px[i];
    const dz = z - path.pz[i];
    if (dx * dx + dz * dz > 400) t = path.project(x, z);
    this.carT.set(id, t);
    return t;
  }

  /** Accumulate fractional emissions per car so any frame rate gives the same rate. */
  private emitRate(id: string, dt: number, perSec: number, emit: () => void): void {
    let acc = (this.sprayAcc.get(id) ?? 0) + perSec * dt;
    while (acc >= 1) {
      emit();
      acc -= 1;
    }
    this.sprayAcc.set(id, acc);
  }

  private burst(x: number, y: number, z: number, speed: number, n: number, scale: number): void {
    const sp = WEATHER_FX.spray;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (1.5 + Math.random() * 3) * scale;
      this.splash.emit(
        x + Math.cos(a) * 0.6,
        y + 0.15,
        z + Math.sin(a) * 0.6,
        Math.cos(a) * v,
        1.5 + Math.random() * 2.5 + speed * 0.03,
        Math.sin(a) * v,
        0.6 + Math.random() * 0.5,
        sp.sizeM[0] * 1.2 * scale,
        sp.sizeM[1] * 1.4 * scale,
        sp.alpha,
      );
    }
  }

  /** Tyre spray: a sprite behind a random rear wheel, drifting back and up. */
  private spray(c: Car, speed: number): void {
    const sp = WEATHER_FX.spray;
    const q = c.physics.curr.q;
    const a = rearAnchor(c.physics.wheelLayout);
    const side = Math.random() < 0.5 ? -1 : 1;
    rotateByQuat(q, a.halfTrack * side, a.y + 0.05, a.z - sp.rearOffsetM, this.lat);
    rotateByQuat(
      q,
      (Math.random() - 0.5) * 0.8,
      sp.riseMps * (0.6 + Math.random()),
      -sp.backMps * (0.6 + Math.random() * 0.8),
      this.fwd,
    );
    const p = c.physics.curr.p;
    this.splash.emit(
      p.x + this.lat.x,
      p.y + this.lat.y,
      p.z + this.lat.z,
      this.fwd.x,
      this.fwd.y,
      this.fwd.z,
      sp.lifeSec * (0.7 + Math.random() * 0.6),
      sp.sizeM[0],
      sp.sizeM[0] + (sp.sizeM[1] - sp.sizeM[0]) * Math.min(1, speed / 60),
      sp.alpha,
    );
  }

  /** The flood's bow wave: big sprites thrown out to both sides ahead of the car. */
  private bowWave(c: Car, speed: number): void {
    const sp = WEATHER_FX.spray;
    const q = c.physics.curr.q;
    const side = Math.random() < 0.5 ? -1 : 1;
    rotateByQuat(q, 1.1 * side, 0.1, 1.9, this.lat);
    rotateByQuat(
      q,
      side * (2 + Math.random() * 2.5),
      2 + Math.random() * 2.5 + speed * 0.05,
      1 + Math.random(),
      this.fwd,
    );
    const p = c.physics.curr.p;
    this.splash.emit(
      p.x + this.lat.x,
      this.def.flood.waterY + 0.15,
      p.z + this.lat.z,
      this.fwd.x,
      this.fwd.y,
      this.fwd.z,
      0.8 + Math.random() * 0.5,
      sp.sizeM[0] * 1.6,
      sp.sizeM[1] * 2,
      sp.alpha + 0.1,
    );
  }

  dispose(): void {
    for (const c of this.deps.getCars()) {
      c.physics.surfaceGripMul = 1;
      c.physics.brakeDistanceMul = 1;
      c.physics.dragMul = 1;
    }
    for (const m of this.deps.roadMaterials) {
      m.envMap = null;
      m.needsUpdate = true;
    }
    this.rain.dispose();
    this.splash.dispose();
    this.puddles.dispose();
    this.flood.dispose();
    this.lightning.dispose();
    this.sound.dispose();
    this.envTex.dispose();
  }
}
