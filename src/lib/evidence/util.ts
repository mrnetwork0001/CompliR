import type { Address } from "../types";

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Resolve with `fallback` if `p` has not settled within `ms` (timer is always cleared). */
export async function withTimeout<T>(label: string, p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Like Promise.all(items.map(fn)) but at most `concurrency` in flight. Preserves order. */
export async function pMap<T, R>(items: readonly T[], fn: (item: T, i: number) => Promise<R>, concurrency: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const lower = (a: string): Address => a.toLowerCase() as Address;

/** bigint token amount with `decimals` → decimal string with exactly 6 dp (USDC display precision). */
export function toUsdc6(value: bigint, decimals: number): string {
  let micro: bigint;
  if (decimals >= 6) micro = value / 10n ** BigInt(decimals - 6);
  else micro = value * 10n ** BigInt(6 - decimals);
  const neg = micro < 0n;
  if (neg) micro = -micro;
  const int = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${int}.${frac}`;
}

// ─── RPC politeness: the public Arc endpoints return HTTP 429 / -32005 "rate limit exceeded" on bursts ────

/** message + details + code + status, walking the `cause` chain (viem wraps RPC errors several layers deep) */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    const e = cur as { message?: string; details?: string; shortMessage?: string; code?: unknown; status?: unknown; cause?: unknown };
    for (const v of [e.message, e.details, e.shortMessage, e.code, e.status]) if (v != null) parts.push(String(v));
    cur = e.cause;
  }
  return parts.join(" | ").toLowerCase();
}

export function isRateLimited(err: unknown): boolean {
  const t = errorText(err);
  return t.includes("rate limit") || t.includes("too many requests") || t.includes("-32005") || /\b429\b/.test(t) || t.includes("limit exceeded");
}

/** eth_getLogs range / result caps (Arc public RPC: -32012 ">10,000 blocks", -32602 "max results 2000") */
export function isRangeError(err: unknown): boolean {
  const t = errorText(err);
  return (
    t.includes("range too large") ||
    t.includes("max allowed range") ||
    t.includes("max results") ||
    t.includes("block range") ||
    t.includes("-32012") ||
    t.includes("-32602") ||
    t.includes("query returned more than") ||
    t.includes("too many results")
  );
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry only rate-limit errors, with exponential backoff (+ jitter). Everything else is rethrown at once. */
export async function rpcRetry<T>(fn: () => Promise<T>, opts: { attempts?: number; baseMs?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 200;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1 || !isRateLimited(err)) throw err;
      await sleep(baseMs * 2 ** i + Math.random() * baseMs * 0.5);
    }
  }
}

/** At most `max` tasks in flight and at least `minGapMs` between task starts. */
export class Limiter {
  private active = 0;
  private lastStart = 0;
  private queue: (() => void)[] = [];
  constructor(
    public readonly max: number,
    public readonly minGapMs: number,
  ) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.active--;
      this.pump();
    }
  }
  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }
  private pump() {
    if (this.active >= this.max || this.queue.length === 0) return;
    const wait = this.lastStart + this.minGapMs - Date.now();
    if (wait > 0) {
      setTimeout(() => this.pump(), wait);
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.active++;
    this.lastStart = Date.now();
    next();
    if (this.active < this.max && this.queue.length) setTimeout(() => this.pump(), this.minGapMs);
  }
}

const envNum = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};
/** Process-wide gate for every evidence RPC call (shared across concurrent screenings on purpose). */
export const rpcGate = new Limiter(envNum("EVIDENCE_RPC_CONCURRENCY", 3), envNum("EVIDENCE_RPC_MIN_GAP_MS", 120));
