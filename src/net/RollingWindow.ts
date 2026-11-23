/** The last `size` samples of a number stream, for cheap mean / percentile / max read-outs (network diagnostics). */
export class RollingWindow {
  private readonly buf: Float64Array;
  private n = 0;
  private i = 0;

  constructor(readonly size: number) {
    this.buf = new Float64Array(size);
  }

  push(v: number): void {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.size;
    if (this.n < this.size) this.n++;
  }

  get count(): number {
    return this.n;
  }

  mean(): number {
    if (this.n === 0) return 0;
    let s = 0;
    for (let k = 0; k < this.n; k++) s += this.buf[k];
    return s / this.n;
  }

  max(): number {
    let m = 0;
    for (let k = 0; k < this.n; k++) if (this.buf[k] > m) m = this.buf[k];
    return m;
  }

  /** The value at fraction `p` (0..1) of the sorted samples; 0 when empty. */
  percentile(p: number): number {
    if (this.n === 0) return 0;
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(p * a.length))];
  }
}
