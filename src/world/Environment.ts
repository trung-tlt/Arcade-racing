import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { HANDLING, type TrackDef } from '../core/Data';

const SIZE = 2000;
const DAY_SIZE = 6000;
const WATER_DROP_M = 0.4;

const WATER_VERT = /* glsl */ `
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

// Cheap animated harbour water: summed sine ripples, drifting neon reflection streaks and a glowing quay edge.
const WATER_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uShoreX;
  varying vec3 vWorld;
  #include <fog_pars_fragment>
  void main() {
    vec2 p = vWorld.xz;
    float w = sin(p.y * 0.09 + uTime * 0.55) + sin(p.x * 0.07 - uTime * 0.4) + sin((p.x + p.y) * 0.16 + uTime * 0.9);
    vec3 col = uColor * (0.8 + 0.12 * w);
    // Reflections of the city's neon: bands that wobble with the ripples.
    float cyan = pow(max(0.0, sin(p.y * 0.045 + w * 0.7 + 1.3)), 22.0);
    float pink = pow(max(0.0, sin(p.y * 0.031 - w * 0.6 + 4.0)), 26.0);
    float fade = exp(-max(0.0, p.x - uShoreX) * 0.006);
    col += (vec3(0.05, 0.55, 0.9) * cyan + vec3(0.9, 0.12, 0.35) * pink) * fade * 0.5;
    // Bright rim where the quay meets the water (above the bloom threshold).
    col += vec3(0.1, 0.75, 1.0) * smoothstep(7.0, 0.0, p.x - uShoreX) * 0.9;
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

/** Dark land, an animated harbour (water east of `dressing.water.xFromM`) and the Rapier ground collider. */
export class Environment {
  private readonly land: THREE.Mesh;
  private readonly water: THREE.Mesh;
  private readonly collider: RAPIER.Collider;

  constructor(
    private readonly scene: THREE.Scene,
    R: typeof RAPIER,
    private readonly world: RAPIER.World,
    track?: TrackDef,
    /** World-space (x, z) polygons cut out of the visible land: the river under a bridge, an underpass trench. */
    holes: readonly (readonly [number, number][])[] = [],
  ) {
    const day = !!track?.daylight; // day and dusk maps
    const groundY = track?.groundY ?? 0;
    // Day maps have no harbour: the land plane covers everything and the water mesh is left empty.
    // The boulevard runs 1.4 km north of the origin; the port fits in 2 km. Size the world to the map.
    const size = day ? DAY_SIZE : SIZE;
    // Night map: the river starts at the quay edge (`quay.river.fromX`); everything west of it is land.
    const river = (track?.raw.quay as { river: { fromX: number; color: string } } | undefined)?.river ?? {
      fromX: size / 2,
      color: '#1A2A38',
    };
    const shoreX = day ? size / 2 : river.fromX;
    const min = -size / 2;
    const max = size / 2;

    let landGeo: THREE.BufferGeometry;
    if (holes.length > 0 && day) {
      // Shape space is (x, -z): a -90° turn about X lays it flat with +z where we want it.
      const shape = new THREE.Shape([
        new THREE.Vector2(min, -size / 2),
        new THREE.Vector2(max, -size / 2),
        new THREE.Vector2(max, size / 2),
        new THREE.Vector2(min, size / 2),
      ]);
      for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
      landGeo = new THREE.ShapeGeometry(shape);
    } else {
      landGeo = new THREE.PlaneGeometry(shoreX - min, size);
    }
    this.land = new THREE.Mesh(
      landGeo,
      new THREE.MeshStandardMaterial({ color: day ? '#8E9086' : '#12171F', roughness: 1, metalness: 0 }),
    );
    this.land.rotation.x = -Math.PI / 2;
    if (holes.length > 0 && day) this.land.position.set(0, 0, 0);
    else this.land.position.set((min + shoreX) / 2, 0, 0);
    this.land.receiveShadow = true;

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib['fog'],
      {
        uColor: { value: new THREE.Color(river.color) },
        uTime: { value: 0 },
        uShoreX: { value: shoreX },
      },
    ]);
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(max - shoreX, size),
      new THREE.ShaderMaterial({ uniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, fog: true }),
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set((shoreX + max) / 2, -WATER_DROP_M, 0);
    // Animate without needing a per-frame call from the game loop.
    this.water.onBeforeRender = (): void => {
      uniforms.uTime.value = performance.now() / 1000;
    };
    this.scene.add(this.land);
    if (!day) this.scene.add(this.water);

    // Maps with an underpass or a river have roads below y = 0, so the physics ground sits under all of them and the
    // road ribbon itself is the drivable surface.
    const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, groundY - 0.5, 0));
    this.collider = world.createCollider(
      R.ColliderDesc.cuboid(size / 2, 0.5, size / 2).setFriction(HANDLING.world.groundFriction),
      body,
    );
  }

  dispose(): void {
    this.scene.remove(this.land, this.water);
    for (const m of [this.land, this.water]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    const body = this.collider.parent();
    if (body) this.world.removeRigidBody(body);
  }
}
