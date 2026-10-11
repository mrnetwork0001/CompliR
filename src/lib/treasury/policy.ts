/**
 * Treasury payout policy + the pure decision function.
 *
 * The agent proposes, the policy decides, and on-chain `GuardedTreasury.release` re-checks
 * `ICompliR.isAllowed(payee, maxTier)` so a wrong agent still cannot pay a HIGH-tier address.
 *
 *   HIGH (or any tier above policy.maxTier)  → HOLD everything
 *   MEDIUM                                   → pay min(amount, analyst maxPerTx, per-payout cap, daily headroom), HOLD the rest
 *   LOW                                      → PAY within the same caps (a cap overrun becomes LIMIT)
 *   attestation missing / expired            → HOLD when policy.requireAttestationOnChain (or when the signed attestation itself expired)
 */
import { TIER_ONCHAIN, type Address, type Tier } from "../types";

export interface TreasuryPolicy {
  /** highest tier the treasury will pay (mirrors GuardedTreasury.maxTier) */
  maxTier: Tier;
  perPayoutCapUsdc: number;
  dailyCapUsdc: number;
  /** HOLD unless the registry on Arc currently holds a valid attestation for the payee */
  requireAttestationOnChain: boolean;
}

export type PayoutAction = "PAY" | "LIMIT" | "HOLD";

/** The subset of a Verdict the decision needs (keeps tests small and the agent decoupled from evidence). */
export interface VerdictLike {
  address: Address;
  tier: Tier;
  score: number;
  decisionId: string;
  rationale: string;
  recommendedLimits: { maxPerTxUsdc: number; maxPerDayUsdc: number };
  attestation: { validUntil: number; registryTx: `0x${string}` | null; signature?: `0x${string}`; attester?: Address };
}

/** What the registry on Arc says about the payee right now (null = not read, e.g. dry-run). */
export interface OnChainAttestation {
  /** ICompliR.Tier value; 0 = UNKNOWN (never attested or revoked) */
  tier: number;
  validUntil: number;
}

export interface PayoutDecision {
  action: PayoutAction;
  /** USDC to release now (0 for HOLD) */
  amount: number;
  /** USDC kept back (invoice amount − amount) */
  held: number;
  /** human reason, always includes the analyst rationale */
  reason: string;
  /** which rule bound the amount (LIMIT) or caused the hold (HOLD) */
  bound: "none" | "tier" | "analyst_max_per_tx" | "per_payout_cap" | "daily_cap" | "attestation_missing" | "attestation_expired";
  verdictRef: { decisionId: string; tier: Tier; score: number; validUntil: number; registryTx: `0x${string}` | null };
}

export const DEFAULT_POLICY: TreasuryPolicy = {
  maxTier: "MEDIUM",
  perPayoutCapUsdc: 25,
  dailyCapUsdc: 50,
  requireAttestationOnChain: false,
};

/** Policy from env (TREASURY_MAX_TIER, TREASURY_PER_PAYOUT_CAP_USDC, TREASURY_DAILY_CAP_USDC, TREASURY_REQUIRE_ONCHAIN). */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env, live = false): TreasuryPolicy {
  const num = (k: string, d: number) => {
    const n = Number(env[k]);
    return Number.isFinite(n) && n >= 0 && env[k] !== undefined && env[k] !== "" ? n : d;
  };
  const tier = (env.TREASURY_MAX_TIER ?? "").toUpperCase();
  const requireRaw = env.TREASURY_REQUIRE_ONCHAIN;
  return {
    maxTier: tier === "LOW" || tier === "MEDIUM" ? tier : DEFAULT_POLICY.maxTier,
    perPayoutCapUsdc: num("TREASURY_PER_PAYOUT_CAP_USDC", DEFAULT_POLICY.perPayoutCapUsdc),
    dailyCapUsdc: num("TREASURY_DAILY_CAP_USDC", DEFAULT_POLICY.dailyCapUsdc),
    // live mode defaults to requiring the registry entry — that is what GuardedTreasury will check anyway
    requireAttestationOnChain: requireRaw === undefined || requireRaw === "" ? live : /^(1|true|yes|on)$/i.test(requireRaw),
  };
}

/** round to USDC's 6 dp, never negative */
export function round6(n: number): number {
  return Math.max(0, Math.round(n * 1e6) / 1e6);
}

export function decidePayout(
  invoice: { amountUsdc: number },
  verdict: VerdictLike,
  policy: TreasuryPolicy,
  spentToday: number,
  opts: { onChain?: OnChainAttestation | null; now?: number } = {},
): PayoutDecision {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const amount = round6(invoice.amountUsdc);
  const verdictRef = { decisionId: verdict.decisionId, tier: verdict.tier, score: verdict.score, validUntil: verdict.attestation.validUntil, registryTx: verdict.attestation.registryTx };
  const why = `${verdict.tier} (score ${verdict.score}). ${verdict.rationale}`.trim();
  const hold = (bound: PayoutDecision["bound"], reason: string): PayoutDecision => ({ action: "HOLD", amount: 0, held: amount, reason, bound, verdictRef });

  // 1. tier gate — the same test GuardedTreasury runs on-chain
  if (TIER_ONCHAIN[verdict.tier] > TIER_ONCHAIN[policy.maxTier]) {
    return hold("tier", `HELD: payee is ${verdict.tier}, policy pays up to ${policy.maxTier}. ${why}`);
  }

  // 2. the signed attestation must still be valid
  if (verdict.attestation.validUntil <= now) {
    return hold("attestation_expired", `HELD: signed attestation expired at ${new Date(verdict.attestation.validUntil * 1000).toISOString()}; re-screen required. ${why}`);
  }

  // 3. optional: the registry on Arc must carry a live entry (what `isAllowed` will read)
  if (policy.requireAttestationOnChain) {
    const oc = opts.onChain;
    if (!oc || oc.tier === 0) return hold("attestation_missing", `HELD: no attestation for payee in the AttestationRegistry on Arc (release would revert). ${why}`);
    if (oc.validUntil <= now) return hold("attestation_expired", `HELD: on-chain attestation expired at ${new Date(oc.validUntil * 1000).toISOString()}. ${why}`);
    if (oc.tier > TIER_ONCHAIN[policy.maxTier]) return hold("tier", `HELD: registry tier ${oc.tier} exceeds policy max ${policy.maxTier}. ${why}`);
  }

  // 4. caps — the smallest wins and names itself
  const dailyHeadroom = round6(policy.dailyCapUsdc - spentToday);
  const candidates: { bound: PayoutDecision["bound"]; cap: number; label: string }[] = [
    { bound: "analyst_max_per_tx", cap: round6(verdict.recommendedLimits.maxPerTxUsdc), label: `analyst per-tx limit ${verdict.recommendedLimits.maxPerTxUsdc} USDC` },
    { bound: "per_payout_cap", cap: round6(policy.perPayoutCapUsdc), label: `per-payout cap ${policy.perPayoutCapUsdc} USDC` },
    { bound: "daily_cap", cap: dailyHeadroom, label: `daily cap ${policy.dailyCapUsdc} USDC (${round6(spentToday)} already spent today)` },
  ];
  let pay = amount;
  let bound: PayoutDecision["bound"] = "none";
  let label = "";
  for (const c of candidates) {
    if (c.cap < pay) { pay = c.cap; bound = c.bound; label = c.label; }
  }
  pay = round6(pay);
  if (pay <= 0) return hold(bound === "none" ? "daily_cap" : bound, `HELD: nothing releasable — ${label || "amount is zero"}. ${why}`);

  const held = round6(amount - pay);
  if (held > 0) {
    return { action: "LIMIT", amount: pay, held, bound, reason: `LIMITED to ${pay} USDC by ${label}; ${held} USDC held. ${why}`, verdictRef };
  }
  return { action: "PAY", amount: pay, held: 0, bound: "none", reason: `PAID ${pay} USDC in full. ${why}`, verdictRef };
}
