/**
 * The free verdict served by GET /api/v1/attestation/:address.
 *
 * - Always answers: an address never seen before is screened on demand (same pipeline as the paid screen:
 *   sanctions, Circle blocklist, two-hop funder trace, analyst). First sight takes ~20-60 s; later reads are instant.
 * - Full fields: reasons, recommendedLimits, rationale, eddRequested, edd, nextRescreenAt come from the replayable
 *   decision log entry (already public at /api/v1/decision/:id), so free and paid responses carry the same verdict.
 * - Single-flight: concurrent requests for the same address share one screen instead of running the pipeline twice.
 * - Stale-while-revalidate: an expired verdict (now > attestation.validUntil) is returned immediately with
 *   `expired: true, refreshing: true`, and a re-screen runs in the background; the next read gets the fresh one.
 */
import type { Address, Attestation, Reason, Tier, Verdict } from "./types";
import { getDecisionRow, latestAttestation, type AttestationView } from "./store";
import { eddForDecision } from "./edd";
import { screen } from "./pipeline";

export interface FreeVerdict {
  address: Address;
  score: number;
  tier: Tier;
  reasons: Reason[];
  recommendedLimits: { maxPerTxUsdc: number; maxPerDayUsdc: number } | null;
  rationale: string | null;
  eddRequested: string[];
  edd: { id: string; url: string; status: string } | null;
  nextRescreenAt: string | null;
  attestation: Attestation;
  decisionId: string;
  screenedAt: string;
  /** now > attestation.validUntil: the signature has lapsed (isAllowed() on-chain returns false) and the verdict is due a re-screen */
  expired: boolean;
  /** a background re-screen was started (or is already running) for this address */
  refreshing: boolean;
  /** "store" = latest stored verdict; "fresh" = screened on demand by this request */
  source: "store" | "fresh";
}

const inflight = new Map<string, Promise<Verdict>>();

/** One pipeline run per address at a time; concurrent callers share it. */
export function screenOnce(address: Address, run: (a: Address) => Promise<Verdict> = (a) => screen({ address: a })): Promise<Verdict> {
  const key = address.toLowerCase();
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = run(address).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export function isScreening(address: string): boolean {
  return inflight.has(address.toLowerCase());
}
export function __resetFreeVerdict(): void {
  inflight.clear();
}

type Payload = { reasons?: Reason[]; recommendedLimits?: FreeVerdict["recommendedLimits"]; rationale?: string; eddRequested?: string[]; nextRescreenAt?: number };

async function enrich(v: AttestationView, source: FreeVerdict["source"], refreshing: boolean): Promise<FreeVerdict> {
  const [entry, edd] = await Promise.all([getDecisionRow(v.decisionId).catch(() => null), eddForDecision(v.decisionId).catch(() => null)]);
  const p = (entry?.payload ?? {}) as Payload;
  const nowS = Math.floor(Date.now() / 1000);
  return {
    address: v.address, score: v.score, tier: v.tier,
    reasons: Array.isArray(p.reasons) ? p.reasons : [],
    recommendedLimits: p.recommendedLimits ?? null,
    rationale: p.rationale ?? null,
    eddRequested: Array.isArray(p.eddRequested) ? p.eddRequested : [],
    edd,
    nextRescreenAt: typeof p.nextRescreenAt === "number" ? new Date(p.nextRescreenAt * 1000).toISOString() : null,
    attestation: v.attestation, decisionId: v.decisionId, screenedAt: v.screenedAt,
    expired: nowS > v.attestation.validUntil,
    refreshing,
    source,
  };
}

export interface FreeVerdictDeps {
  /** schedule work after the response is sent (Next's `after`); defaults to fire-and-forget */
  background?: (fn: () => Promise<unknown>) => void;
  run?: (a: Address) => Promise<Verdict>;
}

export async function freeVerdict(address: Address, deps: FreeVerdictDeps = {}): Promise<FreeVerdict> {
  const background = deps.background ?? ((fn) => void fn().catch(() => {}));
  const stored = await latestAttestation(address);
  if (stored) {
    const expired = Math.floor(Date.now() / 1000) > stored.attestation.validUntil;
    let refreshing = isScreening(address);
    if (expired && !refreshing) {
      refreshing = true;
      background(() => screenOnce(address, deps.run).catch((e) => console.warn("[complir] background re-screen failed:", (e as Error)?.message)));
    }
    return enrich(stored, "store", refreshing);
  }
  const v = await screenOnce(address, deps.run);
  const view: AttestationView = { address: v.address, score: v.score, tier: v.tier, attestation: v.attestation, decisionId: v.decisionId, screenedAt: v.screenedAt };
  const out = await enrich(view, "fresh", false);
  // the in-memory verdict is authoritative for a fresh screen (EDD row / ledger are written by the same pipeline run)
  return { ...out, reasons: v.reasons, recommendedLimits: v.recommendedLimits, rationale: v.rationale, eddRequested: v.eddRequested, nextRescreenAt: v.nextRescreenAt, edd: v.edd ? { ...v.edd, status: "OPEN" } : out.edd };
}
