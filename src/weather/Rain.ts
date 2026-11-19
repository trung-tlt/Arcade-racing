import * as THREE from 'three';
import type { WeatherDef } from '../core/Data';
import { WEATHER_FX } from './config';
import { visibleRainCount } from './rainConfig';

const VERT = /* glsl */ `
  attribute vec3 aSeed;
  uniform vec3 uCam;
  uniform vec3 uBox;
  uniform float uTime;
  uniform float uFall;
  uniform float uSlant;
  uniform float uLen;
  uniform float uWidth;
  uniform float uUp;
  varying vec2 vUv;
  varying float vSeed;
  varying float vNear;
  void main() {
    vec3 axis = normalize(vec3(uSlant, -1.0, 0.0));
    // Every drop lives in a box that follows the camera; wrapping it with fract() keeps memory and cost constant.
    vec3 p = aSeed - vec3(uSlant * uFall * uTime / uBox.x, uFall * uTime / uBox.y, 0.0);
    p = fract(p) - 0.5;
    vec3 pos = uCam + vec3(p.x * uBox.x, p.y * uBox.y + uUp, p.z * uBox.z);
    vec3 toCam = normalize(cameraPosition - pos);
    vec3 right = normalize(cross(axis, toCam));
    vec3 wp = pos + right * position.x * uWidth + axis * position.y * uLen;
    vUv = position.xy + 0.5;
    vSeed = aSeed.x * 17.0 + aSeed.z * 5.0;
    vNear = smoothstep(1.5, 6.0, distance(cameraPosition, pos));
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  varying float vSeed;
  varying float vNear;
  void main() {
    float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
    float along = smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
    // A slice of the rain sheet adds the streak variation; the profile keeps a single drop slim.
    vec4 tex = texture2D(uMap, vec2(fract(vSeed) * 0.8 + vUv.x * 0.2, fract(vSeed * 3.1) * 0.5 + vUv.y * 0.5));
    float a = across * across * along * uAlpha * (0.6 + tex.a * 1.6) * vNear;
    gl_FragColor = vec4(mix(uColor, tex.rgb, 0.35), a);
  }
`;

/** Rain streaks: one instanced draw call. The visible count follows the intensity; nothing is allocated per frame. */
export class Rain {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private time = 0;

  constructor(
    scene: THREE.Scene,
    tex: THREE.Texture,
    def: WeatherDef['rain'],
    readonly capacity: number,
  ) {
    const fx = WEATHER_FX.rain;
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(capacity * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    this.geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    this.geo.instanceCount = 0;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const [bx, by, bz] = def.particles.boxAroundCameraM;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        uMap: { value: tex },
        uColor: { value: new THREE.Color(fx.color) },
        uAlpha: { value: fx.alpha },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(bx, by, bz) },
        uTime: { value: 0 },
        uFall: { value: def.particles.fallSpeedMps },
        uSlant: { value: def.particles.windSlant },
        uLen: { value: fx.lengthM },
        uWidth: { value: fx.widthM },
        uUp: { value: fx.boxCentreUpM },
      },
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = 'rain';
    scene.add(this.mesh);
  }

  update(dt: number, camPos: THREE.Vector3, intensity: number): void {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    (this.mat.uniforms.uCam.value as THREE.Vector3).copy(camPos);
    this.geo.instanceCount = visibleRainCount(this.capacity, intensity);
    this.mesh.visible = this.geo.instanceCount > 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
