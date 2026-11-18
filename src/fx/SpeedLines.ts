export interface StreakParams {
  count: number;
  /** Streak length as a fraction of the screen half-diagonal. */
  length: number;
  alpha: number;
}

const MAX_STREAKS = 72;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Streak count / length / alpha for an intensity in 0..1 (halved when the user prefers reduced motion). */
export function streakParams(intensity: number, reducedMotion: boolean): StreakParams {
  const i = clamp01(intensity);
  const k = reducedMotion ? 0.5 : 1;
  return {
    count: Math.round(lerp(0, MAX_STREAKS, i) * k),
    length: lerp(0.06, 0.32, i) * k,
    alpha: lerp(0.05, 0.4, i) * k,
  };
}

/** Radial speed streaks from the screen centre, drawn on a pointer-events:none canvas. */
export class SpeedLines {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly angle = new Float32Array(MAX_STREAKS);
  private readonly inner = new Float32Array(MAX_STREAKS);
  private readonly phase = new Float32Array(MAX_STREAKS);
  private readonly speed = new Float32Array(MAX_STREAKS);
  private readonly motion: MediaQueryList | null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private frame = 0;
  private time = 0;
  private drawn = false;
  private readonly onResize = (): void => this.resize();

  constructor(root: HTMLElement) {
    this.canvas.className = 'speed-lines';
    this.canvas.setAttribute('aria-hidden', 'true');
    const st = this.canvas.style;
    st.position = 'fixed';
    st.inset = '0';
    st.width = '100%';
    st.height = '100%';
    st.pointerEvents = 'none';
    st.zIndex = '0'; // append to the stage: above the 3D canvas, painted before the HUD that follows it
    this.ctx = this.canvas.getContext('2d');
    this.motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    for (let i = 0; i < MAX_STREAKS; i++) {
      this.angle[i] = Math.random() * Math.PI * 2;
      this.inner[i] = 0.3 + Math.random() * 0.3;
      this.phase[i] = Math.random();
      this.speed[i] = 1.2 + Math.random() * 1.6;
    }
    root.appendChild(this.canvas);
    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, Math.round(window.innerWidth * this.dpr));
    this.h = Math.max(1, Math.round(window.innerHeight * this.dpr));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.drawn = false;
  }

  update(intensity: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (intensity < 0.02) {
      if (this.drawn) {
        ctx.clearRect(0, 0, this.w, this.h);
        this.drawn = false;
      }
      return;
    }
    this.time += 1 / 60;
    if ((this.frame++ & 1) === 1) return; // redraw at most every other frame

    const p = streakParams(intensity, this.motion?.matches ?? false);
    ctx.clearRect(0, 0, this.w, this.h);
    const cx = this.w / 2;
    const cy = this.h / 2;
    const half = Math.hypot(cx, cy);
    ctx.lineWidth = Math.max(1, 1.5 * this.dpr);
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? `rgba(255,255,255,${p.alpha})` : `rgba(46,197,255,${p.alpha})`;
      ctx.beginPath();
      for (let i = pass; i < p.count; i += 2) {
        const t = (this.time * this.speed[i] * 0.5 + this.phase[i]) % 1;
        const r0 = (this.inner[i] + t * 0.55) * half;
        const r1 = r0 + p.length * half * (0.5 + t);
        const jx = (Math.random() - 0.5) * 0.004;
        const a = this.angle[i] + jx;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        ctx.moveTo(cx + cos * r0, cy + sin * r0);
        ctx.lineTo(cx + cos * r1, cy + sin * r1);
      }
      ctx.stroke();
    }
    this.drawn = true;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.canvas.remove();
  }
}
