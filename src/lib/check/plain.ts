/**
 * Plain-language layer over a Verdict for the consumer face (/check, /a/[address]).
 *
 * Rules (deterministic, no LLM):
 *   HIGH    → headline "Don't pay."            advice = top 1–2 reasons as plain sentences
 *   MEDIUM  → headline "Pay up to N USDC."     advice = top 1–2 reasons (N = recommended max per tx)
 *   LOW     → headline "Safe to pay."          advice = "No sanctions, no blocklist, normal history." or the mild reasons seen
 * Reasons are ranked by weight (desc), CLEAN never counts as a reason. Direct sanctions + USDC blacklist are merged into one
 * sentence because they almost always travel together ("…on the OFAC sanctions list and Circle has blocked it on USDC.").
 */
import type { Reason, ReasonCode, Tier, Verdict } from "../types";

export type CheckSource = "address" | "link" | "invoice";

export interface PlainVerdict {
  headline: string;
  advice: string;
  /** one short mono-style label for chips/metadata: "hold" | "limit" | "pay" */
  action: "hold" | "limit" | "pay";
}

export interface CheckResponse extends PlainVerdict {
  address: Verdict["address"];
  tier: Tier;
  score: number;
  limits: Verdict["recommendedLimits"];
  decisionId: string;
  attestation: Verdict["attestation"];
  screenedAt: string;
  shareUrl: string;
  source: CheckSource;
  /** reason codes, strongest first (for the UI to show "why") */
  reasons: ReasonCode[];
  /** optional extras other modules attach to a Verdict (guarantee/bond, inbound CCTP flags); passed through untouched when present */
  guarantee?: unknown;
  cctp?: unknown;
  /** the full Verdict (evidence, funder graph, rationale) when the caller asked for `full: true` */
  verdict?: Verdict;
}

const OFAC_DATASET = /ofac|sdn/i;

function sanctionsListName(reason: Reason | undefined): string {
  const hits = (reason?.evidence as { hits?: { datasets?: string[] }[] } | undefined)?.hits;
  const datasets = (hits ?? []).flatMap((h) => h.datasets ?? []);
  if (datasets.some((d) => OFAC_DATASET.test(d))) return "the OFAC sanctions list";
  if (datasets.length) return "a sanctions list";
  return "a sanctions list";
}

function hop(reason: Reason): string {
  const h = (reason.evidence as { hop?: number } | undefined)?.hop;
  return h === 2 ? "two hops back" : "directly";
}

/** One plain sentence per reason, written for someone who is about to pay. */
export function reasonSentence(reason: Reason): string {
  const ev = reason.evidence as Record<string, unknown>;
  switch (reason.code) {
    case "SANCTIONS_DIRECT":
      return `This wallet is on ${sanctionsListName(reason)}.`;
    case "USDC_BLACKLISTED":
      return "Circle has blocked this wallet on USDC.";
    case "PROTOCOL_BLOCKLISTED":
      return "Arc has blocked this wallet at the protocol level.";
    case "FUNDER_1HOP_SANCTIONED":
      return "It was funded directly by a sanctioned wallet.";
    case "FUNDER_2HOP_SANCTIONED":
      return "Its funders two hops back include a sanctioned wallet.";
    case "FUNDER_1HOP_BLACKLISTED":
      return "It was funded directly by a wallet Circle has blocked on USDC.";
    case "FUNDER_2HOP_BLACKLISTED":
      return "Its funders two hops back include a wallet Circle has blocked on USDC.";
    case "FRESH_WALLET":
      return "It is a fresh wallet: first seen less than a week ago or fewer than five transactions.";
    case "NO_HISTORY":
      return "It has never transacted on Arc.";
    case "LOOKALIKE_OF_KNOWN_PAYEE":
      return `It looks like one of your known payees${typeof ev.payeeLabel === "string" ? ` (${ev.payeeLabel})` : ""}: a classic address-poisoning pattern.`;
    case "PAYEE_ADDRESS_CHANGED":
      return `The same payee name was paid at a different address before${typeof ev.payeeLabel === "string" ? ` (${ev.payeeLabel})` : ""}.`;
    case "HIGH_CONCENTRATION":
      return `It shares a funder with ${typeof ev.otherPayees === "number" ? ev.otherPayees : "many"} other payees.`;
    case "PRIOR_HIGH_TIER":
      return "CompliR rated it high risk within the last 30 days.";
    case "NETWORK_HELD_ELSEWHERE":
      return "Other CompliR integrators held payments to this wallet in the last week.";
    case "NETWORK_SHARED_FUNDER":
      return "It shares a funder with several of your own payees.";
    case "COMMUNITY_TIP_VERIFIED":
      return "A staked community tip about this wallet was verified.";
    case "CLEAN":
      return "No sanctions, no blocklist, normal history.";
    default:
      return `Flagged: ${String(reason.code).toLowerCase().replace(/_/g, " ")} (${hop(reason)}).`;
  }
}

/** Reasons that matter, strongest first. CLEAN is never a reason to act. */
export function rankedReasons(reasons: Reason[]): Reason[] {
  return reasons.filter((r) => r.code !== "CLEAN").sort((a, b) => b.weight - a.weight);
}

function fmtUsdc(n: number): string {
  return `${Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "0"} USDC`;
}

/** Compose the advice from the top reasons; merges SANCTIONS_DIRECT + USDC_BLACKLISTED into one sentence. */
export function adviceFor(reasons: Reason[], tier: Tier): string {
  const ranked = rankedReasons(reasons);
  if (ranked.length === 0) return "No sanctions, no blocklist, normal history.";
  const codes = new Set(ranked.map((r) => r.code));
  const parts: string[] = [];
  const used = new Set<ReasonCode>();
  if (codes.has("SANCTIONS_DIRECT") && codes.has("USDC_BLACKLISTED")) {
    const s = ranked.find((r) => r.code === "SANCTIONS_DIRECT");
    parts.push(`This wallet is on ${sanctionsListName(s)} and Circle has blocked it on USDC.`);
    used.add("SANCTIONS_DIRECT");
    used.add("USDC_BLACKLISTED");
  }
  for (const r of ranked) {
    if (parts.length >= 2) break;
    if (used.has(r.code)) continue;
    used.add(r.code);
    parts.push(reasonSentence(r));
  }
  if (tier === "LOW" && parts.length) return `${parts.join(" ")} Nothing serious.`;
  return parts.join(" ");
}

export function headlineFor(tier: Tier, limits: Verdict["recommendedLimits"]): string {
  if (tier === "HIGH") return "Don't pay.";
  if (tier === "MEDIUM") return `Pay up to ${fmtUsdc(limits.maxPerTxUsdc)}.`;
  return "Safe to pay.";
}

export function plainVerdict(v: Pick<Verdict, "tier" | "reasons" | "recommendedLimits">): PlainVerdict {
  const action = v.tier === "HIGH" ? "hold" : v.tier === "MEDIUM" ? "limit" : "pay";
  return { headline: headlineFor(v.tier, v.recommendedLimits), advice: adviceFor(v.reasons, v.tier), action };
}

/** Rough strength order of reason codes, used when only codes (no weights/evidence) are at hand - e.g. history rows. */
const CODE_RANK: ReasonCode[] = [
  "SANCTIONS_DIRECT", "USDC_BLACKLISTED", "PROTOCOL_BLOCKLISTED", "FUNDER_1HOP_SANCTIONED", "FUNDER_1HOP_BLACKLISTED", "LOOKALIKE_OF_KNOWN_PAYEE",
  "PRIOR_HIGH_TIER", "NETWORK_HELD_ELSEWHERE", "FUNDER_2HOP_SANCTIONED", "FUNDER_2HOP_BLACKLISTED", "PAYEE_ADDRESS_CHANGED", "COMMUNITY_TIP_VERIFIED",
  "HIGH_CONCENTRATION", "NO_HISTORY", "NETWORK_SHARED_FUNDER", "FRESH_WALLET", "CLEAN",
];
/** Advice from reason codes alone (stored history): same sentences, ranked by CODE_RANK, no evidence detail. */
export function adviceFromCodes(codes: ReasonCode[], tier: Tier): string {
  const reasons: Reason[] = codes.map((code) => ({ code, weight: Math.max(1, 100 - Math.max(0, CODE_RANK.indexOf(code))), evidence: {} }));
  return adviceFor(reasons, tier);
}

/** Headline from tier alone (history rows, metadata) when the reasons are not at hand. */
export function headlineForTier(tier: Tier, maxPerTxUsdc?: number | null): string {
  if (tier === "HIGH") return "Don't pay.";
  if (tier === "MEDIUM") return maxPerTxUsdc != null ? `Pay up to ${fmtUsdc(maxPerTxUsdc)}.` : "Pay with limits.";
  return "Safe to pay.";
}

export function toCheckResponse(v: Verdict, shareUrl: string, source: CheckSource, opts: { full?: boolean } = {}): CheckResponse {
  const plain = plainVerdict(v);
  const extra = v as Verdict & { guarantee?: unknown; cctp?: unknown };
  return {
    ...(extra.guarantee !== undefined ? { guarantee: extra.guarantee } : {}),
    ...(extra.cctp !== undefined ? { cctp: extra.cctp } : {}),
    ...(opts.full ? { verdict: v } : {}),
    ...plain,
    address: v.address,
    tier: v.tier,
    score: v.score,
    limits: v.recommendedLimits,
    decisionId: v.decisionId,
    attestation: v.attestation,
    screenedAt: v.screenedAt,
    shareUrl,
    source,
    reasons: rankedReasons(v.reasons).map((r) => r.code),
  };
}
