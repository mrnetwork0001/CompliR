/**
 * Recommended-limit bands per tier. The analyst may pick any value *within* the band; clampLimits
 * guarantees an LLM can never recommend more than the band allows (or negative / non-numeric values).
 */
import type { Tier } from "../types";

export interface Limits {
  maxPerTxUsdc: number;
  maxPerDayUsdc: number;
}

export const DEFAULT_LIMITS: Record<Tier, Readonly<Limits>> = {
  LOW: { maxPerTxUsdc: 10_000, maxPerDayUsdc: 50_000 },
  MEDIUM: { maxPerTxUsdc: 250, maxPerDayUsdc: 1_000 },
  HIGH: { maxPerTxUsdc: 0, maxPerDayUsdc: 0 },
};

/** Default band for a tier. `amountUsdc` is accepted for symmetry with the analyst API; it never raises the band. */
export function limitsForTier(tier: Tier, amountUsdc?: number): Limits {
  const band = DEFAULT_LIMITS[tier];
  void amountUsdc;
  return { maxPerTxUsdc: band.maxPerTxUsdc, maxPerDayUsdc: band.maxPerDayUsdc };
}

/** True when a single payment of `amountUsdc` fits inside the tier's per-tx band. */
export function amountWithinBand(tier: Tier, amountUsdc: number): boolean {
  return Number.isFinite(amountUsdc) && amountUsdc >= 0 && amountUsdc <= DEFAULT_LIMITS[tier].maxPerTxUsdc;
}

function sanitize(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

/**
 * Clamp proposed limits into [0, band]. Non-finite or missing values fall back to the band ceiling.
 * Also enforces maxPerTx <= maxPerDay. For HIGH both are always 0.
 */
export function clampLimits(tier: Tier, proposed: Partial<Limits> | null | undefined): Limits {
  const band = DEFAULT_LIMITS[tier];
  const perTx = Math.min(band.maxPerTxUsdc, sanitize(proposed?.maxPerTxUsdc, band.maxPerTxUsdc));
  const perDay = Math.min(band.maxPerDayUsdc, sanitize(proposed?.maxPerDayUsdc, band.maxPerDayUsdc));
  return { maxPerTxUsdc: Math.min(perTx, perDay), maxPerDayUsdc: perDay };
}
