import type RAPIER from '@dimforge/rapier3d-compat';
import type { BodyState, ReconcileBody } from './Reconciler';

/** The reconciler's view of a Rapier rigid body. */
export function rapierBody(body: RAPIER.RigidBody): ReconcileBody {
  return {
    read(out: BodyState): void {
      const p = body.translation();
      const q = body.rotation();
      const v = body.linvel();
      const w = body.angvel();
      out.p = [p.x, p.y, p.z];
      out.q = [q.x, q.y, q.z, q.w];
      out.v = [v.x, v.y, v.z];
      out.w = [w.x, w.y, w.z];
    },
    nudge(dp, dq, dv): void {
      const p = body.translation();
      const q = body.rotation();
      const v = body.linvel();
      body.setTranslation({ x: p.x + dp[0], y: p.y + dp[1], z: p.z + dp[2] }, true);
      // dq * q
      const rq = {
        x: dq[3] * q.x + dq[0] * q.w + dq[1] * q.z - dq[2] * q.y,
        y: dq[3] * q.y - dq[0] * q.z + dq[1] * q.w + dq[2] * q.x,
        z: dq[3] * q.z + dq[0] * q.y - dq[1] * q.x + dq[2] * q.w,
        w: dq[3] * q.w - dq[0] * q.x - dq[1] * q.y - dq[2] * q.z,
      };
      body.setRotation(rq, true);
      body.setLinvel({ x: v.x + dv[0], y: v.y + dv[1], z: v.z + dv[2] }, true);
    },
    set(s: BodyState): void {
      body.setTranslation({ x: s.p[0], y: s.p[1], z: s.p[2] }, true);
      body.setRotation({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] }, true);
      body.setLinvel({ x: s.v[0], y: s.v[1], z: s.v[2] }, true);
      body.setAngvel({ x: s.w[0], y: s.w[1], z: s.w[2] }, true);
    },
  };
}
