/**
 * Guarantee (bond) on LOW verdicts - CompliR puts a little of its own money behind a clean verdict.
 *
 *   screen(address, amountUsdc) → tier LOW → verdict.guarantee = { bondUsdc, until, terms }
 *
 *   bondUsdc = min( GUARANTEE_MAX_BOND_USDC (default 0.5),
 *                   10 % of amountUsdc,
 *                   25 % of the revenue wallet's current USDC balance )      - unreadable balance → no guarantee
 *   until    = screenedAt + GUARANTEE_DAYS (default 30)
 *
 *   claim: POST /api/v1/guarantee/claim { decisionId, payerAddress }
 *          valid iff the guarantee is ACTIVE, `until` has not passed, the claimant is the payer of the original
 *          screen (clientId / x402 payment record; or a same-origin browser for the demo) AND a fresh re-screen of
 *          the subject grades HIGH. Then bondUsdc is queued as a refund to payerAddress through src/lib/refunds
 *          (Circle `revenue` wallet rail, reason "guarantee …") and a "GUARANTEE" ledger entry is appended.
 *
 * Honest limits (docs/GUARANTEE.md): the bond is small, paid from revenue, and is not insurance.
 */
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { arcChain } from "../chain/registryWriter";
import { config } from "../config";
import { appendDecision } from "../ledger";
import { processRefunds, queueRefund, refundConfig } from "../refunds";
import { db, migrate } from "../store/db";
import type { Address, ScreenRequest, Tier, Verdict } from "../types";

export const GUARANTEE_CLIENT_ID = "guarantee";
export const GUARANTEE_STATUSES = ["ACTIVE", "CLAIMED", "EXPIRED", "VOID"] as const;
export type GuaranteeStatus = (typeof GUARANTEE_STATUSES)[number];

export interface GuaranteeConfig {
  maxBondUsdc: number;
  days: number;
  /** share of the screened amount (0.1 = 10 %) */
  amountShare: number;
  /** share of the revenue wallet balance (0.25 = 25 %) */
  balanceShare: number;
}
export function guaranteeConfig(env: Record<string, string | undefined> = process.env): GuaranteeConfig {
  const n = (k: string, d: number) => { const v = Number(env[k]); return env[k] !== undefined && env[k] !== "" && Number.isFinite(v) && v >= 0 ? v : d; };
  return { maxBondUsdc: n("GUARANTEE_MAX_BOND_USDC", 0.5), days: n("GUARANTEE_DAYS", 30), amountShare: 0.1, balanceShare: 0.25 };
}

export interface GuaranteeClaim {
  payerAddress: Address;
  refundId: string;
  ledgerId: string;
  rescreenDecisionId: string;
  rescreenTier: Tier;
  claimedAt: number;
}
export interface Guarantee {
  decisionId: string;
  subject: Address;
  /** clientId of the screen request (x402 payer address when the client sent one); null = anonymous */
  payer: string | null;
  amountUsdc: number;
  bondUsdc: number;
  /** unix seconds */
  until: number;
  status: GuaranteeStatus;
  terms: string;
  claim: GuaranteeClaim | null;
  createdAt: number;
  updatedAt: number;
}

export class GuaranteeError extends Error {
  constructor(readonly code: "NOT_FOUND" | "NOT_ACTIVE" | "EXPIRED" | "CLAIMANT_MISMATCH" | "NOT_HIGH" | "VALIDATION", message: string, readonly details?: unknown) {
    super(message);
    this.name = "GuaranteeError";
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS guarantees (
     decision_id TEXT PRIMARY KEY, subject TEXT NOT NULL, payer TEXT, amount_usdc REAL NOT NULL, bond_usdc REAL NOT NULL, until_ts INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'ACTIVE', terms TEXT NOT NULL, claim TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS guarantees_subject ON guarantees(subject, status)`,
];
let migrated: Promise<void> | null = null;
export function migrateGuarantees(): Promise<void> {
  if (!migrated) migrated = (async () => { await migrate(); for (const s of SCHEMA) await db().execute(s); })();
  return migrated;
}
/** test helper */
export function __resetGuarantees() { migrated = null; balanceCache = null; }

const now = () => Math.floor(Date.now() / 1000);
const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (v == null ? null : String(v));
const round6 = (n: number) => Math.max(0, Math.round(n * 1e6) / 1e6);
const ADDR = /^0x[0-9a-fA-F]{40}$/;

function rowToGuarantee(r: Record<string, unknown>): Guarantee {
  let claim: GuaranteeClaim | null = null;
  try { claim = r.claim ? (JSON.parse(String(r.claim)) as GuaranteeClaim) : null; } catch { claim = null; }
  return {
    decisionId: String(r.decision_id), subject: String(r.subject) as Address, payer: str(r.payer), amountUsdc: num(r.amount_usdc), bondUsdc: num(r.bond_usdc),
    until: num(r.until_ts), status: String(r.status) as GuaranteeStatus, terms: String(r.terms), claim, createdAt: num(r.created_at), updatedAt: num(r.updated_at),
  };
}

// ─── bond sizing (pure) ──────────────────────────────────────────────────────
/** min(max bond, 10 % of amount, 25 % of revenue balance), 6 dp. 0 when any input makes a bond impossible. */
export function sizeBond(input: { amountUsdc: number; revenueBalanceUsdc: number | null; cfg?: GuaranteeConfig }): number {
  const cfg = input.cfg ?? guaranteeConfig();
  if (!(input.amountUsdc > 0) || input.revenueBalanceUsdc === null || !(input.revenueBalanceUsdc > 0)) return 0;
  return round6(Math.min(cfg.maxBondUsdc, input.amountUsdc * cfg.amountShare, input.revenueBalanceUsdc * cfg.balanceShare));
}

export function guaranteeTerms(g: { subject: Address; bondUsdc: number; until: number }): string {
  return `If CompliR re-grades ${g.subject} to HIGH before ${new Date(g.until * 1000).toISOString()}, the payer of this screen can claim ${g.bondUsdc} USDC back (POST /api/v1/guarantee/claim). ` +
    `The bond is paid from CompliR revenue on Arc, is capped, and is not insurance: it does not cover your payment to the subject.`;
}

// ─── revenue wallet balance ──────────────────────────────────────────────────
/** The wallet the bond is paid from: REVENUE_WALLET → X402_PAY_TO → Circle `revenue` wallet. */
export async function revenueWalletAddress(): Promise<Address | null> {
  const env = (process.env.REVENUE_WALLET ?? "").trim();
  if (ADDR.test(env)) return env.toLowerCase() as Address;
  const payTo = config().X402_PAY_TO;
  if (payTo && ADDR.test(payTo)) return payTo.toLowerCase() as Address;
  try {
    const { walletByRole } = await import("../circle/wallets");
    return (await walletByRole("revenue"))?.address ?? null;
  } catch { return null; }
}

let balanceCache: { at: number; value: number | null } | null = null;
const BALANCE_TTL_MS = 60_000;
const STALE_OK_MS = 10 * 60_000;
/** Current USDC balance of the revenue wallet (viem `balanceOf`); null when unreadable. Cached for a minute. */
export async function revenueBalanceUsdc(opts: { timeoutMs?: number; fresh?: boolean } = {}): Promise<number | null> {
  if (!opts.fresh && balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.value;
  let value: number | null = null;
  try {
    const wallet = await revenueWalletAddress();
    if (wallet) {
      const c = config();
      const pub = createPublicClient({ chain: arcChain(), transport: http(c.ARC_RPC_URL, { timeout: opts.timeoutMs ?? 5_000, retryCount: 3, retryDelay: 2_000 }) });
      const raw = await pub.readContract({ address: c.USDC_ADDRESS as Address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
      value = Number(formatUnits(raw, 6));
    }
  } catch (e) {
    console.warn("[guarantee] revenue balance unreadable:", (e as Error)?.message ?? e);
    value = null;
  }
  if (value === null) {
    // throttled / unreachable RPC: reuse the last successful read if it is recent, never cache the failure
    if (balanceCache && balanceCache.value !== null && Date.now() - balanceCache.at < STALE_OK_MS) return balanceCache.value;
    return null;
  }
  balanceCache = { at: Date.now(), value };
  return value;
}

// ─── attach (pipeline hook) ──────────────────────────────────────────────────
export interface AttachOptions {
  /** injected for tests */
  balance?: () => Promise<number | null>;
  now?: number;
  cfg?: GuaranteeConfig;
}
/**
 * Size + persist a guarantee for a LOW verdict that came with an amount. Returns what to put on `verdict.guarantee`
 * (null when no bond could be sized: not LOW, no amount, revenue balance unreadable or zero).
 */
export async function attachGuarantee(verdict: Verdict, req: Pick<ScreenRequest, "amountUsdc" | "clientId">, opts: AttachOptions = {}): Promise<Verdict["guarantee"]> {
  if (verdict.tier !== "LOW" || !(Number(req.amountUsdc) > 0)) return null;
  const cfg = opts.cfg ?? guaranteeConfig();
  const balance = await (opts.balance ?? revenueBalanceUsdc)();
  const bondUsdc = sizeBond({ amountUsdc: Number(req.amountUsdc), revenueBalanceUsdc: balance, cfg });
  if (bondUsdc <= 0) return null;
  const parsed = Math.floor(new Date(verdict.screenedAt).getTime() / 1000);
  const screenedAt = opts.now ?? (Number.isFinite(parsed) ? parsed : now());
  const until = screenedAt + Math.round(cfg.days * 86400);
  const terms = guaranteeTerms({ subject: verdict.address, bondUsdc, until });
  await migrateGuarantees();
  const t = now();
  await db().execute({
    sql: `INSERT OR IGNORE INTO guarantees (decision_id, subject, payer, amount_usdc, bond_usdc, until_ts, status, terms, created_at, updated_at) VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)`,
    args: [verdict.decisionId, verdict.address, req.clientId ?? null, Number(req.amountUsdc), bondUsdc, until, terms, t, t],
  });
  return { bondUsdc, until: new Date(until * 1000).toISOString(), terms };
}

export async function getGuarantee(decisionId: string): Promise<Guarantee | null> {
  await migrateGuarantees();
  const r = await db().execute({ sql: `SELECT * FROM guarantees WHERE decision_id = ?`, args: [decisionId] });
  const g = r.rows[0] ? rowToGuarantee(r.rows[0] as Record<string, unknown>) : null;
  if (g && g.status === "ACTIVE" && g.until <= now()) {
    await db().execute({ sql: `UPDATE guarantees SET status='EXPIRED', updated_at=? WHERE decision_id=? AND status='ACTIVE'`, args: [now(), decisionId] });
    g.status = "EXPIRED";
  }
  return g;
}

export async function listGuarantees(limit = 100): Promise<Guarantee[]> {
  await migrateGuarantees();
  const r = await db().execute({ sql: `SELECT * FROM guarantees ORDER BY created_at DESC LIMIT ?`, args: [Math.min(Math.max(limit, 1), 1000)] });
  return r.rows.map((x) => rowToGuarantee(x as Record<string, unknown>));
}

/** Public shape (no claimant internals beyond what the claimant already knows). */
export function toPublicGuarantee(g: Guarantee) {
  return {
    decisionId: g.decisionId, subject: g.subject, amountUsdc: g.amountUsdc, bondUsdc: g.bondUsdc, until: new Date(g.until * 1000).toISOString(),
    status: g.status, terms: g.terms, createdAt: new Date(g.createdAt * 1000).toISOString(),
    claim: g.claim ? { payerAddress: g.claim.payerAddress, refundId: g.claim.refundId, ledgerId: g.claim.ledgerId, rescreenDecisionId: g.claim.rescreenDecisionId, rescreenTier: g.claim.rescreenTier, claimedAt: new Date(g.claim.claimedAt * 1000).toISOString() } : null,
  };
}

// ─── claims ──────────────────────────────────────────────────────────────────
/** Was `payerAddress` the payer of the original screen? clientId match, or an x402 payment by that address around the screen time. */
export async function claimantMatches(g: Guarantee, payerAddress: Address, opts: { windowSeconds?: number } = {}): Promise<boolean> {
  if (g.payer && g.payer.toLowerCase() === payerAddress) return true;
  const w = opts.windowSeconds ?? 900;
  const r = await db().execute({
    sql: `SELECT 1 FROM payments WHERE payer = ? AND endpoint LIKE '%/screen%' AND created_at BETWEEN ? AND ? LIMIT 1`,
    args: [payerAddress, g.createdAt - w, g.createdAt + w],
  });
  return r.rows.length > 0;
}

export interface ClaimInput {
  decisionId: string;
  payerAddress: string;
  /** same-origin browser (the demo page): accepted as the claimant without a payment record */
  sameOrigin?: boolean;
}
export interface ClaimOptions {
  /** injected for tests (defaults to the real pipeline re-screen) */
  screenFn?: (req: ScreenRequest, opts: { kind: "RESCREEN" }) => Promise<Verdict>;
  now?: number;
}
export interface ClaimResult {
  guarantee: ReturnType<typeof toPublicGuarantee>;
  refund: { id: string; status: string; amountUsdc: number; payer: Address };
  rescreen: { decisionId: string; tier: Tier; score: number };
  ledgerId: string;
}

export async function claimGuarantee(input: ClaimInput, opts: ClaimOptions = {}): Promise<ClaimResult> {
  const payerAddress = (input.payerAddress ?? "").trim().toLowerCase() as Address;
  if (!ADDR.test(payerAddress)) throw new GuaranteeError("VALIDATION", "payerAddress must be an EVM address");
  const g = await getGuarantee(input.decisionId);
  if (!g) throw new GuaranteeError("NOT_FOUND", `No guarantee for decision ${input.decisionId}`);
  const t = opts.now ?? now();
  if (g.status === "EXPIRED" || (g.status === "ACTIVE" && g.until <= t)) {
    if (g.status === "ACTIVE") await db().execute({ sql: `UPDATE guarantees SET status='EXPIRED', updated_at=? WHERE decision_id=?`, args: [t, g.decisionId] });
    throw new GuaranteeError("EXPIRED", `Guarantee expired at ${new Date(g.until * 1000).toISOString()}`);
  }
  if (g.status !== "ACTIVE") throw new GuaranteeError("NOT_ACTIVE", `Guarantee is ${g.status}`);
  if (!input.sameOrigin && !(await claimantMatches(g, payerAddress))) {
    throw new GuaranteeError("CLAIMANT_MISMATCH", "payerAddress is not the payer of the original screen");
  }

  // the subject must grade HIGH *now* - a fresh RESCREEN, on the ledger like every verdict
  const screenFn = opts.screenFn ?? (async (req: ScreenRequest, o: { kind: "RESCREEN" }) => (await import("../pipeline")).screen(req, o));
  const v = await screenFn({ address: g.subject, amountUsdc: g.amountUsdc, clientId: GUARANTEE_CLIENT_ID }, { kind: "RESCREEN" });
  if (v.tier !== "HIGH") {
    await appendDecision({ kind: "GUARANTEE", subject: g.subject, clientId: GUARANTEE_CLIENT_ID, payload: {
      type: "GUARANTEE", event: "CLAIM_REJECTED", decisionId: g.decisionId, payerAddress, bondUsdc: g.bondUsdc, until: g.until,
      rescreen: { decisionId: v.decisionId, tier: v.tier, score: v.score }, reason: `subject re-screened ${v.tier}, not HIGH`, at: t,
    } });
    throw new GuaranteeError("NOT_HIGH", `Subject re-screened ${v.tier} (score ${v.score}); the guarantee pays only on HIGH`, { rescreen: { decisionId: v.decisionId, tier: v.tier, score: v.score } });
  }

  // atomic claim: only one caller flips ACTIVE → CLAIMED
  const claimed = await db().execute({ sql: `UPDATE guarantees SET status='CLAIMED', updated_at=? WHERE decision_id=? AND status='ACTIVE'`, args: [t, g.decisionId] });
  if (claimed.rowsAffected !== 1) throw new GuaranteeError("NOT_ACTIVE", "Guarantee was claimed concurrently");

  const { refund } = await queueRefund({
    payer: payerAddress, amountUsdc: g.bondUsdc, reason: `guarantee ${g.decisionId}: subject ${g.subject} re-graded HIGH on ${v.decisionId}`,
    originalTx: null, endpoint: "/api/v1/guarantee/claim", source: "manual",
  });
  const entry = await appendDecision({ kind: "GUARANTEE", subject: g.subject, clientId: GUARANTEE_CLIENT_ID, payload: {
    type: "GUARANTEE", event: "CLAIMED", decisionId: g.decisionId, payerAddress, bondUsdc: g.bondUsdc, until: g.until, amountUsdc: g.amountUsdc,
    rescreen: { decisionId: v.decisionId, tier: v.tier, score: v.score }, refundId: refund.id, refundStatus: refund.status, at: t,
  } });
  const claim: GuaranteeClaim = { payerAddress, refundId: refund.id, ledgerId: entry.id, rescreenDecisionId: v.decisionId, rescreenTier: v.tier, claimedAt: t };
  await db().execute({ sql: `UPDATE guarantees SET claim=?, updated_at=? WHERE decision_id=?`, args: [JSON.stringify(claim), t, g.decisionId] });
  if (refundConfig().autoProcess) processRefunds().catch((err) => console.error("[guarantee] refund processing failed:", err));

  const fresh = (await getGuarantee(g.decisionId))!;
  return { guarantee: toPublicGuarantee(fresh), refund: { id: refund.id, status: refund.status, amountUsdc: refund.amountUsdc, payer: refund.payer }, rescreen: { decisionId: v.decisionId, tier: v.tier, score: v.score }, ledgerId: entry.id };
}
