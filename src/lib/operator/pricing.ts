/**
 * Operator-controlled x402 pricing. The operator agent may move the screen / watch price, but only inside hard
 * rails that live here (not in the model): absolute bounds per product, at most ±20% per change, at least 6 h
 * between changes. `currentPrice()` is what the paid routes read per request; it falls back to the env prices
 * (PRICE_SCREEN_USDC / PRICE_WATCH_USDC) when the operator has never set one, and never throws.
 *
 * Table `operator_pricing` (own migration on the shared libsql client): one row per key.
 */
import { config } from "../config";
import { db, migrate } from "../store/db";

export type PriceKey = "screen" | "watch";
export const PRICE_KEYS: readonly PriceKey[] = ["screen", "watch"] as const;

/** Absolute USDC bounds per product. */
export const PRICE_BOUNDS: Record<PriceKey, { min: number; max: number }> = {
  screen: { min: 0.005, max: 0.05 },
  watch: { min: 0.02, max: 0.2 },
};
/** Max relative move per change (20%). */
export const MAX_STEP_PCT = 0.2;
/** Min seconds between two changes of the same key (6 h). */
export const MIN_CHANGE_INTERVAL_S = 6 * 3600;

export interface PriceState {
  key: PriceKey;
  priceUsdc: number;
  /** why the price is what it is ("config default" until the operator changes it) */
  reason: string;
  /** unix seconds of the last operator change; null = never changed (config default) */
  changedAt: number | null;
  source: "config" | "operator";
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS operator_pricing (key TEXT PRIMARY KEY, price_usdc REAL NOT NULL, reason TEXT NOT NULL, changed_at INTEGER NOT NULL)`,
];
let migrated: Promise<void> | null = null;
export function migratePricing(): Promise<void> {
  if (!migrated) migrated = (async () => { await migrate(); for (const s of SCHEMA) await db().execute(s); })();
  return migrated;
}

const CACHE_TTL_MS = 5_000;
const cache = new Map<PriceKey, { at: number; state: PriceState }>();
/** test helper */
export function __resetPricing() { migrated = null; cache.clear(); }

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Env default for a key (what the routes charged before the operator existed). */
export function configPrice(key: PriceKey): number {
  try {
    const c = config();
    return key === "screen" ? c.PRICE_SCREEN_USDC : c.PRICE_WATCH_USDC;
  } catch {
    const raw = Number(process.env[key === "screen" ? "PRICE_SCREEN_USDC" : "PRICE_WATCH_USDC"]);
    return Number.isFinite(raw) && raw > 0 ? raw : key === "screen" ? 0.01 : 0.05;
  }
}

/** Current state for a key. Never throws: a DB problem degrades to the config default. */
export async function priceState(key: PriceKey, opts: { fresh?: boolean } = {}): Promise<PriceState> {
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.state;
  const fallback: PriceState = { key, priceUsdc: configPrice(key), reason: "config default", changedAt: null, source: "config" };
  let state = fallback;
  try {
    await migratePricing();
    const r = await db().execute({ sql: `SELECT price_usdc, reason, changed_at FROM operator_pricing WHERE key = ?`, args: [key] });
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (row) {
      const p = Number(row.price_usdc);
      if (Number.isFinite(p) && p > 0) state = { key, priceUsdc: round6(p), reason: String(row.reason ?? ""), changedAt: Number(row.changed_at), source: "operator" };
    }
  } catch (e) {
    console.warn("[operator/pricing] read failed, using config price:", (e as Error)?.message ?? e);
  }
  cache.set(key, { at: Date.now(), state });
  return state;
}

/** The price the x402 gate charges right now (USDC). Never throws. */
export async function currentPrice(key: PriceKey): Promise<number> {
  return (await priceState(key)).priceUsdc;
}

export interface PriceCheck { ok: boolean; reason: string; from: number; to: number }

/**
 * Pure guard: is moving `key` from `from` to `to` allowed right now?
 *   bounds → step (±20% of `from`) → cooldown (6 h since `lastChangeAt`).
 */
export function validatePriceChange(key: PriceKey, from: number, to: number, lastChangeAt: number | null, now = Math.floor(Date.now() / 1000)): PriceCheck {
  const b = PRICE_BOUNDS[key];
  const target = round6(to);
  const base = { from: round6(from), to: target };
  if (!Number.isFinite(target) || target <= 0) return { ok: false, reason: `price must be a positive number (got ${to})`, ...base };
  if (target < b.min || target > b.max) return { ok: false, reason: `${key} price ${target} outside bounds [${b.min}, ${b.max}] USDC`, ...base };
  if (round6(from) === target) return { ok: false, reason: `no change (already ${target})`, ...base };
  const maxUp = round6(from * (1 + MAX_STEP_PCT));
  const maxDown = round6(from * (1 - MAX_STEP_PCT));
  if (target > maxUp + 1e-9 || target < maxDown - 1e-9) {
    return { ok: false, reason: `step ${from} → ${target} exceeds ±${MAX_STEP_PCT * 100}% (allowed ${maxDown}–${maxUp})`, ...base };
  }
  if (lastChangeAt != null && now - lastChangeAt < MIN_CHANGE_INTERVAL_S) {
    const wait = MIN_CHANGE_INTERVAL_S - (now - lastChangeAt);
    return { ok: false, reason: `cooldown: last change ${Math.round((now - lastChangeAt) / 60)} min ago, ${Math.ceil(wait / 60)} min to go (min ${MIN_CHANGE_INTERVAL_S / 3600} h)`, ...base };
  }
  return { ok: true, reason: "ok", ...base };
}

/** Largest allowed price in `direction` from the current state (bounds + step), or null when no move is possible. */
export function steppedPrice(key: PriceKey, from: number, direction: "up" | "down", pct = 0.1): number | null {
  const b = PRICE_BOUNDS[key];
  const factor = direction === "up" ? 1 + Math.min(pct, MAX_STEP_PCT) : 1 - Math.min(pct, MAX_STEP_PCT);
  const target = round6(Math.min(b.max, Math.max(b.min, from * factor)));
  return target === round6(from) ? null : target;
}

export interface SetPriceResult extends PriceCheck { key: PriceKey; changedAt: number | null }

/** Apply a price change after re-running the guard. Returns {ok:false} instead of throwing on a guard failure. */
export async function setPrice(key: PriceKey, priceUsdc: number, reason: string, opts: { now?: number } = {}): Promise<SetPriceResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const cur = await priceState(key, { fresh: true });
  const check = validatePriceChange(key, cur.priceUsdc, priceUsdc, cur.changedAt, now);
  if (!check.ok) return { ...check, key, changedAt: cur.changedAt };
  await migratePricing();
  await db().execute({
    sql: `INSERT INTO operator_pricing (key, price_usdc, reason, changed_at) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET price_usdc = excluded.price_usdc, reason = excluded.reason, changed_at = excluded.changed_at`,
    args: [key, check.to, reason.slice(0, 500), now],
  });
  cache.delete(key);
  return { ...check, key, changedAt: now };
}
