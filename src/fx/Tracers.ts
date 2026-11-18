import * as THREE from 'three';
import { settings } from '../core/Settings';
import type { Assets } from '../core/Assets';

const TRACER_CAP_MAX = 64;
const FLASH_CAP = 8;
const TRACER_LIFE = 0.06;
const FLASH_LIFE = 0.04;
const TRACER_WIDTH = 0.12;
const TRACER_COLOR = '#FFE08A';
const FLASH_COLOR = '#FFD27A';

const TRACER_VERT = /* glsl */ `
attribute vec3 iFrom;
attribute vec3 iTo;
attribute vec2 iData; // half width (m), alpha
varying vec2 vUv;
varying float vAlpha;
void main() {
  // Project both ends, then widen the quad perpendicular to the on-screen direction so
  // a shot fired away from the camera still reads as a streak toward the vanishing point.
  bool head = position.x > 0.0;
  vec4 a = projectionMatrix * viewMatrix * vec4(iFrom, 1.0);
  vec4 b = projectionMatrix * viewMatrix * vec4(iTo, 1.0);
  a.w = max(a.w, 0.05);
  b.w = max(b.w, 0.05);
  vec2 na = a.xy / a.w;
  vec2 nb = b.xy / b.w;
  float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
  vec2 d = vec2((nb.x - na.x) * aspect, nb.y - na.y);
  d = d / max(length(d), 1e-5);
  vec2 perp = vec2(-d.y / aspect, d.x);
  vec4 c = head ? b : a;
  float side = position.y * 2.0 * iData.x * projectionMatrix[1][1] / c.w;
  vec2 ndc = c.xy / c.w + perp * side;
  gl_Position = vec4(ndc * c.w, c.z, c.w);
  vUv = uv;
  vAlpha = iData.y;
}`;

const FLASH_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iData; // size, roll, alpha
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float c = cos(iData.y);
  float s = sin(iData.y);
  vec2 p = position.xy * iData.x;
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(iPos + right * p.x + up * p.y, 1.0);
  vUv = uv;
  vAlpha = iData.z;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uMap, vUv);
  gl_FragColor = vec4(t.rgb * uColor, t.a * vAlpha);
  if (gl_FragColor.a < 0.003) discard;
}`;

function material(map: THREE.Texture, vert: string, color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uColor: { value: new THREE.Color(color) } },
    vertexShader: vert,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function instanced(count: number): { geo: THREE.InstancedBufferGeometry; dispose: () => void } {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setAttribute('uv', quad.getAttribute('uv'));
  geo.instanceCount = count;
  quad.dispose();
  return { geo, dispose: () => geo.dispose() };
}

/** Hitscan tracers (stretched additive streaks) and muzzle flashes. Two draw calls total. */
export class Tracers {
  /** Tracer pool size, scaled by the quality preset (min 16). */
  private readonly tCap = Math.max(16, Math.round(TRACER_CAP_MAX * settings.particleScale));
  private readonly tracerMesh: THREE.Mesh;
  private readonly flashMesh: THREE.Mesh;
  private readonly tracerGeo: THREE.InstancedBufferGeometry;
  private readonly flashGeo: THREE.InstancedBufferGeometry;
  private readonly tracerMat: THREE.ShaderMaterial;
  private readonly flashMat: THREE.ShaderMaterial;

  private readonly from = new Float32Array(this.tCap * 3);
  private readonly to = new Float32Array(this.tCap * 3);
  private readonly tData = new Float32Array(this.tCap * 2);
  private readonly tAge = new Float32Array(this.tCap).fill(1e9);
  private tNext = 0;
  private readonly tAttrs: THREE.InstancedBufferAttribute[];

  private readonly fPos = new Float32Array(FLASH_CAP * 3);
  private readonly fData = new Float32Array(FLASH_CAP * 3);
  private readonly fAge = new Float32Array(FLASH_CAP).fill(1e9);
  private readonly fSize = new Float32Array(FLASH_CAP);
  private readonly fRoll = new Float32Array(FLASH_CAP);
  private fNext = 0;
  private readonly fAttrs: THREE.InstancedBufferAttribute[];

  constructor(
    private readonly scene: THREE.Scene,
    assets: Assets,
  ) {
    const t = instanced(this.tCap);
    this.tracerGeo = t.geo;
    const mkT = (arr: Float32Array, size: number, name: string): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      this.tracerGeo.setAttribute(name, a);
      return a;
    };
    this.tAttrs = [mkT(this.from, 3, 'iFrom'), mkT(this.to, 3, 'iTo'), mkT(this.tData, 2, 'iData')];
    this.tracerMat = material(assets.texture('textures/fx_tracer.png'), TRACER_VERT, TRACER_COLOR);
    this.tracerMesh = new THREE.Mesh(this.tracerGeo, this.tracerMat);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.renderOrder = 11;

    const f = instanced(FLASH_CAP);
    this.flashGeo = f.geo;
    const mkF = (arr: Float32Array, size: number, name: string): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      this.flashGeo.setAttribute(name, a);
      return a;
    };
    this.fAttrs = [mkF(this.fPos, 3, 'iPos'), mkF(this.fData, 3, 'iData')];
    this.flashMat = material(assets.texture('textures/fx_muzzle_flash.png'), FLASH_VERT, FLASH_COLOR);
    this.flashMesh = new THREE.Mesh(this.flashGeo, this.flashMat);
    this.flashMesh.frustumCulled = false;
    this.flashMesh.renderOrder = 11;

    scene.add(this.tracerMesh, this.flashMesh);
  }

  /** Streak from `from` to `to`; the texture's bright end sits at `to`. */
  fire(from: THREE.Vector3, to: THREE.Vector3): void {
    const i = this.tNext;
    this.tNext = (this.tNext + 1) % this.tCap;
    this.from[i * 3] = from.x;
    this.from[i * 3 + 1] = from.y;
    this.from[i * 3 + 2] = from.z;
    this.to[i * 3] = to.x;
    this.to[i * 3 + 1] = to.y;
    this.to[i * 3 + 2] = to.z;
    this.tData[i * 2] = TRACER_WIDTH;
    this.tData[i * 2 + 1] = 1;
    this.tAge[i] = 0;
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3): void {
    const i = this.fNext;
    this.fNext = (this.fNext + 1) % FLASH_CAP;
    // Nudge the flash a little ahead of the barrel along the fire direction.
    this.fPos[i * 3] = pos.x + dir.x * 0.25;
    this.fPos[i * 3 + 1] = pos.y + dir.y * 0.25;
    this.fPos[i * 3 + 2] = pos.z + dir.z * 0.25;
    this.fSize[i] = 0.7 + Math.random() * 0.5;
    this.fRoll[i] = Math.random() * Math.PI * 2;
    this.fAge[i] = 0;
  }

  private tHad = true;
  private fHad = true;

  update(dt: number, _camera: THREE.Camera): void {
    void _camera; // billboarding happens in the shaders via viewMatrix
    let tLive = 0;
    let fLive = 0;
    for (let i = 0; i < this.tCap; i++) {
      if (this.tAge[i] >= TRACER_LIFE) {
        this.tData[i * 2 + 1] = 0;
        continue;
      }
      tLive++;
      this.tAge[i] += dt;
      this.tData[i * 2 + 1] = Math.max(0, 1 - this.tAge[i] / TRACER_LIFE);
    }
    for (let i = 0; i < FLASH_CAP; i++) {
      const o = i * 3;
      if (this.fAge[i] >= FLASH_LIFE) {
        this.fData[o] = 0;
        this.fData[o + 2] = 0;
        continue;
      }
      fLive++;
      this.fAge[i] += dt;
      this.fData[o] = this.fSize[i];
      this.fData[o + 1] = this.fRoll[i];
      this.fData[o + 2] = 1;
    }
    // Empty pools cost no draw call; upload once more after the last streak/flash dies so the collapsed data is seen.
    if (tLive > 0 || this.tHad) for (const a of this.tAttrs) a.needsUpdate = true;
    if (fLive > 0 || this.fHad) for (const a of this.fAttrs) a.needsUpdate = true;
    this.tracerMesh.visible = tLive > 0 || this.tHad;
    this.flashMesh.visible = fLive > 0 || this.fHad;
    this.tHad = tLive > 0;
    this.fHad = fLive > 0;
  }

  dispose(): void {
    this.scene.remove(this.tracerMesh, this.flashMesh);
    this.tracerGeo.dispose();
    this.flashGeo.dispose();
    this.tracerMat.dispose();
    this.flashMat.dispose();
  }
}
