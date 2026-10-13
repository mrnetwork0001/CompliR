/**
 * Risk-aware routing: a MEDIUM payee is not paid in one LIMITED shot - the agent proposes a *schedule*.
 *
 *   tranche 1  now                 = min(limit, 1/3 of the invoice)          (limit = analyst per-tx cap ∧ policy per-payout cap)
 *   tranche 2  after EDD answered  = min(limit, 1/3)   - the counterparty answered the Enhanced Due Diligence request
 *                                                        AND the re-screen is still ≤ MEDIUM
 *   tranche 3  after 7 quiet days  = the rest (≤ limit) - 7 days since the verdict without a tier change (re-screen ≤ MEDIUM)
 *
 * Anything above 3 × limit stays held. A HIGH re-grade at any check cancels every pending tranche.
 * `planSchedule` is pure; the tick (agent.ts) persists the rows in `invoice_tranches` and releases the due ones.
 */
import type { Tier } from "../types";
import { round6, type TreasuryPolicy, type VerdictLike } from "./policy";

export const QUIET_PERIOD_SECONDS = 7 * 86400;

export type DueCondition =
  | { kind: "now" }
  /** EDD request `eddId` is ANSWERED (or REVIEWED) and the re-screen is at most `maxTier` */
  | { kind: "edd_answered"; eddId: string; maxTier: Tier }
  /** `until` has passed and the payee's tier has not moved above `maxTier` since `plannedTier` (re-screen) */
  | { kind: "quiet_period"; until: number; plannedTier: Tier; maxTier: Tier };

export interface PlannedTranche {
  n: number;
  amountUsdc: number;
  dueCondition: DueCondition;
  /** human sentence for the page */
  label: string;
}

export interface Schedule {
  tranches: PlannedTranche[];
  /** per-tranche limit that bound the amounts */
  limitUsdc: number;
  /** invoice amount not covered by the three tranches (held until re-invoiced) */
  unscheduledUsdc: number;
}

export function describeCondition(c: DueCondition): string {
  switch (c.kind) {
    case "now": return "released now";
    case "edd_answered": return `after the counterparty answers EDD ${c.eddId} and re-screens at most ${c.maxTier}`;
    case "quiet_period": return `after ${new Date(c.until * 1000).toISOString().slice(0, 10)} if the tier has not risen above ${c.maxTier}`;
  }
}

/**
 * Plan the tranche schedule for a MEDIUM verdict. Returns null when the verdict is not MEDIUM (LOW pays in full,
 * HIGH holds) or the payee is above the policy's max tier.
 * @param verdict  needs `edd` (the pipeline attaches it when the analyst requested EDD) and `screenedAt`
 */
export function planSchedule(
  invoice: { amountUsdc: number },
  verdict: VerdictLike & { edd?: { id: string } | null; screenedAt?: string | number },
  policy: TreasuryPolicy,
  opts: { now?: number } = {},
): Schedule | null {
  if (verdict.tier !== "MEDIUM" || policy.maxTier === "LOW") return null;
  const amount = round6(invoice.amountUsdc);
  if (amount <= 0) return null;
  const limit = round6(Math.min(verdict.recommendedLimits.maxPerTxUsdc, policy.perPayoutCapUsdc));
  if (limit <= 0) return null;

  const screenedAt = verdict.screenedAt === undefined ? (opts.now ?? Math.floor(Date.now() / 1000))
    : typeof verdict.screenedAt === "number" ? verdict.screenedAt : Math.floor(new Date(verdict.screenedAt).getTime() / 1000);
  const third = round6(amount / 3);
  const t1 = round6(Math.min(limit, third));
  const t2 = round6(Math.min(limit, third));
  const t3 = round6(Math.min(limit, amount - t1 - t2));
  const until = screenedAt + QUIET_PERIOD_SECONDS;

  // no EDD request was opened (analyst asked no questions) → tranche 2 waits for the quiet period as well
  const c2: DueCondition = verdict.edd?.id ? { kind: "edd_answered", eddId: verdict.edd.id, maxTier: "MEDIUM" } : { kind: "quiet_period", until, plannedTier: "MEDIUM", maxTier: "MEDIUM" };
  const c3: DueCondition = { kind: "quiet_period", until, plannedTier: "MEDIUM", maxTier: "MEDIUM" };

  const c1: DueCondition = { kind: "now" };
  const tranches: PlannedTranche[] = [
    { n: 1, amountUsdc: t1, dueCondition: c1, label: describeCondition(c1) },
    { n: 2, amountUsdc: t2, dueCondition: c2, label: describeCondition(c2) },
    { n: 3, amountUsdc: t3, dueCondition: c3, label: describeCondition(c3) },
  ].filter((t) => t.amountUsdc > 0);
  const scheduled = round6(tranches.reduce((s, t) => s + t.amountUsdc, 0));
  return { tranches, limitUsdc: limit, unscheduledUsdc: round6(amount - scheduled) };
}

/** Is `tier` at most `maxTier`? */
export function tierWithin(tier: Tier, maxTier: Tier): boolean {
  const order: Record<Tier, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
  return order[tier] <= order[maxTier];
}
