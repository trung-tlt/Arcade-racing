/** Seeded PRNG (mulberry32) so network tests are repeatable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LinkConfig {
  /** One-way delay (ms). */
  latencyMs: number;
  /** Extra random delay, uniform in [0, jitterMs]. */
  jitterMs: number;
  /** Probability a message is "lost" and retransmitted: it arrives `rtoMs` late (WebSocket runs on TCP: no loss, but stalls). */
  loss: number;
  rtoMs: number;
}

export const LAN: LinkConfig = { latencyMs: 2, jitterMs: 1, loss: 0, rtoMs: 200 };

interface Pending {
  at: number;
  n: number;
  fn: () => void;
}

/**
 * Deterministic virtual clock and message pipe. Messages on one link are delivered in order (TCP): a delayed message
 * holds up the ones behind it, which is how loss shows up to a WebSocket client.
 */
export class VirtualNet {
  /** Virtual milliseconds. */
  now = 0;
  private readonly queue: Pending[] = [];
  private counter = 0;
  private readonly rand: () => number;

  constructor(seed = 1) {
    this.rand = rng(seed);
  }

  /** A one-way in-order link. */
  link(cfg: LinkConfig): (deliver: () => void) => void {
    let lastAt = 0;
    return (deliver) => {
      const stall = this.rand() < cfg.loss ? cfg.rtoMs : 0;
      let at = this.now + cfg.latencyMs + this.rand() * cfg.jitterMs + stall;
      if (at < lastAt) at = lastAt; // in-order delivery
      lastAt = at;
      this.queue.push({ at, n: this.counter++, fn: deliver });
    };
  }

  /** Deliver everything due at or before the current time. */
  flush(): void {
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i];
        if (
          q.at <= this.now &&
          (best < 0 || q.at < this.queue[best].at || (q.at === this.queue[best].at && q.n < this.queue[best].n))
        )
          best = i;
      }
      if (best < 0) return;
      const [q] = this.queue.splice(best, 1);
      q.fn();
    }
  }
}
