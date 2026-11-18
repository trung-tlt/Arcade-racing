import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import { settings } from '../core/Settings';

export interface SkidEmitter {
  /** Unique per wheel, e.g. 'player:RL'. */
  key: string;
  /** Ground contact point. */
  x: number;
  y: number;
  z: number;
  /** Unit forward direction on the ground plane. */
  dx: number;
  dz: number;
  active: boolean;
  /** 0..1 alpha. */
  intensity: number;
}

export interface Pt2 {
  x: number;
  z: number;
}

export interface Quad {
  prevL: Pt2;
  prevR: Pt2;
  currL: Pt2;
  currR: Pt2;
}

const POOL_QUADS = 2048;
const MIN_POOL_FRACTION = 0.25;
const HALF_WIDTH = 0.14;
const LIFT = 0.04;
const ROAD_Y = 0.03;
const FADE_SEC = 20;
const MIN_STEP = 0.25;
const MAX_STEP = 6;
const TEX_REPEAT_M = 1;
const TEXTURE = 'textures/fx_skidmark.png';

/** Corners of the ribbon segment prev→curr; left is (dz, -dx), i.e. +X when heading +Z. */
export function quadFor(prev: Pt2, curr: Pt2, halfWidth: number, out?: Quad): Quad {
  const q = out ?? {
    prevL: { x: 0, z: 0 },
    prevR: { x: 0, z: 0 },
    currL: { x: 0, z: 0 },
    currR: { x: 0, z: 0 },
  };
  let dx = curr.x - prev.x;
  let dz = curr.z - prev.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const lx = dz * halfWidth;
  const lz = -dx * halfWidth;
  q.prevL.x = prev.x + lx;
  q.prevL.z = prev.z + lz;
  q.prevR.x = prev.x - lx;
  q.prevR.z = prev.z - lz;
  q.currL.x = curr.x + lx;
  q.currL.z = curr.z + lz;
  q.currR.x = curr.x - lx;
  q.currR.z = curr.z - lz;
  return q;
}

const VERT = /* glsl */ `
attribute vec2 aInfo; // x = birth time, y = intensity
varying vec2 vUv;
varying vec2 vInfo;
void main() {
  vUv = uv;
  vInfo = aInfo;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uTime;
uniform float uLife;
varying vec2 vUv;
varying vec2 vInfo;
void main() {
  float fade = 1.0 - clamp((uTime - vInfo.x) / uLife, 0.0, 1.0);
  float a = texture2D(uMap, vUv).a * vInfo.y * fade;
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.03, 0.035, 0.045, a);
}`;

interface Strip {
  key: string;
  has: boolean;
  seen: number;
  x: number;
  z: number;
  lx: number;
  lz: number;
  rx: number;
  rz: number;
  v: number;
}

/** Drift / skid ribbons: one ring-buffer mesh (one draw call) with per-vertex birth time for fading. */
export class Skidmarks {
  private readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly uv: Float32Array;
  private readonly info: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly uvAttr: THREE.BufferAttribute;
  private readonly infoAttr: THREE.BufferAttribute;
  private readonly cap: number;
  private readonly strips: Strip[] = [];
  private readonly byKey = new Map<string, Strip>();
  private readonly quad = quadFor({ x: 0, z: 0 }, { x: 0, z: 1 }, 1);
  private readonly prevPt: Pt2 = { x: 0, z: 0 };
  private readonly currPt: Pt2 = { x: 0, z: 0 };
  private head = 0;
  private filled = 0;
  private time = 0;
  private frame = 0;
  private dirty = false;

  constructor(
    private readonly scene: THREE.Scene,
    assets: Assets,
  ) {
    this.cap = Math.max(64, Math.round(POOL_QUADS * Math.max(MIN_POOL_FRACTION, settings.particleScale)));
    const n = this.cap;
    this.pos = new Float32Array(n * 4 * 3);
    this.uv = new Float32Array(n * 4 * 2);
    this.info = new Float32Array(n * 4 * 2);
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6);
    }
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.uvAttr = new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.infoAttr = new THREE.BufferAttribute(this.info, 2).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('uv', this.uvAttr);
    this.geo.setAttribute('aInfo', this.infoAttr);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);

    const tex = assets.texture(TEXTURE);
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex }, uTime: { value: 0 }, uLife: { value: FADE_SEC } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'skidmarks';
    scene.add(this.mesh);
  }

  update(dt: number, emitters: readonly SkidEmitter[]): void {
    this.time += dt;
    this.frame++;
    this.mat.uniforms.uTime.value = this.time;

    for (const e of emitters) {
      let s = this.byKey.get(e.key);
      if (!s) {
        s = { key: e.key, has: false, seen: 0, x: 0, z: 0, lx: 0, lz: 0, rx: 0, rz: 0, v: 0 };
        this.byKey.set(e.key, s);
        this.strips.push(s);
      }
      s.seen = this.frame;
      if (!e.active || e.intensity <= 0.01) {
        s.has = false;
        continue;
      }
      this.currPt.x = e.x;
      this.currPt.z = e.z;
      if (!s.has) {
        s.x = e.x;
        s.z = e.z;
        s.has = true;
        s.lx = NaN;
        continue;
      }
      const step = Math.hypot(e.x - s.x, e.z - s.z);
      if (step > MAX_STEP) {
        // Teleport / respawn: start a fresh strip, don't bridge.
        s.x = e.x;
        s.z = e.z;
        s.lx = NaN;
        continue;
      }
      if (step < MIN_STEP) continue;
      this.prevPt.x = s.x;
      this.prevPt.z = s.z;
      quadFor(this.prevPt, this.currPt, HALF_WIDTH, this.quad);
      const q = this.quad;
      // Continue from the previous segment's end corners so ribbons stay connected through curves.
      const hasPrev = !Number.isNaN(s.lx);
      const pLx = hasPrev ? s.lx : q.prevL.x;
      const pLz = hasPrev ? s.lz : q.prevL.z;
      const pRx = hasPrev ? s.rx : q.prevR.x;
      const pRz = hasPrev ? s.rz : q.prevR.z;
      const y = Math.max(e.y, ROAD_Y) + LIFT;
      const v1 = s.v + step / TEX_REPEAT_M;
      this.pushQuad(pLx, pLz, pRx, pRz, q.currL.x, q.currL.z, q.currR.x, q.currR.z, y, s.v, v1, e.intensity);
      s.lx = q.currL.x;
      s.lz = q.currL.z;
      s.rx = q.currR.x;
      s.rz = q.currR.z;
      s.v = v1;
      s.x = e.x;
      s.z = e.z;
    }
    // Emitters that vanished (car removed) end their strip too.
    for (const s of this.strips) if (s.seen !== this.frame) s.has = false;

    if (this.dirty) {
      this.posAttr.needsUpdate = true;
      this.uvAttr.needsUpdate = true;
      this.infoAttr.needsUpdate = true;
      this.geo.setDrawRange(0, this.filled * 6);
      this.dirty = false;
    }
  }

  private pushQuad(
    plx: number,
    plz: number,
    prx: number,
    prz: number,
    clx: number,
    clz: number,
    crx: number,
    crz: number,
    y: number,
    v0: number,
    v1: number,
    intensity: number,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.filled = Math.min(this.cap, this.filled + 1);
    const p = i * 12;
    const set = (o: number, x: number, z: number): void => {
      this.pos[o] = x;
      this.pos[o + 1] = y;
      this.pos[o + 2] = z;
    };
    set(p, plx, plz);
    set(p + 3, prx, prz);
    set(p + 6, clx, clz);
    set(p + 9, crx, crz);
    const u = i * 8;
    this.uv[u] = 0;
    this.uv[u + 1] = v0;
    this.uv[u + 2] = 1;
    this.uv[u + 3] = v0;
    this.uv[u + 4] = 0;
    this.uv[u + 5] = v1;
    this.uv[u + 6] = 1;
    this.uv[u + 7] = v1;
    for (let k = 0; k < 4; k++) {
      this.info[u + k * 2] = this.time;
      this.info[u + k * 2 + 1] = intensity;
    }
    this.dirty = true;
  }

  /** Remove all marks (race restart). */
  clear(): void {
    this.head = 0;
    this.filled = 0;
    this.geo.setDrawRange(0, 0);
    for (const s of this.strips) s.has = false;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
