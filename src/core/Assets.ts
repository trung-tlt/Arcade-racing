import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const BASE = '/assets/';

export class Assets {
  private constructor(
    private readonly models: Map<string, THREE.Group>,
    private readonly textures: Map<string, THREE.Texture>,
  ) {}

  static async load(
    paths: { models: string[]; textures: string[] },
    onProgress: (fraction: number) => void,
  ): Promise<Assets> {
    const total = paths.models.length + paths.textures.length;
    let done = 0;
    const tick = (): void => onProgress(total === 0 ? 1 : ++done / total);
    const gltf = new GLTFLoader();
    const texLoader = new THREE.TextureLoader();
    const models = new Map<string, THREE.Group>();
    const textures = new Map<string, THREE.Texture>();

    await Promise.all([
      ...paths.models.map(async (p) => {
        const g = await gltf.loadAsync(BASE + p);
        models.set(p, g.scene);
        tick();
      }),
      ...paths.textures.map(async (p) => {
        const t = await texLoader.loadAsync(BASE + p);
        t.colorSpace = THREE.SRGBColorSpace;
        textures.set(p, t);
        tick();
      }),
    ]);
    return new Assets(models, textures);
  }

  /** Deep clone; geometry is shared, materials are cloned per call. */
  cloneModel(path: string): THREE.Group {
    const src = this.models.get(path);
    if (!src) throw new Error(`Model not loaded: ${path}`);
    const copy = src.clone(true) as THREE.Group;
    copy.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
    });
    return copy;
  }

  texture(path: string): THREE.Texture {
    const t = this.textures.get(path);
    if (!t) throw new Error(`Texture not loaded: ${path}`);
    return t;
  }

  dispose(): void {
    for (const t of this.textures.values()) t.dispose();
    for (const m of this.models.values()) {
      m.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mat.dispose();
      });
    }
    this.models.clear();
    this.textures.clear();
  }
}
