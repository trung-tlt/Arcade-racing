import { RollingWindow } from '../net/RollingWindow';

/** What `Game` hands the panel on each refresh (cumulative counters; the panel keeps its own window since the last reset). */
export interface NetDebugSample {
  pingMs: number;
  snapGaps: RollingWindow;
  /** How far behind the server clock the other cars are drawn (adapts to jitter). */
  interpMs: number;
  steps: { frames: number; holds: number; catchUps: number };
  margin: number;
  minMargin: number;
  /** Reconcile results that arrived since the previous sample. */
  recon: { kind: string; errM: number }[];
  /** Frames in which any remote car was extrapolated past its newest snapshot, and all frames. */
  extrapFrames: number;
  frames: number;
}

const WIN = 300;

/**
 * F8 shows / hides the network panel, F9 resets its counters and prints a JSON report to the console (and the clipboard
 * when allowed): enough to tell a slow frame rate from a bad connection from the prediction fighting the server.
 */
export class NetDebugPanel {
  private readonly el = document.createElement('div');
  private readonly frameMs = new RollingWindow(WIN);
  private shown = false;
  private startedAt = performance.now();
  private hitches = 0;
  private tally = { smooth: 0, snap: 0, other: 0, maxErrM: 0, bigErr: 0 };
  private base = { holds: 0, catchUps: 0, frames: 0, extrap: 0, allFrames: 0 };
  private last: NetDebugSample | null = null;
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'F8') {
      e.preventDefault();
      this.show(!this.shown);
    } else if (e.key === 'F9') {
      e.preventDefault();
      this.report();
      this.reset();
    }
  };

  constructor(parent: HTMLElement) {
    this.el.className = 'netdebug';
    this.el.hidden = true;
    this.el.setAttribute('aria-hidden', 'true');
    Object.assign(this.el.style, {
      position: 'fixed',
      left: '8px',
      bottom: '8px',
      zIndex: '35',
      pointerEvents: 'none',
      font: '11px/1.35 ui-monospace, Menlo, monospace',
      color: '#cfe8ff',
      background: 'rgba(8,10,14,0.78)',
      border: '1px solid #2a3340',
      borderRadius: '6px',
      padding: '6px 8px',
      whiteSpace: 'pre',
    });
    parent.appendChild(this.el);
    window.addEventListener('keydown', this.onKey);
    if (new URLSearchParams(location.search).has('netdebug')) this.show(true);
  }

  show(on: boolean): void {
    this.shown = on;
    this.el.hidden = !on;
  }

  /** Every rendered frame. A frame over 33 ms is a visible hitch. */
  frame(dtSec: number): void {
    const ms = dtSec * 1000;
    this.frameMs.push(ms);
    if (ms > 33) this.hitches++;
  }

  reset(): void {
    this.startedAt = performance.now();
    this.hitches = 0;
    this.tally = { smooth: 0, snap: 0, other: 0, maxErrM: 0, bigErr: 0 };
    this.frameMs.push(0);
    if (this.last) {
      this.base = {
        holds: this.last.steps.holds,
        catchUps: this.last.steps.catchUps,
        frames: this.last.steps.frames,
        extrap: this.last.extrapFrames,
        allFrames: this.last.frames,
      };
    }
  }

  /** About twice a second. */
  refresh(s: NetDebugSample): void {
    for (const r of s.recon) {
      if (r.kind === 'smooth') this.tally.smooth++;
      else if (r.kind === 'snap') this.tally.snap++;
      else this.tally.other++;
      if (r.errM > this.tally.maxErrM) this.tally.maxErrM = r.errM;
      if (r.errM > 0.5) this.tally.bigErr++;
    }
    this.last = s;
    if (this.shown) this.el.textContent = this.text(s);
  }

  private stats(s: NetDebugSample): Record<string, number> {
    const secs = Math.max(1, (performance.now() - this.startedAt) / 1000);
    const f = this.frameMs;
    const frames = Math.max(1, s.steps.frames - this.base.frames);
    const allFrames = Math.max(1, s.frames - this.base.allFrames);
    return {
      secs: Math.round(secs),
      fps: Math.round(1000 / Math.max(1, f.mean())),
      frameP95Ms: Math.round(f.percentile(0.95)),
      frameMaxMs: Math.round(f.max()),
      hitchesOver33ms: this.hitches,
      pingMs: Math.round(s.pingMs),
      snapGapMeanMs: Math.round(s.snapGaps.mean()),
      snapGapP95Ms: Math.round(s.snapGaps.percentile(0.95)),
      snapGapMaxMs: Math.round(s.snapGaps.max()),
      interpDelayMs: Math.round(s.interpMs),
      margin: s.margin,
      minMargin: s.minMargin,
      holdFrames: s.steps.holds - this.base.holds,
      catchUpFrames: s.steps.catchUps - this.base.catchUps,
      holdPerMin: Math.round(((s.steps.holds - this.base.holds) / secs) * 60),
      catchUpPerMin: Math.round(((s.steps.catchUps - this.base.catchUps) / secs) * 60),
      reconSmooth: this.tally.smooth,
      reconSnap: this.tally.snap,
      reconOver50cm: this.tally.bigErr,
      reconMaxErrM: +this.tally.maxErrM.toFixed(2),
      extrapolatingPct: Math.round(((s.extrapFrames - this.base.extrap) / allFrames) * 100),
      stepFrames: frames,
    };
  }

  private text(s: NetDebugSample): string {
    const x = this.stats(s);
    return [
      `NET   ping ${x.pingMs} ms   snapshots gap mean ${x.snapGapMeanMs} p95 ${x.snapGapP95Ms} max ${x.snapGapMaxMs} ms`,
      `FRAME ${x.fps} fps   p95 ${x.frameP95Ms} ms   max ${x.frameMaxMs} ms   hitches>33ms ${x.hitchesOver33ms}`,
      `LEAD  margin ${x.margin} (min ${x.minMargin})   held ${x.holdFrames}  catch-up ${x.catchUpFrames}  (${x.holdPerMin}/${x.catchUpPerMin} per min)`,
      `RECON smooth ${x.reconSmooth}  snap ${x.reconSnap}  >0.5 m ${x.reconOver50cm}  max ${x.reconMaxErrM} m`,
      `REMOTE drawn ${x.interpDelayMs} ms behind · extrapolating ${x.extrapolatingPct}% of frames     [F8 hide · F9 report+reset] ${x.secs}s`,
    ].join('\n');
  }

  /** The numbers the report prints, for tools (the netlab) that read them instead of the console. */
  snapshot(): Record<string, number> | null {
    return this.last ? this.stats(this.last) : null;
  }

  report(): void {
    if (!this.last) return;
    const json = JSON.stringify({ at: new Date().toISOString(), ...this.stats(this.last) });
    console.log(`[netdebug] ${json}`);
    void navigator.clipboard?.writeText(json).catch(() => undefined);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.report();
    this.el.remove();
  }
}
