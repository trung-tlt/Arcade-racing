import * as THREE from 'three';

/**
 * Distance culling for map-spanning instanced props.
 *
 * Fog hides everything past a known distance, so only instances near the camera need drawing. An InstanceWindow
 * keeps the full list of instance matrices aside and, before each draw, copies just the nearby ones to the front of
 * the InstancedMesh and sets `count` (0 = the renderer skips the draw call entirely). Works for the main pass
 * (`onBeforeRender`) and the shadow pass (`onBeforeShadow`, which also receives the main camera).
 */

/** Fog density of night maps (Lighting.ts); day maps carry their own in `TrackDef.daylight`. */
export const NIGHT_FOG_DENSITY = 0.006;

/** Draw distance for a map: where its fog has hidden everything, plus `margin` for big props. */
export function drawDistance(daylight: { fog: { density: number } } | null, margin = 0): number {
  // 8% tail: at this distance the fog has hidden 92% of an object, so dropping it is imperceptible.
  return fogCullDistance(daylight?.fog.density ?? NIGHT_FOG_DENSITY, 0.08) + margin;
}

/** Distance at which exponential-squared fog (`FogExp2`) has blended `1 - tail` of an object into the fog colour. */
export function fogCullDistance(density: number, tail = 0.02): number {
  return Math.sqrt(-Math.log(tail)) / density;
}

/**
 * Indices of the (x, z) points within `radius` of (cx, cz), written to `out` in ascending order.
 * Returns how many were found. `xz` holds x, z pairs.
 */
export function selectWithin(xz: Float32Array, cx: number, cz: number, radius: number, out: Uint32Array): number {
  const r2 = radius * radius;
  let n = 0;
  for (let i = 0, k = 0; i < xz.length; i += 2, k++) {
    const dx = xz[i] - cx;
    const dz = xz[i + 1] - cz;
    if (dx * dx + dz * dz <= r2) out[n++] = k;
  }
  return n;
}

/** Translation (x, z) of every instance of an InstancedMesh, as x, z pairs. */
export function instancePositions(mesh: THREE.InstancedMesh): Float32Array {
  const a = mesh.instanceMatrix.array;
  const xz = new Float32Array(mesh.count * 2);
  for (let i = 0; i < mesh.count; i++) {
    xz[i * 2] = a[i * 16 + 12];
    xz[i * 2 + 1] = a[i * 16 + 14];
  }
  return xz;
}

type Hook = (renderer: THREE.WebGLRenderer, ...args: unknown[]) => void;

export class InstanceWindow {
  private readonly sel: Uint32Array;
  private count = 0;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;
  /** The camera must move this far (m) before the selection is recomputed. */
  private readonly hysteresis = 2;

  constructor(
    private readonly xz: Float32Array,
    private readonly radius: number,
  ) {
    this.sel = new Uint32Array(xz.length / 2);
  }

  /** Select instances near the camera (cached while the camera hardly moves). */
  select(cx: number, cz: number): number {
    if (
      Math.abs(cx - this.lastX) > this.hysteresis ||
      Math.abs(cz - this.lastZ) > this.hysteresis ||
      this.lastX !== this.lastX
    ) {
      this.lastX = cx;
      this.lastZ = cz;
      this.count = selectWithin(this.xz, cx, cz, this.radius, this.sel);
      this.version++;
    }
    return this.count;
  }

  version = 0;
  get selected(): Uint32Array {
    return this.sel;
  }

  /** Make `mesh` draw only the instances this window selects. Call once, after its matrices are final. */
  attach(mesh: THREE.InstancedMesh): void {
    const full = mesh.count;
    const srcM = new Float32Array(mesh.instanceMatrix.array.subarray(0, full * 16));
    const srcC = mesh.instanceColor ? new Float32Array(mesh.instanceColor.array.subarray(0, full * 3)) : null;
    let applied = -1;
    const apply = (cam: THREE.Camera): void => {
      const n = this.select(cam.position.x, cam.position.z);
      if (applied !== this.version) {
        applied = this.version;
        const dst = mesh.instanceMatrix.array as Float32Array;
        for (let k = 0; k < n; k++) dst.set(srcM.subarray(this.sel[k] * 16, this.sel[k] * 16 + 16), k * 16);
        if (srcC && mesh.instanceColor) {
          const dc = mesh.instanceColor.array as Float32Array;
          for (let k = 0; k < n; k++) dc.set(srcC.subarray(this.sel[k] * 3, this.sel[k] * 3 + 3), k * 3);
          mesh.instanceColor.needsUpdate = true;
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
      mesh.count = n;
    };
    mesh.onBeforeRender = ((_r: THREE.WebGLRenderer, _s: THREE.Scene, cam: THREE.Camera): void =>
      apply(cam)) as unknown as Hook;
    mesh.onBeforeShadow = ((_r: THREE.WebGLRenderer, _o: THREE.Object3D, cam: THREE.Camera): void =>
      apply(cam)) as unknown as Hook;
    // First frame: nothing near yet, so nothing is drawn until the camera is known.
    mesh.count = 0;
  }
}

/** Window several meshes that share instance positions (a model with N sub-meshes). */
export function windowInstances(meshes: readonly THREE.InstancedMesh[], radius: number): InstanceWindow | null {
  if (meshes.length === 0) return null;
  const win = new InstanceWindow(instancePositions(meshes[0]), radius);
  for (const m of meshes) win.attach(m);
  return win;
}

/**
 * Hides its children when the camera is further than `maxDistM` (minus `radiusM`) from `center`.
 * Uses the renderer's LOD hook (`isLOD` + `update(camera)`), which runs every frame and respects child visibility in
 * the shadow pass too. Children keep their own world transforms: this object must stay at the origin.
 */
export class DistanceCull extends THREE.Object3D {
  readonly isLOD = true;
  autoUpdate = true;

  constructor(
    readonly center: THREE.Vector3,
    readonly maxDistM: number,
    readonly radiusM = 0,
  ) {
    super();
    this.name = 'distanceCull';
  }

  update(camera: THREE.Camera): void {
    const d = camera.position.distanceTo(this.center) - this.radiusM;
    const show = d < this.maxDistM;
    for (const c of this.children) c.visible = show;
  }
}

/**
 * Draw an instanced set (whose matrices keep changing, e.g. bobbing pickups) only while the camera is within `radius`
 * of any of its instances; otherwise `count = 0` so it costs no draw call. `xz` holds the instances' x, z pairs.
 */
export function gateByDistance(meshes: readonly THREE.InstancedMesh[], xz: Float32Array, radius: number): void {
  const r2 = radius * radius;
  const fulls = meshes.map((m) => m.count);
  const apply = (cam: THREE.Camera): void => {
    let near = false;
    for (let i = 0; i < xz.length && !near; i += 2) {
      const dx = xz[i] - cam.position.x;
      const dz = xz[i + 1] - cam.position.z;
      near = dx * dx + dz * dz <= r2;
    }
    meshes.forEach((m, k) => (m.count = near ? fulls[k] : 0));
  };
  for (const m of meshes) {
    m.onBeforeRender = ((_r: THREE.WebGLRenderer, _s: THREE.Scene, cam: THREE.Camera): void =>
      apply(cam)) as unknown as Hook;
    m.onBeforeShadow = ((_r: THREE.WebGLRenderer, _o: THREE.Object3D, cam: THREE.Camera): void =>
      apply(cam)) as unknown as Hook;
  }
}
