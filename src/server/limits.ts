/** Small abuse-control helpers for the race server (see docs/server-security.md). */

/** Counts events per key inside a sliding window; `blocked` says whether the key is at its limit. */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private live(key: string, now: number): number[] {
    const xs = this.hits.get(key);
    if (!xs) return [];
    while (xs.length > 0 && now - xs[0] >= this.windowMs) xs.shift();
    if (xs.length === 0) this.hits.delete(key);
    return xs;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.live(key, now).length >= this.max;
  }

  record(key: string, now = Date.now()): void {
    const xs = this.live(key, now);
    if (xs.length === 0) this.hits.set(key, xs);
    xs.push(now);
    // Bound memory under a spray of distinct keys.
    if (this.hits.size > 10_000) for (const k of this.hits.keys()) this.live(k, now);
  }
}

const IP_SHAPE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The address a connection counts against. Without a trusted proxy that is the socket address (X-Forwarded-For is
 * client-controlled and ignored). Behind `hops` trusted proxies (Caddy: 1) each proxy appends the address it saw, so the
 * entry `hops` from the right is the real client and anything to its left is attacker-supplied.
 */
export function clientIp(remote: string, forwardedFor: string | undefined, hops: number): string {
  if (hops <= 0 || !forwardedFor) return remote;
  const parts = forwardedFor.split(',').map((s) => s.trim());
  const ip = parts[parts.length - hops];
  return parts.length >= hops && ip && IP_SHAPE.test(ip) ? ip : remote;
}

interface Sendable {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  terminate(): void;
}

/** Send unless the socket is closed; a client that does not read (its buffer passed `maxBuffered` bytes) is dropped. */
export function guardedSend(ws: Sendable, text: string, maxBuffered: number): void {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > maxBuffered) {
    ws.terminate();
    return;
  }
  ws.send(text);
}
