export interface Outline {
  /** Closed smooth SVG path through every control point. */
  d: string;
  /** SVG units per metre. */
  scale: number;
  project(x: number, z: number): { x: number; y: number };
  /** A short bar across the road at the first point (the start line). */
  start: { x1: number; y1: number; x2: number; y2: number };
}

/**
 * Fit a closed track (world x/z) into a width × height SVG box with padding, uniform scale, centred.
 * World -Z (north) is up. The path is a Catmull-Rom spline converted to cubic Béziers.
 */
export function buildOutline(
  points: readonly (readonly number[])[],
  width = 760,
  height = 740,
  pad = 70,
  halfBar = 22,
): Outline {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[2]);
    maxZ = Math.max(maxZ, p[2]);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanZ = Math.max(1, maxZ - minZ);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanZ);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanZ * scale) / 2;
  const project = (x: number, z: number): { x: number; y: number } => ({
    x: offX + (x - minX) * scale,
    y: offY + (z - minZ) * scale,
  });

  const n = points.length;
  const P = points.map((p) => project(p[0], p[2]));
  const f = (v: number): string => v.toFixed(1);
  let d = `M${f(P[0].x)} ${f(P[0].y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n];
    const p1 = P[i];
    const p2 = P[(i + 1) % n];
    const p3 = P[(i + 2) % n];
    d += ` C${f(p1.x + (p2.x - p0.x) / 6)} ${f(p1.y + (p2.y - p0.y) / 6)} ${f(p2.x - (p3.x - p1.x) / 6)} ${f(p2.y - (p3.y - p1.y) / 6)} ${f(p2.x)} ${f(p2.y)}`;
  }
  d += ' Z';

  const dx = P[1].x - P[0].x;
  const dy = P[1].y - P[0].y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return {
    d,
    scale,
    project,
    start: {
      x1: P[0].x - nx * halfBar,
      y1: P[0].y - ny * halfBar,
      x2: P[0].x + nx * halfBar,
      y2: P[0].y + ny * halfBar,
    },
  };
}
