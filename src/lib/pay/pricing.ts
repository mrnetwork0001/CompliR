/**
 * USDC amount helpers. USDC has 6 decimals; x402 `amount` / EIP-3009 `value` are atomic-unit decimal strings.
 * All conversions go through strings so 0.01 never becomes 9999 or 10000.000001.
 */
export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

/** "0.01" | 0.01 → 10000n. Rejects negatives, NaN, and more than 6 decimal places. */
export function usdcToAtomic(amount: number | string): bigint {
  const s = typeof amount === "number" ? numberToDecimalString(amount) : amount.trim();
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(s);
  if (!m) throw new Error(`pricing: invalid USDC amount "${amount}" (max ${USDC_DECIMALS} decimals, non-negative)`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  return whole * SCALE + frac;
}

/** 10000n | "10000" → "0.01" (trailing zeros trimmed, at least one digit after the point when fractional). */
export function atomicToUsdc(atomic: bigint | string): string {
  const v = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  if (v < 0n) throw new Error("pricing: negative atomic amount");
  const whole = v / SCALE;
  const frac = (v % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Atomic-unit decimal string as x402 expects in `amount` / `authorization.value`. */
export function usdcToAmountString(amount: number | string): string {
  return usdcToAtomic(amount).toString();
}

function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`pricing: invalid USDC amount ${n}`);
  // toFixed(6) is exact enough for a price config; we then validate the string form.
  return n.toFixed(USDC_DECIMALS);
}
