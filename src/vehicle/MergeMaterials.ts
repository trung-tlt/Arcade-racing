import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Materials that are changed at runtime (or glow) and must stay separate draws. */
const KEEP = new Set(['Light_Head', 'Light_Tail', 'Light_Siren_Red', 'Light_Siren_Blue', 'Underglow', 'Muzzle']);

type Bucket = 'metal' | 'matte';
const BUCKETS: Record<Bucket, { metalness: number; roughness: number }> = {
  metal: { metalness: 0.65, roughness: 0.3 },
  matte: { metalness: 0.1, roughness: 0.75 },
};

const sharedMats = new Map<Bucket, THREE.MeshStandardMaterial>();
/** Merged geometry per source geometry + bucket (+ livery), shared by every car of the same model and livery. */
const mergedGeos = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();
const colourScratch = new THREE.Color();

function sharedMaterial(b: Bucket): THREE.MeshStandardMaterial {
  let m = sharedMats.get(b);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, ...BUCKETS[b] });
    m.userData.shared = true;
    m.name = `Merged_${b}`;
    sharedMats.set(b, m);
  }
  return m;
}

const isStdMesh = (c: THREE.Object3D): c is THREE.Mesh & { material: THREE.MeshStandardMaterial } =>
  c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial;
const isKept = (m: THREE.MeshStandardMaterial): boolean =>
  KEEP.has(m.name) ||
  m.userData.keepSeparate === true ||
  !!m.map ||
  (m.emissiveIntensity > 0 && m.emissive.getHex() !== 0);

/**
 * Cuts a car's draw calls. GLTFLoader gives a multi-material part as a node with one child Mesh per material; here
 * every child that is not a dynamic light is baked into vertex colours and merged into one mesh per bucket
 * (metal / matte). `singleBucket(node)` (wheels) forces one material. Geometry is cached, so all cars of one model
 * share it; the two merged materials are shared too (flagged `userData.shared`, never disposed per car).
 */
export function mergeCarMaterials(
  root: THREE.Object3D,
  singleBucket: (node: THREE.Object3D) => boolean,
  /** Livery: material name → hex colour baked into the merged vertex colours (a different livery = its own geometry). */
  recolor?: Readonly<Record<string, string>>,
): void {
  const liveryKey = recolor
    ? Object.entries(recolor)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : '';
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.children.filter(isStdMesh).length >= 2) nodes.push(o);
  });

  for (const node of nodes) {
    const meshes = node.children.filter(isStdMesh);
    const one = singleBucket(node);
    const bucketOf = (m: THREE.MeshStandardMaterial): Bucket | null =>
      isKept(m) ? null : one ? 'matte' : m.metalness >= 0.45 ? 'metal' : 'matte';

    for (const b of ['metal', 'matte'] as const) {
      const group = meshes.filter((m) => bucketOf(m.material) === b);
      if (group.length === 0) continue;
      const key = group[0].geometry;
      let perBucket = mergedGeos.get(key);
      if (!perBucket) {
        perBucket = new Map();
        mergedGeos.set(key, perBucket);
      }
      const cacheKey = `${b}|${liveryKey}`;
      let merged = perBucket.get(cacheKey);
      if (!merged) {
        const parts = group.map((m) => {
          const g = m.geometry.clone();
          g.applyMatrix4(m.matrix);
          for (const name of Object.keys(g.attributes))
            if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
          const n = g.getAttribute('position').count;
          const col = new Float32Array(n * 3);
          const hex = recolor?.[m.material.name];
          const c = hex ? colourScratch.set(hex) : m.material.color;
          for (let i = 0; i < n; i++) {
            col[i * 3] = c.r;
            col[i * 3 + 1] = c.g;
            col[i * 3 + 2] = c.b;
          }
          g.setAttribute('color', new THREE.BufferAttribute(col, 3));
          return g;
        });
        merged = mergeGeometries(parts, false) ?? parts[0];
        parts.forEach((g) => g !== merged && g.dispose());
        perBucket.set(cacheKey, merged);
      }
      const mesh = new THREE.Mesh(merged, sharedMaterial(b));
      mesh.name = `${node.name || 'part'}_${b}`;
      for (const m of group) {
        node.remove(m);
        m.material.dispose(); // the per-car clone is no longer used
      }
      node.add(mesh);
    }
  }
}

/** Same merge for static props (shophouses, scooters, planes): textured and glowing materials stay separate draws. */
export function mergePropMaterials(root: THREE.Object3D): void {
  mergeCarMaterials(root, () => false);
}
