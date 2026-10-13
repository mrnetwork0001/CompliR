/**
 * Compaction of CompliR responses for LLM context windows.
 * A raw Verdict carries the full 2-hop funder graph (easily 20–100 KB); an agent deciding whether to pay needs
 * the decision, the limits, the reason codes, the attestation and a handful of paths, not every hop.
 */
import type { Attestation, Tier, Verdict } from "../../sdk/src/index";

export interface CompactPath {
  hop: 1 | 2;
  /** funder → … → subject */
  path: string[];
  amountUsdc: string | null;
  flags: string[];
}
export interface CompactEvidence {
  subject?: { firstSeen: number | null; txCount: number; usdcBlacklisted: boolean; protocolBlocklisted: boolean; sanctionsHits: number; sanctions?: unknown[] };
  funders: { total: number; hop1: number; hop2: number; flagged: number; topPaths: CompactPath[] };
  lookalikes?: unknown[];
  payeeChanged?: unknown;
  concentration?: unknown;
  priorTier?: unknown;
  depth?: number;
}
export interface CompactVerdict {
  address: string;
  decisionId: string;
  tier: Tier;
  score: number;
  recommendedLimits: { maxPerTxUsdc: number; maxPerDayUsdc: number };
  reasons: { code: string; weight: number; evidence?: unknown }[];
  rationale: string;
  eddRequested: string[];
  edd: { id: string; url: string } | null;
  nextRescreenAt: string;
  screenedAt: string;
  attestation: Attestation;
  evidence: CompactEvidence | null;
  /** Payment receipt (x402) if this call was paid through the SDK. */
  payment?: { transaction: string; network: string; amount?: string } | null;
}

const TOP_PATHS = 3;

type AnyFacts = { firstSeen?: number | null; txCount?: number; usdcBlacklisted?: boolean; protocolBlocklisted?: boolean; sanctions?: unknown[] };
type AnyFunder = { hop?: 1 | 2; path?: { from?: string; to?: string; amountUsdc?: string }[]; facts?: AnyFacts };

function flagsOf(f: AnyFacts | undefined): string[] {
  const flags: string[] = [];
  if (!f) return flags;
  if (Array.isArray(f.sanctions) && f.sanctions.length > 0) flags.push("SANCTIONED");
  if (f.usdcBlacklisted) flags.push("USDC_BLACKLISTED");
  if (f.protocolBlocklisted) flags.push("PROTOCOL_BLOCKLISTED");
  return flags;
}

export function compactFunders(funders: unknown): CompactEvidence["funders"] {
  const list = Array.isArray(funders) ? (funders as AnyFunder[]) : [];
  const ranked = list
    .map((f) => {
      const hops = Array.isArray(f.path) ? f.path : [];
      const path = hops.length ? [hops[0].from ?? "?", ...hops.map((h) => h.to ?? "?")] : [];
      const amount = hops[0]?.amountUsdc ?? null;
      return { hop: (f.hop === 2 ? 2 : 1) as 1 | 2, path, amountUsdc: amount, flags: flagsOf(f.facts) };
    })
    .sort((a, b) => b.flags.length - a.flags.length || Number(b.amountUsdc ?? 0) - Number(a.amountUsdc ?? 0));
  return {
    total: list.length,
    hop1: list.filter((f) => f.hop !== 2).length,
    hop2: list.filter((f) => f.hop === 2).length,
    flagged: ranked.filter((p) => p.flags.length > 0).length,
    topPaths: ranked.slice(0, TOP_PATHS),
  };
}

export function compactEvidence(evidence: unknown): CompactEvidence | null {
  if (!evidence || typeof evidence !== "object") return null;
  const e = evidence as Record<string, unknown>;
  const subject = e.subject as AnyFacts | undefined;
  const out: CompactEvidence = { funders: compactFunders(e.funders) };
  if (subject) {
    out.subject = {
      firstSeen: subject.firstSeen ?? null,
      txCount: subject.txCount ?? 0,
      usdcBlacklisted: Boolean(subject.usdcBlacklisted),
      protocolBlocklisted: Boolean(subject.protocolBlocklisted),
      sanctionsHits: Array.isArray(subject.sanctions) ? subject.sanctions.length : 0,
    };
    if (Array.isArray(subject.sanctions) && subject.sanctions.length) out.subject.sanctions = trim(subject.sanctions) as unknown[];
  }
  if (Array.isArray(e.lookalikes) && e.lookalikes.length) out.lookalikes = trim(e.lookalikes) as unknown[];
  if (e.payeeChanged) out.payeeChanged = e.payeeChanged;
  if (e.concentration) out.concentration = e.concentration;
  if (e.priorTier) out.priorTier = e.priorTier;
  if (typeof e.depth === "number") out.depth = e.depth;
  return out;
}

/** Generic size limiter for free-form evidence objects: short arrays, short strings, shallow nesting. */
export function trim(value: unknown, opts: { maxArray?: number; maxString?: number; maxDepth?: number; maxKeys?: number } = {}, depth = 0): unknown {
  const { maxArray = 4, maxString = 160, maxDepth = 3, maxKeys = 16 } = opts;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  if (typeof value !== "object") return value;
  if (depth >= maxDepth) return Array.isArray(value) ? `[${value.length} items]` : "{…}";
  if (Array.isArray(value)) {
    const head = value.slice(0, maxArray).map((v) => trim(v, opts, depth + 1));
    return value.length > maxArray ? [...head, `…+${value.length - maxArray} more`] : head;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries.slice(0, maxKeys)) out[k] = trim(v, opts, depth + 1);
  if (entries.length > maxKeys) out["…"] = `+${entries.length - maxKeys} keys`;
  return out;
}

export function compactVerdict(v: Verdict & { edd?: { id: string; url: string } | null }): CompactVerdict {
  return {
    address: v.address,
    decisionId: v.decisionId,
    tier: v.tier,
    score: v.score,
    recommendedLimits: v.recommendedLimits,
    reasons: (v.reasons ?? []).map((r) => ({ code: r.code, weight: r.weight, ...(r.evidence && Object.keys(r.evidence).length ? { evidence: trim(r.evidence) } : {}) })),
    rationale: v.rationale,
    eddRequested: v.eddRequested ?? [],
    edd: v.edd ? { id: v.edd.id, url: v.edd.url } : null,
    nextRescreenAt: v.nextRescreenAt,
    screenedAt: v.screenedAt,
    attestation: v.attestation,
    evidence: compactEvidence(v.evidence),
  };
}

/** Decision-log entries embed a Verdict payload; strip its evidence the same way. */
export function compactDecision(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const e = { ...(entry as Record<string, unknown>) };
  const p = e.payload as Record<string, unknown> | undefined;
  if (p && typeof p === "object" && "evidence" in p) e.payload = { ...p, evidence: compactEvidence(p.evidence) };
  else if (p && typeof p === "object") e.payload = trim(p, { maxDepth: 4 });
  return e;
}

/** Shadow report → entries (already small) + summary + paymentsAtRisk; cap entries to keep it bounded. */
export function compactShadow(result: unknown, maxEntries = 60): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as { entries?: unknown[]; summary?: unknown; paymentsAtRisk?: unknown[] };
  const entries = Array.isArray(r.entries) ? r.entries : [];
  return {
    summary: r.summary ?? null,
    entries: entries.slice(0, maxEntries),
    ...(entries.length > maxEntries ? { entriesTruncated: entries.length - maxEntries } : {}),
    paymentsAtRisk: Array.isArray(r.paymentsAtRisk) ? r.paymentsAtRisk.slice(0, maxEntries) : [],
  };
}
