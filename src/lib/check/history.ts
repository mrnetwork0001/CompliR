/**
 * Public per-address history for /a/[address] and GET /api/v1/address/[address].
 * Reads the `screenings` + `attestations` tables (joined on decision_id), TIER_CHANGE ledger entries and open EDD requests.
 * Client ids are never returned: only the payer class (own / outside / unknown).
 */
import { db, migrate, classifyPayer, type PayerKind } from "../store";
import { config } from "../config";
import { adviceFromCodes, headlineForTier } from "./plain";
import type { Address, ReasonCode, Tier } from "../types";

export interface HistoryVerdict {
  decisionId: string;
  screenedAt: string; // ISO
  tier: Tier;
  score: number;
  reasonCodes: ReasonCode[];
  /** who asked: client class only, never an id */
  requester: PayerKind;
  attester: Address | null;
  registryTx: `0x${string}` | null;
  validUntil: string | null; // ISO
  /** true when this verdict's tier differs from the previous one in time */
  tierChanged: boolean;
}
export interface HistoryTierChange {
  at: string; // ISO
  from: Tier | null;
  to: Tier;
  decisionId: string | null;
  /** "verdict" = seen in the public timeline; "watch" = pushed to a watcher's webhook (TIER_CHANGE ledger entry) */
  via: "verdict" | "watch";
  trigger?: string;
}
export interface HistoryEdd {
  id: string;
  url: string;
  createdAt: string;
  questions: number;
}
export interface AddressHistory {
  address: Address;
  latest: {
    decisionId: string;
    tier: Tier;
    score: number;
    screenedAt: string;
    headline: string;
    /** plain-language advice rebuilt from the stored reason codes (no evidence detail) */
    advice: string;
    attester: Address | null;
    registryTx: `0x${string}` | null;
    validUntil: string | null;
    expired: boolean;
  } | null;
  verdicts: HistoryVerdict[];
  tierChanges: HistoryTierChange[];
  openEdd: HistoryEdd[];
  counts: { verdicts: number; high: number; medium: number; low: number; outsideRequests: number };
  firstSeenAt: string | null;
  anonymised: true;
  generatedAt: string;
}

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (v == null ? null : String(v));

export async function addressHistory(address: Address, opts: { limit?: number } = {}): Promise<AddressHistory> {
  await migrate();
  const a = address.toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const d = db();
  const [rows, changes, edd] = await Promise.all([
    d.execute({
      sql: `SELECT s.decision_id, s.created_at, s.tier, s.score, s.reason_codes, s.payer, s.client_id,
                   a.attester, a.registry_tx, a.valid_until, a.issued_at
            FROM screenings s LEFT JOIN attestations a ON a.decision_id = s.decision_id
            WHERE s.subject = ? ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
      args: [a, limit],
    }),
    d.execute({ sql: `SELECT payload, created_at FROM decisions WHERE subject = ? AND kind = 'TIER_CHANGE' ORDER BY seq DESC LIMIT 50`, args: [a] }),
    d.execute({ sql: `SELECT id, questions, created_at FROM edd_requests WHERE subject = ? AND status = 'OPEN' ORDER BY created_at DESC LIMIT 20`, args: [a] }).catch(() => ({ rows: [] as Record<string, unknown>[] })),
  ]);

  // newest first from SQL; walk oldest→newest to mark tier changes
  const asc = [...rows.rows].reverse() as Record<string, unknown>[];
  let prev: Tier | null = null;
  const verdictsAsc: HistoryVerdict[] = [];
  const tierChanges: HistoryTierChange[] = [];
  for (const x of asc) {
    const tier = String(x.tier) as Tier;
    const changed = prev !== null && prev !== tier;
    const item: HistoryVerdict = {
      decisionId: String(x.decision_id),
      screenedAt: iso(num(x.created_at)),
      tier,
      score: num(x.score),
      reasonCodes: safeJson<ReasonCode[]>(x.reason_codes, []),
      requester: (str(x.payer) as PayerKind | null) ?? classifyPayer(str(x.client_id)),
      attester: (str(x.attester) as Address | null),
      registryTx: str(x.registry_tx) as `0x${string}` | null,
      validUntil: x.valid_until == null ? null : iso(num(x.valid_until)),
      tierChanged: changed,
    };
    if (changed) tierChanges.push({ at: item.screenedAt, from: prev, to: tier, decisionId: item.decisionId, via: "verdict" });
    prev = tier;
    verdictsAsc.push(item);
  }
  for (const c of changes.rows as Record<string, unknown>[]) {
    const p = safeJson<{ from?: Tier | null; to?: Tier; decisionId?: string; trigger?: string }>(c.payload, {});
    if (!p.to) continue;
    tierChanges.push({ at: iso(num(c.created_at)), from: p.from ?? null, to: p.to, decisionId: p.decisionId ?? null, via: "watch", ...(p.trigger ? { trigger: p.trigger } : {}) });
  }
  tierChanges.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));

  const verdicts = [...verdictsAsc].reverse();
  const latestRow = verdicts[0] ?? null;
  const nowS = Math.floor(Date.now() / 1000);
  const base = config().PUBLIC_BASE_URL.replace(/\/$/, "");
  return {
    address: a as Address,
    latest: latestRow
      ? {
          decisionId: latestRow.decisionId, tier: latestRow.tier, score: latestRow.score, screenedAt: latestRow.screenedAt,
          headline: headlineForTier(latestRow.tier), advice: adviceFromCodes(latestRow.reasonCodes, latestRow.tier), attester: latestRow.attester, registryTx: latestRow.registryTx, validUntil: latestRow.validUntil,
          expired: latestRow.validUntil != null && Date.parse(latestRow.validUntil) / 1000 < nowS,
        }
      : null,
    verdicts,
    tierChanges,
    openEdd: (edd.rows as Record<string, unknown>[]).map((r) => ({ id: String(r.id), url: `${base}/edd/${String(r.id)}`, createdAt: iso(num(r.created_at)), questions: safeJson<string[]>(r.questions, []).length })),
    counts: {
      verdicts: verdicts.length,
      high: verdicts.filter((v) => v.tier === "HIGH").length,
      medium: verdicts.filter((v) => v.tier === "MEDIUM").length,
      low: verdicts.filter((v) => v.tier === "LOW").length,
      outsideRequests: verdicts.filter((v) => v.requester === "outside").length,
    },
    firstSeenAt: verdictsAsc[0]?.screenedAt ?? null,
    anonymised: true,
    generatedAt: new Date().toISOString(),
  };
}

function safeJson<T>(v: unknown, fallback: T): T {
  try {
    return v == null ? fallback : (JSON.parse(String(v)) as T);
  } catch {
    return fallback;
  }
}
