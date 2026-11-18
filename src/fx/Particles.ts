import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { settings } from '../core/Settings';

export type ParticleKind = 'spark' | 'smoke' | 'fire' | 'explosion' | 'glow';

interface KindDef {
  texture: string;
  additive: boolean;
  capacity: number;
  life: [number, number];
  size: number;
  color: THREE.ColorRepresentation;
  gravity: number;
  drag: number;
  /** Size multiplier reached at end of life. */
  endScale: number;
  /** Alpha at birth; fades linearly to 0. */
  alpha: number;
  flipbook: boolean;
  spin: number;
  defaultVelY: number;
}

const KINDS: Record<ParticleKind, KindDef> = {
  spark: {
    texture: 'textures/fx_spark.png',
    additive: true,
    capacity: 256,
    life: [0.2, 0.5],
    size: 0.25,
    color: '#FFD9A0',
    gravity: -12,
    drag: 0.8,
    endScale: 0.2,
    alpha: 1,
    flipbook: false,
    spin: 0,
    defaultVelY: 0,
  },
  smoke: {
    texture: 'textures/fx_smoke.png',
    additive: false,
    capacity: 192,
    life: [1.2, 1.9],
    size: 1.2,
    color: '#8A93A3',
    gravity: 0,
    drag: 1.2,
    endScale: 2.6,
    alpha: 0.5,
    flipbook: false,
    spin: 0.8,
    defaultVelY: 1.4,
  },
  fire: {
    texture: 'textures/fx_glow.png',
    additive: true,
    capacity: 128,
    life: [0.3, 0.55],
    size: 0.9,
    color: '#FF6A1A',
    gravity: 3,
    drag: 1.5,
    endScale: 0.3,
    alpha: 1,
    flipbook: false,
    spin: 0,
    defaultVelY: 1,
  },
  explosion: {
    texture: 'textures/fx_explosion_4x4.png',
    additive: true,
    capacity: 12,
    life: [0.8, 0.8],
    size: 6,
    color: '#FFFFFF',
    gravity: 0,
    drag: 0,
    endScale: 1.15,
    alpha: 1,
    flipbook: true,
    spin: 0,
    defaultVelY: 0,
  },
  glow: {
    texture: 'textures/fx_glow.png',
    additive: true,
    capacity: 128,
    life: [0.3, 0.4],
    size: 1.4,
    color: '#8FE0FF',
    gravity: 0,
    drag: 2,
    endScale: 0.5,
    alpha: 0.9,
    flipbook: false,
    spin: 0,
    defaultVelY: 0,
  },
};

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iData; // size, roll, frame, alpha
attribute vec3 iColor;
uniform float uGrid;
varying vec2 vUv;
varying vec4 vTint;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float c = cos(iData.y);
  float s = sin(iData.y);
  vec2 p = position.xy * iData.x;
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  vec3 world = iPos + right * p.x + up * p.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  float col = mod(iData.z, uGrid);
  float row = floor(iData.z / uGrid);
  vUv = (vec2(col, uGrid - 1.0 - row) + uv) / uGrid;
  vTint = vec4(iColor, iData.w);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vTint;
void main() {
  vec4 t = texture2D(uMap, vUv);
  gl_FragColor = vec4(t.rgb * vTint.rgb, t.a * vTint.a);
  if (gl_FragColor.a < 0.003) discard;
}`;

/** Pool-size scale for the active quality preset (0..1), read when the pools are built. */
function particleScale(): number {
  return settings.particleScale;
}

class Pool {
  readonly mesh: THREE.Mesh;
  readonly cap: number;
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly data: Float32Array;
  private readonly color: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private readonly spinRate: Float32Array;
  private readonly roll: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  private next = 0;
  private hadLive = true;
  private readonly tint = new THREE.Color();

  constructor(
    scene: THREE.Scene,
    texture: THREE.Texture,
    private readonly def: KindDef,
  ) {
    this.cap = Math.max(4, Math.round(def.capacity * (def.flipbook ? 1 : particleScale())));
    const n = this.cap;
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    this.geo.instanceCount = n;
    this.pos = new Float32Array(n * 3);
    this.data = new Float32Array(n * 4);
    this.color = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n).fill(1e9);
    this.life = new Float32Array(n).fill(1);
    this.size0 = new Float32Array(n);
    this.spinRate = new Float32Array(n);
    this.roll = new Float32Array(n);
    const mk = (arr: Float32Array, size: number, name: string): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(name, a);
      return a;
    };
    this.attrs = [mk(this.pos, 3, 'iPos'), mk(this.data, 4, 'iData'), mk(this.color, 3, 'iColor')];
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture }, uGrid: { value: def.flipbook ? 4 : 1 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: def.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
    quad.dispose();
  }

  spawn(p: THREE.Vector3, vx: number, vy: number, vz: number, size: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.cap;
    const d = this.def;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = d.life[0] + Math.random() * (d.life[1] - d.life[0]);
    this.size0[i] = size;
    this.roll[i] = Math.random() * Math.PI * 2;
    this.spinRate[i] = (Math.random() - 0.5) * 2 * d.spin;
    this.tint.set(d.color);
    const v = 0.85 + Math.random() * 0.15;
    this.color[i * 3] = this.tint.r * v;
    this.color[i * 3 + 1] = this.tint.g * v;
    this.color[i * 3 + 2] = this.tint.b * v;
  }

  get defaultSize(): number {
    return this.def.size;
  }
  get defaultVelY(): number {
    return this.def.defaultVelY;
  }

  update(dt: number): void {
    const d = this.def;
    const drag = Math.max(0, 1 - d.drag * dt);
    let live = 0;
    for (let i = 0; i < this.cap; i++) {
      const o = i * 4;
      if (this.age[i] >= this.life[i]) {
        this.data[o] = 0; // dead: collapse the quad
        continue;
      }
      live++;
      this.age[i] += dt;
      const k = Math.min(1, this.age[i] / this.life[i]);
      const v = i * 3;
      this.vel[v] *= drag;
      this.vel[v + 1] = this.vel[v + 1] * drag + d.gravity * dt;
      this.vel[v + 2] *= drag;
      this.pos[v] += this.vel[v] * dt;
      this.pos[v + 1] += this.vel[v + 1] * dt;
      this.pos[v + 2] += this.vel[v + 2] * dt;
      this.roll[i] += this.spinRate[i] * dt;
      this.data[o] = this.size0[i] * (1 + (d.endScale - 1) * k);
      this.data[o + 1] = this.roll[i];
      this.data[o + 2] = d.flipbook ? Math.min(15, Math.floor(k * 16)) : 0;
      this.data[o + 3] = d.alpha * (d.flipbook ? 1 : 1 - k) * (d.flipbook && k > 0.85 ? (1 - k) / 0.15 : 1);
    }
    // An empty pool costs no draw call: upload once more after the last particle dies (collapsed quads), then hide.
    if (live > 0 || this.hadLive) for (const a of this.attrs) a.needsUpdate = true;
    this.mesh.visible = live > 0 || this.hadLive;
    this.hadLive = live > 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}

/** Pooled camera-facing particles. One draw call per kind (5 total). */
export class Particles {
  private readonly pools: Record<ParticleKind, Pool>;
  private readonly tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene, assets: Assets) {
    const mk = (k: ParticleKind): Pool => new Pool(scene, assets.texture(KINDS[k].texture), KINDS[k]);
    this.pools = {
      spark: mk('spark'),
      smoke: mk('smoke'),
      fire: mk('fire'),
      explosion: mk('explosion'),
      glow: mk('glow'),
    };
  }

  spawn(kind: ParticleKind, pos: THREE.Vector3, vel?: THREE.Vector3, size?: number): void {
    const p = this.pools[kind];
    const s = size ?? p.defaultSize;
    if (vel) p.spawn(pos, vel.x, vel.y, vel.z, s);
    else p.spawn(pos, 0, p.defaultVelY, 0, s);
  }

  /** `count` particles flying in random directions at up to `speed` m/s. */
  burst(kind: ParticleKind, pos: THREE.Vector3, count: number, speed: number, size?: number): void {
    const p = this.pools[kind];
    const s = size ?? p.defaultSize;
    for (let i = 0; i < count; i++) {
      const z = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      const sp = speed * (0.3 + Math.random() * 0.7);
      p.spawn(pos, Math.cos(a) * r * sp, z * sp, Math.sin(a) * r * sp, s * (0.6 + Math.random() * 0.8));
    }
  }

  explosion(pos: THREE.Vector3, radius: number): void {
    this.tmp.copy(pos);
    this.pools.explosion.spawn(this.tmp, 0, 0, 0, radius * 2);
    this.burst('spark', pos, 24, radius * 3.5, radius * 0.12);
    this.burst('fire', pos, 8, radius * 1.5, radius * 0.5);
    this.burst('smoke', pos, 8, radius * 0.7, radius * 0.6);
  }

  update(dt: number, _camera: THREE.Camera): void {
    // Billboards face the camera in the shader via viewMatrix, so the camera isn't needed here.
    void _camera;
    for (const p of Object.values(this.pools)) p.update(dt);
  }

  dispose(): void {
    for (const p of Object.values(this.pools)) p.dispose();
  }
}
