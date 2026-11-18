export const STEP = 1 / 60;
const MAX_FRAME_DT = 0.1;
const MAX_STEPS_PER_FRAME = 6;

export class Loop {
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;

  constructor(
    private readonly step: (dt: number) => void,
    private readonly render: (alpha: number, frameDt: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min((now - this.last) / 1000, MAX_FRAME_DT);
    this.last = now;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS_PER_FRAME) {
      this.step(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.acc = 0;
    this.render(this.acc / STEP, dt);
  };
}
