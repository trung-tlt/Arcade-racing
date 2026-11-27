import * as THREE from 'three';

type Json = Record<string, unknown>;

const wrap = (t: number): number => ((t % 1) + 1) % 1;

/**
 * The game stages the grid behind t = 0 and counts laps there, but the Map 7 design puts the spline's origin on the
 * back straight and the start line at `startLine.t` (0.057, the middle of the pit straight). With `rotateToStartLine`
 * set in the JSON the spline is rotated to begin at the control point nearest that line, and every along-track `t` in
 * the data moves with it, so the grid, the gantry, the pits and the lap line all agree. `startShiftT` records the shift
 * (a design `t` is `new t + startShiftT`), for the placements, which keep their world coordinates but list design `t`s.
 */
export function rotateToStartLine<T extends Json>(raw: T): T {
  const line = raw.startLine as { t?: number; pitLane?: { entryT?: number; exitT?: number } } | undefined;
  const spline = raw.spline as { points?: number[][] } | undefined;
  if (!raw.rotateToStartLine || !line?.t || !spline?.points) return raw;
  const pts = spline.points;
  const n = pts.length;
  // Arc-length fraction of every control point of the closed curve.
  const curve = new THREE.CatmullRomCurve3(
    pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    true,
    'catmullrom',
    0.5,
  );
  const per = 4;
  curve.arcLengthDivisions = n * per;
  const lens = curve.getLengths(n * per);
  const total = lens[lens.length - 1];
  let k = 0;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(lens[i * per] / total - line.t);
    if (d < best) {
      best = d;
      k = i;
    }
  }
  const shift = lens[k * per] / total;
  const out = structuredClone(raw) as Json;
  (out.spline as { points: number[][] }).points = [...pts.slice(k), ...pts.slice(0, k)];
  out.startShiftT = shift;
  const mv = (o: Json, key: string): void => {
    if (typeof o[key] === 'number') o[key] = wrap((o[key] as number) - shift);
  };
  const each = (list: unknown, ...keys: string[]): void => {
    if (!Array.isArray(list)) return;
    for (const item of list as Json[]) for (const key of keys) mv(item, key);
  };
  each(out.checkpoints, 't');
  each(out.pickups, 't');
  each(out.corners, 't');
  each(out.noFireZones, 'fromT', 'toT');
  each(out.width, 'fromT');
  if (Array.isArray(out.width)) (out.width as { fromT: number }[]).sort((a, b) => a.fromT - b.fromT);
  const kerbs = (out.road as { kerbs?: { segments?: unknown } } | undefined)?.kerbs;
  each(kerbs?.segments, 't');
  const co = out.crossover as Json | undefined;
  if (co) {
    mv(co, 'upperT');
    mv(co, 'lowerT');
  }
  const sl = out.startLine as { t: number; pitLane?: Json };
  sl.t = 0;
  if (sl.pitLane) {
    mv(sl.pitLane, 'entryT');
    mv(sl.pitLane, 'exitT');
  }
  return out as T;
}
