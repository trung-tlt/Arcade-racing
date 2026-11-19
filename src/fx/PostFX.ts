import * as THREE from 'three';
import { LIGHTING, type TrackDef } from '../core/Data';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export class PostFX {
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  /** Draw calls of the scene render (shadow map + main pass), excluding the full-screen post passes. */
  sceneCalls = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    track: TrackDef,
  ) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure =
      (track.daylight?.toneMappingExposure ?? LIGHTING.exposure) *
      (track.timeOfDay === 'dusk' ? LIGHTING.dusk.exposureMul : 1);
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
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  setSize(w: number, h: number): void {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  setBloom(on: boolean): void {
    this.bloom.enabled = on;
  }

  dispose(): void {
    this.composer.passes.forEach((p) => p.dispose());
    this.composer.dispose();
  }
}
