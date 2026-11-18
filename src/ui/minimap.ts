const SIZE = 174;
const PAD = 14;
const TRACK_COLOR = '#4a5260';
const PLAYER_COLOR = '#ff6a1a';
const RIVAL_COLOR = '#ff3d6e';
const NIGHT = '#0e1116';

export interface MinimapCar {
  x: number;
  z: number;
  isPlayer: boolean;
  wrecked: boolean;
}

/** Round north-up minimap: static track layer drawn once, car dots redrawn on every update. */
export class Minimap {
  private readonly el = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly track: HTMLCanvasElement;
  private readonly dpr = Math.min(window.devicePixelRatio || 1, 2);
  // World → minimap mapping: sx = cx - x * k, sy = cy - z * k (+Z up, +X left, so the map is not mirrored).
  private cx = 0;
  private cz = 0;
  private k = 1;

  constructor(
    private readonly root: HTMLElement,
    trackPoints: readonly (readonly number[])[],
    roadWidthM: number,
  ) {
    this.el.className = 'minimap';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Minimap of the track with all cars');
    this.canvas.width = SIZE * this.dpr;
    this.canvas.height = SIZE * this.dpr;
    this.el.appendChild(this.canvas);
    root.appendChild(this.el);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Minimap: 2D canvas unavailable');
    this.ctx = ctx;
    this.fit(trackPoints);
    this.track = this.drawTrack(trackPoints, roadWidthM);
  }

  /** Centre on the bounding box and scale so the farthest point fits inside the circle. */
  private fit(pts: readonly (readonly number[])[]): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[2]);
      maxZ = Math.max(maxZ, p[2]);
    }
    this.cx = (minX + maxX) / 2;
    this.cz = (minZ + maxZ) / 2;
    let r = 1;
    for (const p of pts) r = Math.max(r, Math.hypot(p[0] - this.cx, p[2] - this.cz));
    this.k = (SIZE / 2 - PAD) / r;
  }

  private sx(x: number): number {
    return SIZE / 2 - (x - this.cx) * this.k;
  }

  private sy(z: number): number {
    return SIZE / 2 - (z - this.cz) * this.k;
  }

  private drawTrack(pts: readonly (readonly number[])[], roadWidthM: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = SIZE * this.dpr;
    c.height = SIZE * this.dpr;
    const g = c.getContext('2d');
    if (!g) throw new Error('Minimap: 2D canvas unavailable');
    g.scale(this.dpr, this.dpr);
    const n = pts.length;
    const X = (i: number): number => this.sx(pts[((i % n) + n) % n][0]);
    const Y = (i: number): number => this.sy(pts[((i % n) + n) % n][2]);

    // Closed Catmull-Rom → cubic Bézier, so the outline matches the real spline.
    g.beginPath();
    g.moveTo(X(0), Y(0));
    for (let i = 0; i < n; i++) {
      g.bezierCurveTo(
        X(i) + (X(i + 1) - X(i - 1)) / 6,
        Y(i) + (Y(i + 1) - Y(i - 1)) / 6,
        X(i + 1) - (X(i + 2) - X(i)) / 6,
        Y(i + 1) - (Y(i + 2) - Y(i)) / 6,
        X(i + 1),
        Y(i + 1),
      );
    }
    g.closePath();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = TRACK_COLOR;
    g.lineWidth = Math.max(4, roadWidthM * this.k);
    g.stroke();

    // Start line: short tick across the road at spline point 0.
    const tx = X(1) - X(-1);
    const ty = Y(1) - Y(-1);
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    const half = Math.max(5, roadWidthM * this.k * 0.7);
    g.strokeStyle = '#e8ecf2';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(0) - nx * half, Y(0) - ny * half);
    g.lineTo(X(0) + nx * half, Y(0) + ny * half);
    g.stroke();
    return c;
  }

  /** `playerYaw` is rotation about +Y (0 faces +Z); it draws a small heading tick on the player. */
  update(cars: readonly MinimapCar[], playerYaw: number): void {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.track, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Rivals first so the player dot is always on top.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (c.isPlayer !== (pass === 1)) continue;
        const x = this.sx(c.x);
        const y = this.sy(c.z);
        g.globalAlpha = c.wrecked ? 0.35 : 1;
        g.beginPath();
        g.arc(x, y, c.isPlayer ? 6 : 4.5, 0, Math.PI * 2);
        g.fillStyle = c.isPlayer ? PLAYER_COLOR : RIVAL_COLOR;
        g.fill();
        g.lineWidth = c.isPlayer ? 2 : 1.5;
        g.strokeStyle = NIGHT;
        g.stroke();
        if (c.isPlayer && !c.wrecked) {
          // World heading (sin yaw, cos yaw) → screen (-sin, -cos) with this map's axes.
          const hx = -Math.sin(playerYaw);
          const hy = -Math.cos(playerYaw);
          g.beginPath();
          g.moveTo(x + hx * 6, y + hy * 6);
          g.lineTo(x + hx * 12, y + hy * 12);
          g.lineWidth = 3;
          g.strokeStyle = PLAYER_COLOR;
          g.stroke();
        }
      }
    }
    g.globalAlpha = 1;
  }

  dispose(): void {
    this.el.remove();
    void this.root;
  }
}
