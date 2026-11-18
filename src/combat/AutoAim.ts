export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface AimTarget {
  id: string;
  pos: V3;
}

/** Soft auto-aim: the target closest to the gun's forward axis inside the cone and range wins; ties → nearer. */
export function pickAimTarget(
  origin: V3,
  forward: V3,
  targets: readonly AimTarget[],
  coneDeg: number,
  rangeM: number,
): { id: string; dir: V3; dist: number } | null {
  const cosCone = Math.cos((coneDeg * Math.PI) / 180);
  let best: { id: string; dir: V3; dist: number; cos: number } | null = null;
  for (const t of targets) {
    const dx = t.pos.x - origin.x;
    const dy = t.pos.y - origin.y;
    const dz = t.pos.z - origin.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6 || dist > rangeM) continue;
    const cos = (dx * forward.x + dy * forward.y + dz * forward.z) / dist;
    if (cos < cosCone) continue;
    const better = !best || cos > best.cos + 1e-9 || (Math.abs(cos - best.cos) <= 1e-9 && dist < best.dist);
    if (better) best = { id: t.id, dir: { x: dx / dist, y: dy / dist, z: dz / dist }, dist, cos };
  }
  return best ? { id: best.id, dir: best.dir, dist: best.dist } : null;
}
