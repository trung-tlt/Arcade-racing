/** Server observability helpers: a fixed-size sample window with percentiles, log levels, Prometheus text. */

/** A ring of the last `capacity` samples. `push` allocates nothing; the percentiles sort a copy when asked. */
export class SampleWindow {
  private readonly buf: Float64Array;
  private next = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  get size(): number {
    return this.filled;
  }

  push(v: number): void {
    this.buf[this.next] = v;
    this.next = (this.next + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /** Nearest-rank percentiles (`qs` in 0..1) and the max, 0 for an empty window. One sort for all of them. */
  stats(qs: readonly number[]): { q: number[]; max: number; mean: number } {
    const n = this.filled;
    if (n === 0) return { q: qs.map(() => 0), max: 0, mean: 0 };
    const xs = this.buf.slice(0, n).sort();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += xs[i];
    return { q: qs.map((q) => xs[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))]), max: xs[n - 1], mean: sum / n };
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** `LOG_LEVEL` text to a level, `info` for anything unknown. */
export function parseLogLevel(s: string | undefined): LogLevel {
  return s !== undefined && s in LEVELS ? (s as LogLevel) : 'info';
}

export function levelEnabled(min: LogLevel, level: Exclude<LogLevel, 'silent'>): boolean {
  return LEVELS[level] >= LEVELS[min];
}

/** One-line JSON log record: `{"at":..., "level":..., "event":..., ...fields}`. */
export function logLine(level: string, event: string, fields?: Record<string, unknown>): string {
  return JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
}

/** Counters and gauges as Prometheus text exposition (one family per entry; labels are pre-rendered by the caller). */
export interface PromSample {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  values: { labels?: Record<string, string>; value: number }[];
}

export function promText(samples: readonly PromSample[]): string {
  const out: string[] = [];
  for (const s of samples) {
    out.push(`# HELP ${s.name} ${s.help}`, `# TYPE ${s.name} ${s.type}`);
    for (const v of s.values) {
      const labels = v.labels
        ? `{${Object.entries(v.labels)
            .map(([k, x]) => `${k}="${x.replace(/[\\"\n]/g, '_')}"`)
            .join(',')}}`
        : '';
      out.push(`${s.name}${labels} ${Number.isFinite(v.value) ? +v.value.toFixed(4) : 0}`);
    }
  }
  return out.join('\n') + '\n';
}
