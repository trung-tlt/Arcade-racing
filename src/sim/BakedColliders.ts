import type RAPIER from '@dimforge/rapier3d-compat';

type Rapier = typeof RAPIER;

/** One static collider as dumped by `scripts/bake-colliders.mjs` (world-space pose, shape in collider space). */
export interface BakedCollider {
  src: 'track' | 'ground' | 'scenery';
  shape: 'cuboid' | 'trimesh' | 'convex' | string;
  t: [number, number, number];
  q: [number, number, number, number];
  friction: number;
  restitution: number;
  events: number;
  sensor: boolean;
  he?: [number, number, number];
  v?: number[];
  i?: number[];
}

export interface BakedTrack {
  track: string;
  static: BakedCollider[];
  /** Moving traffic bodies: not rebuilt yet (see Phase 1 notes). */
  kinematic: (BakedCollider & { body: number })[];
}

/** Rebuilds baked colliders of the given sources on one fixed body. Returns how many were created. */
export function buildBaked(
  R: Rapier,
  world: RAPIER.World,
  baked: BakedTrack,
  sources: readonly BakedCollider['src'][] = ['scenery'],
): number {
  const body = world.createRigidBody(R.RigidBodyDesc.fixed());
  let n = 0;
  for (const c of baked.static) {
    if (!sources.includes(c.src)) continue;
    let desc: RAPIER.ColliderDesc | null = null;
    if (c.shape === 'cuboid' && c.he) desc = R.ColliderDesc.cuboid(c.he[0], c.he[1], c.he[2]);
    else if (c.shape === 'trimesh' && c.v && c.i)
      desc = R.ColliderDesc.trimesh(new Float32Array(c.v), new Uint32Array(c.i));
    else if (c.shape === 'convex' && c.v) desc = R.ColliderDesc.convexHull(new Float32Array(c.v));
    if (!desc) throw new Error(`unsupported baked collider shape: ${c.shape}`);
    desc
      .setTranslation(c.t[0], c.t[1], c.t[2])
      .setRotation({ x: c.q[0], y: c.q[1], z: c.q[2], w: c.q[3] })
      .setFriction(c.friction)
      .setRestitution(c.restitution)
      .setActiveEvents(c.events)
      .setSensor(c.sensor);
    world.createCollider(desc, body);
    n++;
  }
  return n;
}
