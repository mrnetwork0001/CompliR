/**
 * Tip Market - storage. A paid, two-sided market for risk intelligence:
 * anyone submits evidence that an address is risky, stakes a little USDC (the x402 payment IS the stake),
 * and gets paid per VERIFIED tip; bad tips lose the stake (it was already settled to X402_PAY_TO).
 *
 * Own tables on the shared libsql client (src/lib/store/db.ts); the core schema stays untouched.
 *   tips          one row per submission (status machine below)
 *   tip_stats     per-submitter counters + reputation (0–1, Laplace-smoothed verified/(verified+rejected))
 *   tip_overrides VERIFIED tips as oracle evidence - read by `tipEvidenceFor(address)` (hook for evidence/collect.ts)
 *   tip_spend     daily payout accounting for TIPS_DAILY_CAP_USDC
 *
 * Status machine: SUBMITTED → VERIFYING → VERIFIED → PAID
 *                                     ↘ REJECTED (stake 0) / SLASHED (stake kept)
 *                                     ↘ NEEDS_REVIEW → (human) VERIFIED | REJECTED/SLASHED
 */
import { keccak256, stringToHex } from "viem";
import { z } from "zod";
import { db, migrate } from "../store/db";
import { AddressSchema, type Address, type ReasonCode, type Tier } from "../types";

// ─── Enums / constants ───────────────────────────────────────────────────────
export const TIP_CATEGORIES = ["sanctions", "mixer", "scam", "poisoning", "stolen_funds", "other"] as const;
export type TipCategory = (typeof TIP_CATEGORIES)[number];
export const TIP_STATUSES = ["SUBMITTED", "VERIFYING", "VERIFIED", "REJECTED", "PAID", "RECORDED", "SLASHED", "NEEDS_REVIEW"] as const;
export type TipStatus = (typeof TIP_STATUSES)[number];
export type TipDecision = "VERIFIED" | "REJECTED" | "NEEDS_REVIEW";

/** Bounty multiplier per category (sanctions intel is worth the most; poisoning protects payees directly). */
export const CATEGORY_MULTIPLIER: Record<TipCategory, number> = { sanctions: 2, poisoning: 1.5, mixer: 1, scam: 1, stolen_funds: 1, other: 1 };

/** Strong-corroboration domains for sanctions claims (hostname equals or ends with one of these). */
export const STRONG_URL_DOMAINS = ["ofac.treasury.gov", "sanctionssearch.ofac.treas.gov", "opensanctions.org", "europa.eu", "gov.uk"] as const;

export const TIPS_CLIENT_ID = "tips"; // already in store INTERNAL_CLIENT_IDS
export const DEMO_SUBMITTER = "demo";
export const ANON_SUBMITTER = "anonymous";
/** Demo subject (synthetic HIGH in .data/overrides.json). */
export const DEMO_SUBJECT = "0x098b716b8aaf21512996dc57eb0615e2383e2f96" as Address; // Ronin Bridge exploiter (Lazarus Group): real OFAC SDN + JP MOF listing

// ─── Env ─────────────────────────────────────────────────────────────────────
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};
export function tipsEnv() {
  const e = process.env;
  return {
    stakeUsdc: num(e.TIPS_STAKE_USDC, 0.05),
    bountyUsdc: num(e.TIP_BOUNTY_USDC, 0.25),
    dailyCapUsdc: num(e.TIPS_DAILY_CAP_USDC, 5),
    payoutPrivateKey: /^0x[0-9a-fA-F]{64}$/.test(e.TIPS_PAYOUT_PRIVATE_KEY ?? "") ? (e.TIPS_PAYOUT_PRIVATE_KEY as `0x${string}`) : undefined,
    /** how long an API tip may wait for its x402 stake to show up in `payments` before it is dropped */
    stakeGraceSeconds: num(e.TIPS_STAKE_GRACE_SECONDS, 600),
  };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────
const TxHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte tx hash").transform((s) => s.toLowerCase() as `0x${string}`);
const HttpUrl = z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), "http(s) URLs only");

export const NewTipSchema = z.object({
  subject: AddressSchema,
  category: z.enum(TIP_CATEGORIES),
  claim: z.string().trim().min(10, "say what you saw (≥ 10 chars)").max(2000),
  evidenceUrls: z.array(HttpUrl).max(5).default([]),
  evidenceTxs: z.array(TxHash).max(10).default([]),
});
export type NewTip = z.infer<typeof NewTipSchema>;

export const ReviewSchema = z.object({
  review: z.string().regex(/^tip_[a-z0-9]+$/),
  decision: z.enum(["VERIFIED", "REJECTED"]),
  note: z.string().trim().max(500).optional(),
});
export type ReviewInput = z.infer<typeof ReviewSchema>;

// ─── Types ───────────────────────────────────────────────────────────────────
export interface TxCorroboration { hash: `0x${string}`; found: boolean; involvesSubject: boolean; blockNumber: number | null }
export interface UrlCorroboration { url: string; domain: string | null; strong: boolean }
/** What the verifier recorded. Deliberately contains NO client data and NO evidence bundle - it is shown to the submitter. */
export interface TipVerification {
  tier: Tier | null;
  score: number | null;
  /** re-screen decision id (replayable at /log/{id}) */
  decisionId: string | null;
  reasonCodes: ReasonCode[];
  corroboration: { txs: TxCorroboration[]; urls: UrlCorroboration[]; strong: number; weak: number };
  decision: TipDecision;
  reason: string;
  /** "agent" (deterministic checks) or "human" (operator override) */
  by: "agent" | "human";
  verifiedAt: number;
  error?: string;
}

export interface Tip {
  id: string;
  subject: Address;
  category: TipCategory;
  claim: string;
  evidenceUrls: string[];
  evidenceTxs: `0x${string}`[];
  /** x402 payer address, "demo" (same-origin browser) or "anonymous" (x402 disabled) */
  submitter: string;
  stakeUsdc: number;
  /** settlement tx of the stake (from the `payments` table), null for unstaked / not yet matched */
  stakeTx: string | null;
  status: TipStatus;
  verification: TipVerification | null;
  payoutUsdc: number;
  payoutTx: `0x${string}` | null;
  payoutMode: PayoutMode | null;
  /** ledger entry ids (kind TIP) for submit / verify / pay / slash */
  ledger: Partial<Record<"submit" | "verify" | "pay" | "slash" | "review", string>>;
  createdAt: number;
  decidedAt: number | null;
  paidAt: number | null;
}
export type PayoutMode = "circle" | "local" | "dry-run";

export interface TipStats {
  submitter: string;
  submitted: number;
  verified: number;
  rejected: number;
  earnedUsdc: number;
  /** 0–1 */
  reputation: number;
  updatedAt: number;
}

/** A VERIFIED tip as oracle evidence (what `tipEvidenceFor` returns). */
export interface TipEvidence {
  tipId: string;
  subject: Address;
  category: TipCategory;
  strength: "strong" | "weak";
  tierAtVerification: Tier | null;
  summary: string;
  verifiedAt: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tips (
     id TEXT PRIMARY KEY, subject TEXT NOT NULL, category TEXT NOT NULL, claim TEXT NOT NULL,
     evidence_urls TEXT NOT NULL DEFAULT '[]', evidence_txs TEXT NOT NULL DEFAULT '[]',
     submitter TEXT NOT NULL, stake_usdc REAL NOT NULL DEFAULT 0, stake_tx TEXT,
     status TEXT NOT NULL DEFAULT 'SUBMITTED', verification TEXT,
     payout_usdc REAL NOT NULL DEFAULT 0, payout_tx TEXT, payout_mode TEXT, ledger TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL, decided_at INTEGER, paid_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS tips_status ON tips(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS tips_subject ON tips(subject, created_at)`,
  `CREATE INDEX IF NOT EXISTS tips_submitter ON tips(submitter, created_at)`,
  `CREATE TABLE IF NOT EXISTS tip_stats (
     submitter TEXT PRIMARY KEY, submitted INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0,
     rejected INTEGER NOT NULL DEFAULT 0, earned_usdc REAL NOT NULL DEFAULT 0, reputation REAL NOT NULL DEFAULT 0.5,
     updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tip_overrides (
     tip_id TEXT PRIMARY KEY, subject TEXT NOT NULL, category TEXT NOT NULL, strength TEXT NOT NULL,
     tier_at_verification TEXT, summary TEXT NOT NULL, verified_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tip_overrides_subject ON tip_overrides(subject, verified_at)`,
  `CREATE TABLE IF NOT EXISTS tip_spend (day TEXT PRIMARY KEY, spent_usdc REAL NOT NULL DEFAULT 0, payouts INTEGER NOT NULL DEFAULT 0)`,
];

let migrated: Promise<void> | null = null;
export function migrateTips(): Promise<void> {
  if (!migrated) migrated = (async () => { await migrate(); for (const s of SCHEMA) await db().execute(s); })();
  return migrated;
}
/** test helper */
export function __resetTips() { migrated = null; }

// ─── Helpers ─────────────────────────────────────────────────────────────────
const nowS = () => Math.floor(Date.now() / 1000);
const str = (v: unknown) => (v == null ? null : String(v));
const numv = (v: unknown) => Number(v ?? 0);
const json = <T,>(v: unknown, d: T): T => { try { return v == null ? d : (JSON.parse(String(v)) as T); } catch { return d; } };
export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function newId(): string {
  return `tip_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Public, anonymised submitter handle. Addresses are never shown; only a stable 6-hex tag. */
export function anonSubmitter(submitter: string): string {
  if (submitter === DEMO_SUBMITTER) return "demo";
  if (submitter === ANON_SUBMITTER) return "anonymous";
  return `tipster-${keccak256(stringToHex(submitter.toLowerCase())).slice(2, 8)}`;
}

/** Laplace-smoothed reputation: new submitters start at 0.5, climb with verified tips, fall with rejected ones. */
export function reputationOf(verified: number, rejected: number): number {
  return round6(Math.min(1, Math.max(0, (verified + 1) / (verified + rejected + 2))));
}

function rowToTip(r: Record<string, unknown>): Tip {
  return {
    id: String(r.id), subject: String(r.subject) as Address, category: String(r.category) as TipCategory, claim: String(r.claim),
    evidenceUrls: json<string[]>(r.evidence_urls, []), evidenceTxs: json<`0x${string}`[]>(r.evidence_txs, []),
    submitter: String(r.submitter), stakeUsdc: numv(r.stake_usdc), stakeTx: str(r.stake_tx),
    status: String(r.status) as TipStatus, verification: json<TipVerification | null>(r.verification, null),
    payoutUsdc: numv(r.payout_usdc), payoutTx: str(r.payout_tx) as `0x${string}` | null, payoutMode: str(r.payout_mode) as PayoutMode | null,
    ledger: json<Tip["ledger"]>(r.ledger, {}),
    createdAt: numv(r.created_at), decidedAt: r.decided_at == null ? null : numv(r.decided_at), paidAt: r.paid_at == null ? null : numv(r.paid_at),
  };
}

// ─── Tips CRUD ───────────────────────────────────────────────────────────────
export async function createTip(input: NewTip, meta: { submitter: string; stakeUsdc: number; createdAt?: number; id?: string }): Promise<Tip> {
  await migrateTips();
  const t = NewTipSchema.parse(input);
  const id = meta.id ?? newId();
  await db().execute({
    sql: `INSERT INTO tips (id, subject, category, claim, evidence_urls, evidence_txs, submitter, stake_usdc, status, created_at)
          VALUES (?,?,?,?,?,?,?,?, 'SUBMITTED', ?)`,
    args: [id, t.subject, t.category, t.claim, JSON.stringify(t.evidenceUrls), JSON.stringify(t.evidenceTxs), meta.submitter, meta.stakeUsdc, meta.createdAt ?? nowS()],
  });
  await bumpStats(meta.submitter, { submitted: 1 });
  return (await getTip(id))!;
}

export async function getTip(id: string): Promise<Tip | null> {
  await migrateTips();
  const r = await db().execute({ sql: `SELECT * FROM tips WHERE id = ?`, args: [id] });
  return r.rows[0] ? rowToTip(r.rows[0] as Record<string, unknown>) : null;
}

export async function listTips(opts: { limit?: number; status?: TipStatus | TipStatus[]; subject?: Address; order?: "ASC" | "DESC" } = {}): Promise<Tip[]> {
  await migrateTips();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.status) {
    const list = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`status IN (${list.map(() => "?").join(",")})`);
    args.push(...list);
  }
  if (opts.subject) { where.push(`subject = ?`); args.push(opts.subject); }
  const order = opts.order ?? "DESC";
  args.push(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  const r = await db().execute({ sql: `SELECT * FROM tips ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at ${order}, id ${order} LIMIT ?`, args });
  return r.rows.map((x) => rowToTip(x as Record<string, unknown>));
}

export interface TipPatch {
  status?: TipStatus;
  verification?: TipVerification | null;
  stakeTx?: string | null;
  payoutUsdc?: number;
  payoutTx?: `0x${string}` | null;
  payoutMode?: PayoutMode | null;
  ledger?: Tip["ledger"];
  decidedAt?: number | null;
  paidAt?: number | null;
}
export async function updateTip(id: string, p: TipPatch): Promise<Tip | null> {
  await migrateTips();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const put = (col: string, v: string | number | null) => { sets.push(`${col} = ?`); args.push(v); };
  if (p.status !== undefined) put("status", p.status);
  if (p.verification !== undefined) put("verification", p.verification == null ? null : JSON.stringify(p.verification));
  if (p.stakeTx !== undefined) put("stake_tx", p.stakeTx);
  if (p.payoutUsdc !== undefined) put("payout_usdc", p.payoutUsdc);
  if (p.payoutTx !== undefined) put("payout_tx", p.payoutTx);
  if (p.payoutMode !== undefined) put("payout_mode", p.payoutMode);
  if (p.ledger !== undefined) put("ledger", JSON.stringify(p.ledger));
  if (p.decidedAt !== undefined) put("decided_at", p.decidedAt);
  if (p.paidAt !== undefined) put("paid_at", p.paidAt);
  if (!sets.length) return getTip(id);
  args.push(id);
  await db().execute({ sql: `UPDATE tips SET ${sets.join(", ")} WHERE id = ?`, args });
  return getTip(id);
}

/** Optimistic claim of a SUBMITTED tip by the verifier (two ticks cannot verify the same tip twice). */
export async function claimForVerification(id: string): Promise<boolean> {
  await migrateTips();
  const r = await db().execute({ sql: `UPDATE tips SET status = 'VERIFYING' WHERE id = ? AND status = 'SUBMITTED'`, args: [id] });
  return r.rowsAffected === 1;
}

/** Looks up the x402 settlement of an API tip's stake in the shared `payments` table (written by the payment sink). */
export async function findStakePayment(tip: Tip): Promise<{ txHash: string | null; amountUsdc: number } | null> {
  await migrateTips();
  if (tip.submitter === DEMO_SUBMITTER || tip.submitter === ANON_SUBMITTER) return null;
  const r = await db().execute({
    sql: `SELECT tx_hash, amount_usdc FROM payments WHERE lower(payer) = ? AND endpoint = '/api/v1/tips' AND created_at >= ? ORDER BY created_at ASC LIMIT 1`,
    args: [tip.submitter.toLowerCase(), tip.createdAt - 120],
  });
  const row = r.rows[0] as Record<string, unknown> | undefined;
  return row ? { txHash: str(row.tx_hash), amountUsdc: numv(row.amount_usdc) } : null;
}

// ─── Stats / leaderboard ─────────────────────────────────────────────────────
export async function bumpStats(submitter: string, d: { submitted?: number; verified?: number; rejected?: number; earnedUsdc?: number }): Promise<TipStats> {
  await migrateTips();
  const t = nowS();
  await db().execute({
    sql: `INSERT INTO tip_stats (submitter, submitted, verified, rejected, earned_usdc, reputation, updated_at) VALUES (?,?,?,?,?,0.5,?)
          ON CONFLICT(submitter) DO UPDATE SET submitted = submitted + excluded.submitted, verified = verified + excluded.verified,
            rejected = rejected + excluded.rejected, earned_usdc = earned_usdc + excluded.earned_usdc, updated_at = excluded.updated_at`,
    args: [submitter, d.submitted ?? 0, d.verified ?? 0, d.rejected ?? 0, d.earnedUsdc ?? 0, t],
  });
  const s = (await getStats(submitter))!;
  const reputation = reputationOf(s.verified, s.rejected);
  await db().execute({ sql: `UPDATE tip_stats SET reputation = ? WHERE submitter = ?`, args: [reputation, submitter] });
  return { ...s, reputation };
}

function rowToStats(r: Record<string, unknown>): TipStats {
  return { submitter: String(r.submitter), submitted: numv(r.submitted), verified: numv(r.verified), rejected: numv(r.rejected), earnedUsdc: round6(numv(r.earned_usdc)), reputation: numv(r.reputation), updatedAt: numv(r.updated_at) };
}
export async function getStats(submitter: string): Promise<TipStats | null> {
  await migrateTips();
  const r = await db().execute({ sql: `SELECT * FROM tip_stats WHERE submitter = ?`, args: [submitter] });
  return r.rows[0] ? rowToStats(r.rows[0] as Record<string, unknown>) : null;
}
/** Reputation for bounty math: unknown submitters are 0.5. */
export async function reputationFor(submitter: string): Promise<number> {
  return (await getStats(submitter))?.reputation ?? 0.5;
}
export async function leaderboard(limit = 10): Promise<TipStats[]> {
  await migrateTips();
  const r = await db().execute({ sql: `SELECT * FROM tip_stats WHERE submitted > 0 ORDER BY verified DESC, earned_usdc DESC, rejected ASC, submitter ASC LIMIT ?`, args: [Math.min(Math.max(limit, 1), 100)] });
  return r.rows.map((x) => rowToStats(x as Record<string, unknown>));
}

export interface TipTotals { total: number; byStatus: Record<TipStatus, number>; paidUsdc: number; stakedUsdc: number; slashedUsdc: number }
export async function tipTotals(): Promise<TipTotals> {
  await migrateTips();
  const r = await db().execute(`SELECT status, COUNT(*) AS n, COALESCE(SUM(payout_usdc),0) AS paid, COALESCE(SUM(stake_usdc),0) AS staked FROM tips GROUP BY status`);
  const t: TipTotals = { total: 0, byStatus: { SUBMITTED: 0, VERIFYING: 0, VERIFIED: 0, REJECTED: 0, PAID: 0, RECORDED: 0, SLASHED: 0, NEEDS_REVIEW: 0 }, paidUsdc: 0, stakedUsdc: 0, slashedUsdc: 0 };
  for (const row of r.rows as unknown as Record<string, unknown>[]) {
    const s = String(row.status) as TipStatus;
    const n = numv(row.n);
    t.total += n;
    if (s in t.byStatus) t.byStatus[s] += n;
    if (s === "PAID") t.paidUsdc += numv(row.paid);
    if (s === "SLASHED") t.slashedUsdc += numv(row.staked);
    t.stakedUsdc += numv(row.staked);
  }
  t.paidUsdc = round6(t.paidUsdc); t.stakedUsdc = round6(t.stakedUsdc); t.slashedUsdc = round6(t.slashedUsdc);
  return t;
}

// ─── Oracle feedback: verified tips become evidence ──────────────────────────
export async function recordTipOverride(e: TipEvidence): Promise<void> {
  await migrateTips();
  await db().execute({
    sql: `INSERT INTO tip_overrides (tip_id, subject, category, strength, tier_at_verification, summary, verified_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(tip_id) DO UPDATE SET strength = excluded.strength, summary = excluded.summary, verified_at = excluded.verified_at`,
    args: [e.tipId, e.subject, e.category, e.strength, e.tierAtVerification, e.summary, e.verifiedAt],
  });
}
export async function removeTipOverride(tipId: string): Promise<void> {
  await migrateTips();
  await db().execute({ sql: `DELETE FROM tip_overrides WHERE tip_id = ?`, args: [tipId] });
}

/**
 * VERIFIED community tips about an address, newest first - the one-call hook for the Evidence Collector.
 * Never throws (an unreachable DB yields []), so it is safe to call from collect.ts behind the usual per-source guard.
 */
export async function tipEvidenceFor(address: Address, opts: { withinSeconds?: number; now?: number } = {}): Promise<TipEvidence[]> {
  try {
    await migrateTips();
    const since = (opts.now ?? nowS()) - (opts.withinSeconds ?? 180 * 86_400);
    const r = await db().execute({ sql: `SELECT * FROM tip_overrides WHERE subject = ? AND verified_at >= ? ORDER BY verified_at DESC LIMIT 20`, args: [address.toLowerCase(), since] });
    return r.rows.map((x) => {
      const row = x as Record<string, unknown>;
      return {
        tipId: String(row.tip_id), subject: String(row.subject) as Address, category: String(row.category) as TipCategory,
        strength: String(row.strength) as TipEvidence["strength"], tierAtVerification: str(row.tier_at_verification) as Tier | null,
        summary: String(row.summary), verifiedAt: numv(row.verified_at),
      };
    });
  } catch (e) {
    console.warn("[tips] tipEvidenceFor failed:", (e as Error)?.message);
    return [];
  }
}

// ─── Daily payout cap ────────────────────────────────────────────────────────
export function dayKey(unix = nowS()): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}
export async function spentToday(unix = nowS()): Promise<number> {
  await migrateTips();
  const r = await db().execute({ sql: `SELECT spent_usdc FROM tip_spend WHERE day = ?`, args: [dayKey(unix)] });
  return r.rows[0] ? numv((r.rows[0] as Record<string, unknown>).spent_usdc) : 0;
}
export async function addSpend(amountUsdc: number, unix = nowS()): Promise<void> {
  await migrateTips();
  if (amountUsdc <= 0) return;
  await db().execute({
    sql: `INSERT INTO tip_spend (day, spent_usdc, payouts) VALUES (?,?,1) ON CONFLICT(day) DO UPDATE SET spent_usdc = spent_usdc + excluded.spent_usdc, payouts = payouts + 1`,
    args: [dayKey(unix), amountUsdc],
  });
}

// ─── Public projection (what API clients and the page see) ───────────────────
export interface PublicTip {
  id: string;
  subject: Address;
  category: TipCategory;
  claim: string;
  evidenceUrls: string[];
  evidenceTxs: `0x${string}`[];
  submitter: string; // anonymised handle
  demo: boolean;
  stakeUsdc: number;
  status: TipStatus;
  verdict: { tier: Tier | null; score: number | null; decision: TipDecision; reason: string; strong: number; weak: number; by: "agent" | "human"; decisionId: string | null } | null;
  payoutUsdc: number;
  payoutTx: `0x${string}` | null;
  payoutMode: PayoutMode | null;
  createdAt: string;
  decidedAt: string | null;
  paidAt: string | null;
}
export function toPublicTip(t: Tip): PublicTip {
  const v = t.verification;
  return {
    id: t.id, subject: t.subject, category: t.category, claim: t.claim, evidenceUrls: t.evidenceUrls, evidenceTxs: t.evidenceTxs,
    submitter: anonSubmitter(t.submitter), demo: t.submitter === DEMO_SUBMITTER, stakeUsdc: t.stakeUsdc, status: t.status,
    verdict: v ? { tier: v.tier, score: v.score, decision: v.decision, reason: v.reason, strong: v.corroboration.strong, weak: v.corroboration.weak, by: v.by, decisionId: v.decisionId } : null,
    payoutUsdc: t.payoutUsdc, payoutTx: t.payoutTx, payoutMode: t.payoutMode,
    createdAt: new Date(t.createdAt * 1000).toISOString(), decidedAt: t.decidedAt ? new Date(t.decidedAt * 1000).toISOString() : null, paidAt: t.paidAt ? new Date(t.paidAt * 1000).toISOString() : null,
  };
}
export interface PublicLeader { submitter: string; submitted: number; verified: number; rejected: number; earnedUsdc: number; reputation: number }
export function toPublicLeader(s: TipStats): PublicLeader {
  return { submitter: anonSubmitter(s.submitter), submitted: s.submitted, verified: s.verified, rejected: s.rejected, earnedUsdc: s.earnedUsdc, reputation: s.reputation };
}
