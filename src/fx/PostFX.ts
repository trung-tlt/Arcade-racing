import { lightingScale } from '../world/Lighting';
import * as THREE from 'three';
import { LIGHTING, type TrackDef } from '../core/Data';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export class PostFX {
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private overlay: RenderPass | null = null;
  private readonly baseExposure: number;
  private readonly baseBloom: number;
  /** Draw calls of the scene render (shadow map + main pass), excluding the full-screen post passes. */
  sceneCalls = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    track: TrackDef,
  ) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.baseExposure =
      (track.daylight?.toneMappingExposure ?? LIGHTING.exposure) * lightingScale(track.timeOfDay).exposureMul;
    renderer.toneMappingExposure = this.baseExposure;
    this.composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    const baseRender = renderPass.render.bind(renderPass);
    renderPass.render = (...args: Parameters<RenderPass['render']>): void => {
      const before = renderer.info.render.calls;
      baseRender(...args);
      this.sceneCalls = renderer.info.render.calls - before;
    };
    this.composer.addPass(renderPass);
    const size = renderer.getSize(new THREE.Vector2());
    this.bloom = new UnrealBloomPass(
      size,
      track.daylight?.bloom.strength ?? 0.8,
      0.4,
      track.daylight?.bloom.threshold ?? 0.6,
    );
    this.baseBloom = this.bloom.strength;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  /**
   * A second scene drawn over the first with a cleared depth buffer and before bloom: the driver's cockpit, so it never
   * clips walls and still glows. `null` removes it.
   */
  setOverlay(scene: THREE.Scene | null, camera: THREE.PerspectiveCamera | null): void {
    if (this.overlay) {
      this.composer.removePass(this.overlay);
      this.overlay.dispose();
      this.overlay = null;
    }
    if (!scene || !camera) return;
    const pass = new RenderPass(scene, camera);
    pass.clear = false;
    pass.clearDepth = true;
    pass.enabled = false;
    this.composer.insertPass(pass, 1);
    this.overlay = pass;
  }

  setOverlayVisible(on: boolean): void {
    if (this.overlay) this.overlay.enabled = on;
  }

  setSize(w: number, h: number): void {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  /** Scales the map's exposure (Map 5's tunnel is -1.5 EV). 1 = normal. */
  setExposureMul(k: number): void {
    this.renderer.toneMappingExposure = this.baseExposure * k;
  }

  /** Adds to the bloom strength for a moment (Map 5's tunnel-exit flare). 0 = normal. */
  setBloomBoost(v: number): void {
    this.bloom.strength = this.baseBloom + v;
  }

  setBloom(on: boolean): void {
    this.bloom.enabled = on;
  }

  dispose(): void {
    this.composer.passes.forEach((p) => p.dispose());
    this.composer.dispose();
  }
}
