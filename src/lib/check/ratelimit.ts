/**
 * In-memory token bucket per key (client IP). One bucket map per process; good enough for the free /api/v1/check endpoint.
 * `capacity` tokens, refilled at `capacity / windowMs`. Buckets idle for > windowMs are evicted on the next call.
 */
export interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucket {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;
  constructor(
    readonly capacity: number,
    readonly windowMs: number,
  ) {}

  /** Returns { ok, remaining, retryAfterMs }. Consumes one token when ok. */
  take(key: string, now = Date.now()): { ok: boolean; remaining: number; retryAfterMs: number } {
    this.sweep(now);
    const rate = this.capacity / this.windowMs; // tokens per ms
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.updatedAt) * rate);
    b.updatedAt = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
    }
    this.buckets.set(key, b);
    return { ok: false, remaining: 0, retryAfterMs: Math.ceil((1 - b.tokens) / rate) };
  }

  private sweep(now: number) {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (now - b.updatedAt > this.windowMs) this.buckets.delete(k);
  }

  /** test helper */
  reset() {
    this.buckets.clear();
  }
}

/**
 * Client IP behind our nginx. X-Real-IP is set by nginx from $remote_addr and cannot be forged by the client;
 * otherwise use the LAST X-Forwarded-For hop (the one our proxy appended), never the first (client-controlled).
 */
export function clientIp(req: Request): string {
  const h = req.headers;
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((x) => x.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return h.get("cf-connecting-ip") ?? "local";
}
