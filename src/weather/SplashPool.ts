import * as THREE from 'three';

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  uniform float uScale;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vAlpha = aAlpha;
    gl_PointSize = min(aSize * uScale / max(0.1, -mv.z), 220.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec4 c = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(c.rgb * uColor, c.a * vAlpha);
  }
`;

/**
 * A fixed pool of soft splash sprites (tyre spray, puddle bursts, the flood's bow wave): one Points draw call.
 * Particles rise, drift and fade; a full pool simply recycles its oldest slot.
 */
export class SplashPool {
  readonly points: THREE.Points;
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly a0: Float32Array;
  private next = 0;
  private live = 0;

  constructor(
    scene: THREE.Scene,
    tex: THREE.Texture,
    readonly capacity: number,
    color = '#DCE6F0',
  ) {
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity).fill(1);
    this.life = new Float32Array(capacity).fill(1);
    this.s0 = new Float32Array(capacity);
    this.s1 = new Float32Array(capacity);
    this.a0 = new Float32Array(capacity);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: { uMap: { value: tex }, uColor: { value: new THREE.Color(color) }, uScale: { value: 600 } },
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 15;
    this.points.name = 'splash';
    scene.add(this.points);
  }

  /** Spawn one sprite; `size0 → size1` (m) and `alpha0 → 0` over `life` seconds. */
  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size0: number,
    size1: number,
    alpha: number,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.s0[i] = size0;
    this.s1[i] = size1;
    this.a0[i] = alpha;
  }

  /** Move and fade everything; `pixelsPerUnit` converts a world size at 1 m into point pixels. */
  update(dt: number, pixelsPerUnit: number): void {
    this.mat.uniforms.uScale.value = pixelsPerUnit;
    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.age[i] >= this.life[i]) {
        this.size[i] = 0;
        this.alpha[i] = 0;
        continue;
      }
      live++;
      this.age[i] += dt;
      const k = Math.min(1, this.age[i] / this.life[i]);
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 2.5 * dt; // light gravity: spray hangs, then settles
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
      this.alpha[i] = this.a0[i] * (1 - k) * Math.min(1, k * 8);
    }
    this.live = live;
    this.points.visible = live > 0;
    if (live > 0) {
      (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** Sprites alive after the last update. */
  get active(): number {
    return this.live;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
