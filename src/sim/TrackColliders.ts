import type RAPIER from '@dimforge/rapier3d-compat';
import { HANDLING, RACE, roadWidthAt, type TrackDef } from '../core/Data';
import type { TrackPath } from '../world/TrackPath';

type Rapier = typeof RAPIER;

const ROAD_UNDERLAY_M = 1.5;

/** Road geometry shared by the track meshes and the colliders: per-sample half widths and bend limits. */
export interface TrackShape {
  /** A street circuit (Map 5) lists its own barriers (`barriers` in the JSON): no sidewalk strip, gates or generic gantry. */
  readonly circuit: boolean;
  /** How far the wall collider sits inside the carriageway edge: it stops cars at the Armco's face. */
  readonly wallInsetM: number;
  /** Half the carriageway width at each path sample (varies on maps with a narrower stretch). */
  readonly half: Float32Array;
  /** Per sample, the most the left / right edge may sit from the centre line: a hairpin tighter than the road is wide
   * would otherwise fold its inner wall and kerb across the carriageway (Cong Hoa's U-turn has a 4 m radius). */
  readonly limitL: Float32Array;
  readonly limitR: Float32Array;
}

export function computeTrackShape(def: TrackDef, path: TrackPath): TrackShape {
  const armco = (def.raw.barriers as { armco?: { lateralM: number } } | undefined)?.armco;
  const n = path.count;
  const half = new Float32Array(n);
  for (let i = 0; i < n; i++) half[i] = roadWidthAt(def, i / n) / 2;
  const limitL = new Float32Array(n).fill(Infinity);
  const limitR = new Float32Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const a = (i + n - 2) % n;
    const b = (i + 2) % n;
    let dh = Math.atan2(path.tx[b], path.tz[b]) - Math.atan2(path.tx[a], path.tz[a]);
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    const radius = (4 * path.spacingM) / Math.max(1e-6, Math.abs(dh));
    // dh > 0: the heading turns towards the left, so the turn centre is on the left edge.
    if (radius < half[i] + 1) (dh > 0 ? limitL : limitR)[i] = Math.max(0.5, radius - 1);
  }
  return {
    circuit: !!armco,
    wallInsetM: armco ? armco.lateralM - 0.2 - roadWidthAt(def, 0) / 2 : 0,
    half,
    limitL,
    limitR,
  };
}

/** Half width on one side (+1 left, -1 right) at sample `i`, shortened inside a very tight bend. */
export function trackEdge(shape: TrackShape, i: number, side: number): number {
  return Math.min(shape.half[i], side > 0 ? shape.limitL[i] : shape.limitR[i]);
}

export interface TrackColliders {
  readonly body: RAPIER.RigidBody;
  /**
   * Rapier handles (`collider.handle`) of the invisible side walls. Contact events are enabled on them, so a car that
   * hits a wall can be told apart from one that hits another car or the road (Map 5 charges hull damage for it).
   */
  readonly wallHandles: Set<number>;
}

/** The static side walls (and, on maps with elevation, the road surface). No meshes: the server builds this too. */
export function buildTrackColliders(
  R: Rapier,
  world: RAPIER.World,
  def: TrackDef,
  path: TrackPath,
  shape: TrackShape,
): TrackColliders {
  const n = path.count;
  const h = RACE.track.wallColliderHeightM;
  const body = world.createRigidBody(R.RigidBodyDesc.fixed());
  const wallHandles = new Set<number>();
  // Left-pointing unit vector (+X is left for a car facing +Z).
  const lx = (i: number): number => path.tz[i];
  const lz = (i: number): number => -path.tx[i];
  for (let side = 0; side < 2; side++) {
    const s = side === 0 ? 1 : -1;
    const verts = new Float32Array(n * 4 * 3);
    for (let i = 0; i < n; i++) {
      const inner0 = trackEdge(shape, i, s) + shape.wallInsetM;
      const outer0 = inner0 + RACE.track.wallColliderThicknessM;
      const y0 = path.py[i];
      const ring: [number, number][] = [
        [inner0, 0],
        [inner0, h],
        [outer0, h],
        [outer0, 0],
      ];
      ring.forEach(([d, y], r) => {
        const o = (i * 4 + r) * 3;
        verts[o] = path.px[i] + lx(i) * d * s;
        verts[o + 1] = y0 + y;
        verts[o + 2] = path.pz[i] + lz(i) * d * s;
      });
    }
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      // No inner wall in a bend tighter than the road is wide: it would sit inside the turn's own track.
      if ((s > 0 ? shape.limitL[i] : shape.limitR[i]) < shape.half[i]) continue;
      const a = i * 4;
      const b = ((i + 1) % n) * 4;
      for (let r = 0; r < 4; r++) {
        const r2 = (r + 1) % 4;
        idx.push(a + r, b + r, b + r2, a + r, b + r2, a + r2);
      }
    }
    const wall = world.createCollider(
      R.ColliderDesc.trimesh(verts, new Uint32Array(idx))
        .setFriction(0.2)
        .setRestitution(0.2)
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS),
      body,
    );
    wallHandles.add(wall.handle);
  }
  if (def.hasElevation) buildRoadCollider(R, world, path, shape, body);
  return { body, wallHandles };
}

/** Maps with hills, a bridge or an underpass drive on the ribbon itself (the ground plane is far below). */
function buildRoadCollider(
  R: Rapier,
  world: RAPIER.World,
  path: TrackPath,
  shape: TrackShape,
  body: RAPIER.RigidBody,
): void {
  const n = path.count;
  // Two surfaces: the driving surface and a second one below it, with no side faces between them. A closed prism put
  // edges all along the carriageway and fast cars caught on them; a single sheet let a hard landing push through.
  // FIX_INTERNAL_EDGES makes the many small coplanar triangles behave as one smooth surface.
  const layers = [0, -ROAD_UNDERLAY_M];
  const verts = new Float32Array(n * 2 * layers.length * 3);
  for (let i = 0; i < n; i++) {
    const edges = [trackEdge(shape, i, 1), -trackEdge(shape, i, -1)];
    layers.forEach((dy, k) => {
      edges.forEach((d, r) => {
        const o = ((k * n + i) * 2 + r) * 3;
        verts[o] = path.px[i] + path.tz[i] * d;
        verts[o + 1] = path.py[i] + dy;
        verts[o + 2] = path.pz[i] - path.tx[i] * d;
      });
    });
  }
  const idx: number[] = [];
  for (let k = 0; k < layers.length; k++) {
    for (let i = 0; i < n; i++) {
      const a = (k * n + i) * 2;
      const b = (k * n + ((i + 1) % n)) * 2;
      idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  world.createCollider(
    R.ColliderDesc.trimesh(verts, new Uint32Array(idx), R.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(
      HANDLING.world.groundFriction,
    ),
    body,
  );
}
