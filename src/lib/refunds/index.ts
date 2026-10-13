/**
 * Automatic refunds. Every settled x402 payment we could not honour (handler failed after settle, client gone,
 * response undeliverable) lands here via `installRefundSink()`, as do human-initiated refunds (internal POST).
 *
 *   queueRefund()    → `refunds` row, idempotent per original tx
 *   processRefunds() → sends USDC back on Arc: Circle `revenue` wallet → local REFUND_PRIVATE_KEY/REVENUE_PRIVATE_KEY
 *                      ERC-20 transfer → otherwise DRY_RUN with the reason. Marks `payments.refunded = 1`, appends a
 *                      ledger "REFUND" entry. Daily cap REFUND_DAILY_CAP_USDC (default 5): beyond it rows stay QUEUED
 *                      with `note = OVER_DAILY_CAP …` until a human raises the cap or the day rolls over.
 *
 * Statuses: QUEUED → SENT | FAILED (after REFUND_MAX_ATTEMPTS, default 3) | DRY_RUN (terminal, no signer; `requeueRefund`).
 */
import { createPublicClient, createWalletClient, erc20Abi, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcChain } from "../chain/registryWriter";
import { circleStatus } from "../circle/client";
import { transferUsdc } from "../circle/execute";
import { config } from "../config";
import { appendDecision } from "../ledger";
import { setRefundSink, type RefundNeededEvent } from "../pay/x402";
import { db, migrate } from "../store/db";
import type { Address } from "../types";

export const REFUND_STATUSES = ["QUEUED", "SENT", "FAILED", "DRY_RUN"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const REFUND_CLIENT_ID = "refunds";

export interface Refund {
  id: string;
  payer: Address;
  amountUsdc: number;
  reason: string;
  originalTx: string | null;
  endpoint: string | null;
  source: "auto" | "manual";
  status: RefundStatus;
  txHash: string | null;
  /** Why it is not SENT yet (cap, dry-run reason, last error). */
  note: string | null;
  attempts: number;
  /** ledger REFUND entry id once processed */
  ledgerId: string | null;
  createdAt: number;
  sentAt: number | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS refunds (
     id TEXT PRIMARY KEY, payer TEXT NOT NULL, amount_usdc REAL NOT NULL, reason TEXT NOT NULL, original_tx TEXT, endpoint TEXT,
     source TEXT NOT NULL DEFAULT 'auto', status TEXT NOT NULL DEFAULT 'QUEUED', tx_hash TEXT, note TEXT,
     attempts INTEGER NOT NULL DEFAULT 0, ledger_id TEXT, created_at INTEGER NOT NULL, sent_at INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS refunds_original_tx ON refunds(original_tx)`,
  `CREATE INDEX IF NOT EXISTS refunds_status ON refunds(status, created_at)`,
];
let migrated: Promise<void> | null = null;
export function migrateRefunds(): Promise<void> {
  if (!migrated) migrated = (async () => { await migrate(); for (const s of SCHEMA) await db().execute(s); })();
  return migrated;
}
/** test helper */
export function __resetRefunds() { migrated = null; }

const now = () => Math.floor(Date.now() / 1000);
const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (v == null ? null : String(v));
const round6 = (n: number) => Number(n.toFixed(6));
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

function rowToRefund(r: Record<string, unknown>): Refund {
  return {
    id: String(r.id), payer: String(r.payer) as Address, amountUsdc: num(r.amount_usdc), reason: String(r.reason),
    originalTx: str(r.original_tx), endpoint: str(r.endpoint), source: (str(r.source) as "auto" | "manual") ?? "auto",
    status: String(r.status) as RefundStatus, txHash: str(r.tx_hash), note: str(r.note), attempts: num(r.attempts),
    ledgerId: str(r.ledger_id), createdAt: num(r.created_at), sentAt: r.sent_at == null ? null : num(r.sent_at),
  };
}

// ─── config ──────────────────────────────────────────────────────────────────
export interface RefundConfig {
  dailyCapUsdc: number;
  maxAttempts: number;
  /** Process the queue right after an auto-refund is queued (default true). */
  autoProcess: boolean;
}
export function refundConfig(): RefundConfig {
  const env = process.env;
  const cap = Number(env.REFUND_DAILY_CAP_USDC);
  const attempts = Number(env.REFUND_MAX_ATTEMPTS);
  return {
    dailyCapUsdc: Number.isFinite(cap) && cap >= 0 ? cap : 5,
    maxAttempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 3,
    autoProcess: !/^(0|false|no|off)$/i.test((env.REFUND_AUTO_PROCESS ?? "").trim()),
  };
}
function localRefundKey(): Hex | null {
  const k = (process.env.REFUND_PRIVATE_KEY ?? process.env.REVENUE_PRIVATE_KEY ?? "").trim();
  return /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null;
}
export type RefundMode = { mode: "circle"; from: null } | { mode: "local"; from: Address } | { mode: "dry-run"; reason: string };
/** Which signer will send refunds right now. Never throws. */
export function refundMode(): RefundMode {
  const c = circleStatus();
  if (c.enabled) return { mode: "circle", from: null };
  const key = localRefundKey();
  if (key) return { mode: "local", from: privateKeyToAccount(key).address.toLowerCase() as Address };
  return { mode: "dry-run", reason: `no refund signer: Circle not configured (${c.reason}) and REFUND_PRIVATE_KEY / REVENUE_PRIVATE_KEY unset` };
}

// ─── queue ───────────────────────────────────────────────────────────────────
export interface QueueRefundInput {
  payer: string;
  amountUsdc: number | string;
  reason: string;
  /** Settle tx of the payment being refunded; idempotency key when present. */
  originalTx?: string | null;
  endpoint?: string | null;
  source?: "auto" | "manual";
}
export class RefundInputError extends Error { code = "VALIDATION_ERROR" as const; }

/** Queue a refund. Idempotent per `originalTx`: a second call returns the existing row untouched. */
export async function queueRefund(input: QueueRefundInput): Promise<{ refund: Refund; created: boolean }> {
  await migrateRefunds();
  const payer = input.payer.trim().toLowerCase();
  if (!ADDR.test(payer)) throw new RefundInputError(`payer must be an EVM address, got ${input.payer}`);
  const amount = round6(Number(input.amountUsdc));
  if (!(amount > 0)) throw new RefundInputError(`amountUsdc must be > 0, got ${String(input.amountUsdc)}`);
  const reason = input.reason.trim();
  if (!reason) throw new RefundInputError("reason is required");
  const originalTx = input.originalTx?.trim() ? input.originalTx.trim().toLowerCase() : null;
  if (originalTx && !TX.test(originalTx)) throw new RefundInputError(`originalTx must be a tx hash, got ${originalTx}`);

  if (originalTx) {
    const existing = await db().execute({ sql: `SELECT * FROM refunds WHERE original_tx = ?`, args: [originalTx] });
    if (existing.rows[0]) return { refund: rowToRefund(existing.rows[0] as Record<string, unknown>), created: false };
  }
  const t = now();
  const id = `ref_${t.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    await db().execute({
      sql: `INSERT INTO refunds (id, payer, amount_usdc, reason, original_tx, endpoint, source, status, attempts, created_at) VALUES (?,?,?,?,?,?,?,'QUEUED',0,?)`,
      args: [id, payer, amount, reason, originalTx, input.endpoint ?? null, input.source ?? "auto", t],
    });
  } catch (e) {
    // lost a race on the unique index → return the winner
    if (originalTx) {
      const existing = await db().execute({ sql: `SELECT * FROM refunds WHERE original_tx = ?`, args: [originalTx] });
      if (existing.rows[0]) return { refund: rowToRefund(existing.rows[0] as Record<string, unknown>), created: false };
    }
    throw e;
  }
  console.warn(`[complir/refunds] queued ${amount} USDC → ${payer} (${reason})${originalTx ? ` for ${originalTx}` : ""}`);
  return { refund: (await getRefund(id))!, created: true };
}

export async function getRefund(id: string): Promise<Refund | null> {
  await migrateRefunds();
  const r = await db().execute({ sql: `SELECT * FROM refunds WHERE id = ?`, args: [id] });
  return r.rows[0] ? rowToRefund(r.rows[0] as Record<string, unknown>) : null;
}
export async function listRefunds(opts: { limit?: number; status?: RefundStatus } = {}): Promise<Refund[]> {
  await migrateRefunds();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const r = opts.status
    ? await db().execute({ sql: `SELECT * FROM refunds WHERE status = ? ORDER BY created_at DESC LIMIT ?`, args: [opts.status, limit] })
    : await db().execute({ sql: `SELECT * FROM refunds ORDER BY created_at DESC LIMIT ?`, args: [limit] });
  return r.rows.map((x) => rowToRefund(x as Record<string, unknown>));
}
/** Refunds created or sent inside [from, to) unix seconds — the daily report's "mistakes & refunds". */
export async function refundsBetween(from: number, to: number): Promise<Refund[]> {
  await migrateRefunds();
  const r = await db().execute({
    sql: `SELECT * FROM refunds WHERE (created_at >= ? AND created_at < ?) OR (sent_at >= ? AND sent_at < ?) ORDER BY created_at ASC`,
    args: [from, to, from, to],
  });
  return r.rows.map((x) => rowToRefund(x as Record<string, unknown>));
}
/** Put a DRY_RUN / FAILED refund back in the queue (e.g. after configuring a signer). */
export async function requeueRefund(id: string): Promise<Refund | null> {
  await migrateRefunds();
  await db().execute({ sql: `UPDATE refunds SET status = 'QUEUED', attempts = 0, note = NULL WHERE id = ? AND status IN ('DRY_RUN','FAILED')`, args: [id] });
  return getRefund(id);
}
/** USDC actually sent since 00:00 UTC today. */
export async function refundedTodayUsdc(at = now()): Promise<number> {
  await migrateRefunds();
  const dayStart = at - (at % 86400);
  const r = await db().execute({ sql: `SELECT COALESCE(SUM(amount_usdc),0) AS s FROM refunds WHERE status = 'SENT' AND sent_at >= ?`, args: [dayStart] });
  return round6(num((r.rows[0] as Record<string, unknown>).s));
}

// ─── sending ─────────────────────────────────────────────────────────────────
export type SendResult = { status: "sent"; txHash: string; via: "circle" | "local" } | { status: "dry-run"; reason: string };
export type RefundSender = (r: Refund) => Promise<SendResult>;

/** Circle revenue wallet → local key → dry-run. */
export const defaultSender: RefundSender = async (r) => {
  const mode = refundMode();
  if (mode.mode === "circle") {
    const res = await transferUsdc({ role: "revenue", to: r.payer, amountUsdc: r.amountUsdc, refId: `complir:refund:${r.id}` });
    if (res.status === "sent") return { status: "sent", txHash: res.txHash, via: "circle" };
    return { status: "dry-run", reason: res.reason };
  }
  if (mode.mode === "local") {
    const c = config();
    const account = privateKeyToAccount(localRefundKey()!);
    const chain = arcChain();
    const wallet = createWalletClient({ account, chain, transport: http(c.ARC_RPC_URL) });
    const pub = createPublicClient({ chain, transport: http(c.ARC_RPC_URL) });
    const hash = await wallet.writeContract({
      address: c.USDC_ADDRESS as Address, abi: erc20Abi, functionName: "transfer",
      args: [r.payer, parseUnits(r.amountUsdc.toFixed(6), 6)],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`refund tx ${hash} reverted`);
    return { status: "sent", txHash: hash, via: "local" };
  }
  return { status: "dry-run", reason: mode.reason };
};

export interface ProcessResult {
  processed: number; sent: number; dryRun: number; failed: number; capped: number; retained: number;
  sentUsdc: number; mode: RefundMode["mode"]; results: { id: string; status: RefundStatus; txHash: string | null; note: string | null }[];
}

let processing: Promise<ProcessResult> | null = null;
/** Drain the queue once (serialised in-process). `send` is injectable for tests. */
export function processRefunds(opts: { send?: RefundSender; now?: number } = {}): Promise<ProcessResult> {
  if (processing) return processing;
  processing = processOnce(opts).finally(() => { processing = null; });
  return processing;
}

async function processOnce(opts: { send?: RefundSender; now?: number }): Promise<ProcessResult> {
  await migrateRefunds();
  const cfg = refundConfig();
  const send = opts.send ?? defaultSender;
  const at = opts.now ?? now();
  const result: ProcessResult = { processed: 0, sent: 0, dryRun: 0, failed: 0, capped: 0, retained: 0, sentUsdc: 0, mode: refundMode().mode, results: [] };
  const queued = (await db().execute(`SELECT * FROM refunds WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 100`)).rows.map((x) => rowToRefund(x as Record<string, unknown>));
  let spentToday = await refundedTodayUsdc(at);

  for (const r of queued) {
    result.processed++;
    if (spentToday + r.amountUsdc > cfg.dailyCapUsdc + 1e-9) {
      const note = `OVER_DAILY_CAP: ${r.amountUsdc} USDC would exceed REFUND_DAILY_CAP_USDC=${cfg.dailyCapUsdc} (sent today ${spentToday}); left QUEUED`;
      await db().execute({ sql: `UPDATE refunds SET note = ? WHERE id = ?`, args: [note, r.id] });
      console.warn(`[complir/refunds] ${r.id} ${note}`);
      result.capped++;
      result.results.push({ id: r.id, status: "QUEUED", txHash: null, note });
      continue;
    }
    let outcome: SendResult;
    try {
      outcome = await send(r);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const attempts = r.attempts + 1;
      const terminal = attempts >= cfg.maxAttempts;
      await db().execute({ sql: `UPDATE refunds SET attempts = ?, note = ?, status = ? WHERE id = ?`, args: [attempts, `attempt ${attempts}: ${msg}`, terminal ? "FAILED" : "QUEUED", r.id] });
      console.error(`[complir/refunds] ${r.id} send failed (attempt ${attempts}/${cfg.maxAttempts}):`, msg);
      if (terminal) {
        result.failed++;
        const entry = await ledger({ ...r, status: "FAILED", attempts, note: msg });
        await db().execute({ sql: `UPDATE refunds SET ledger_id = ? WHERE id = ?`, args: [entry, r.id] });
      } else result.retained++;
      result.results.push({ id: r.id, status: terminal ? "FAILED" : "QUEUED", txHash: null, note: msg });
      continue;
    }
    if (outcome.status === "sent") {
      const t = now();
      await db().execute({ sql: `UPDATE refunds SET status = 'SENT', tx_hash = ?, sent_at = ?, note = ?, attempts = attempts + 1 WHERE id = ?`, args: [outcome.txHash, t, `sent via ${outcome.via}`, r.id] });
      if (r.originalTx) await db().execute({ sql: `UPDATE payments SET refunded = 1 WHERE tx_hash = ?`, args: [r.originalTx] });
      const entry = await ledger({ ...r, status: "SENT", txHash: outcome.txHash, sentAt: t, note: `sent via ${outcome.via}` });
      await db().execute({ sql: `UPDATE refunds SET ledger_id = ? WHERE id = ?`, args: [entry, r.id] });
      spentToday = round6(spentToday + r.amountUsdc);
      result.sent++; result.sentUsdc = round6(result.sentUsdc + r.amountUsdc);
      console.warn(`[complir/refunds] ${r.id} SENT ${r.amountUsdc} USDC → ${r.payer} tx ${outcome.txHash}`);
      result.results.push({ id: r.id, status: "SENT", txHash: outcome.txHash, note: null });
    } else {
      await db().execute({ sql: `UPDATE refunds SET status = 'DRY_RUN', note = ?, attempts = attempts + 1 WHERE id = ?`, args: [outcome.reason, r.id] });
      const entry = await ledger({ ...r, status: "DRY_RUN", note: outcome.reason });
      await db().execute({ sql: `UPDATE refunds SET ledger_id = ? WHERE id = ?`, args: [entry, r.id] });
      result.dryRun++;
      console.warn(`[complir/refunds] ${r.id} DRY_RUN (${outcome.reason}) — ${r.amountUsdc} USDC still owed to ${r.payer}`);
      result.results.push({ id: r.id, status: "DRY_RUN", txHash: null, note: outcome.reason });
    }
  }
  return result;
}

/** Ledger "REFUND" entry — every outcome (SENT, DRY_RUN, FAILED) is on the hash chain, nothing is hidden. */
async function ledger(r: Refund): Promise<string> {
  const entry = await appendDecision({
    kind: "REFUND", subject: r.payer, clientId: REFUND_CLIENT_ID,
    payload: {
      type: "REFUND", refundId: r.id, payer: r.payer, amount: r.amountUsdc, reason: r.reason, originalTx: r.originalTx, refundTx: r.txHash ?? null,
      endpoint: r.endpoint, source: r.source, status: r.status, simulated: r.status !== "SENT", note: r.note, attempts: r.attempts, at: r.sentAt ?? now(),
    },
  });
  return entry.id;
}

// ─── wiring ──────────────────────────────────────────────────────────────────
let installed = false;
/**
 * Hook the x402 layer: a settled-but-undelivered payment is queued and (REFUND_AUTO_PROCESS≠0) sent right away.
 * Idempotent. Call it next to `ensurePaymentSink()` (src/lib/payments.ts) so every paid route has it.
 */
export function installRefundSink(): void {
  if (installed) return;
  installed = true;
  setRefundSink(async (e: RefundNeededEvent) => {
    await queueRefund({ payer: e.payer, amountUsdc: e.amountUsdc, reason: e.reason, originalTx: e.settleTxHash, endpoint: e.endpoint, source: "auto" });
    if (refundConfig().autoProcess) processRefunds().catch((err) => console.error("[complir/refunds] auto-process failed:", err));
  });
}
/** test helper */
export function __resetRefundSink() { installed = false; }

export interface RefundStatusView { mode: RefundMode; dailyCapUsdc: number; sentTodayUsdc: number; queued: number; dryRun: number; failed: number; sent: number }
export async function refundStatus(): Promise<RefundStatusView> {
  await migrateRefunds();
  const r = await db().execute(`SELECT status, COUNT(*) AS n FROM refunds GROUP BY status`);
  const counts: Record<string, number> = {};
  for (const row of r.rows) counts[String((row as Record<string, unknown>).status)] = num((row as Record<string, unknown>).n);
  return { mode: refundMode(), dailyCapUsdc: refundConfig().dailyCapUsdc, sentTodayUsdc: await refundedTodayUsdc(), queued: counts.QUEUED ?? 0, dryRun: counts.DRY_RUN ?? 0, failed: counts.FAILED ?? 0, sent: counts.SENT ?? 0 };
}
