/**
 * Treasury invoices + daily spend. Own tables on the shared libsql client (src/lib/store/db.ts);
 * migrations live here so the core schema stays untouched.
 */
import { z } from "zod";
import { db, migrate } from "../store/db";
import { AddressSchema, type Address, type Tier } from "../types";
import type { PayoutAction } from "./policy";

export const INVOICE_STATUSES = ["PENDING", "PAID", "LIMITED", "SCHEDULED", "HELD", "FAILED"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface Invoice {
  id: string;
  payee: Address;
  label: string;
  amountUsdc: number;
  memo: string | null;
  status: InvoiceStatus;
  /** verdict (SCREEN) decision id - replay at /log/{decisionId} */
  decisionId: string | null;
  /** PAYOUT ledger entry id (the signed payout decision) */
  payoutDecisionId: string | null;
  /** keccak256 of the verdict's canonical decision JSON - the proof `releaseWithProof` was paid against (null until decided) */
  decisionHash: `0x${string}` | null;
  /** latest release tx (tranche releases overwrite it; every tranche keeps its own tx in `invoice_tranches`) */
  txHash: `0x${string}` | null;
  paidUsdc: number;
  heldUsdc: number;
  action: PayoutAction | null;
  tier: Tier | null;
  score: number | null;
  reason: string | null;
  mode: "dry-run" | "live" | null;
  createdAt: number;
  decidedAt: number | null;
}

export const NewInvoiceSchema = z.object({
  payee: AddressSchema,
  label: z.string().trim().min(1).max(80),
  amountUsdc: z.number().positive().max(1_000_000),
  memo: z.string().trim().max(280).optional(),
});
export type NewInvoice = z.infer<typeof NewInvoiceSchema>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS treasury_invoices (
     id TEXT PRIMARY KEY, payee TEXT NOT NULL, label TEXT NOT NULL, amount_usdc REAL NOT NULL, memo TEXT,
     status TEXT NOT NULL DEFAULT 'PENDING', decision_id TEXT, payout_decision_id TEXT, tx_hash TEXT,
     paid_usdc REAL NOT NULL DEFAULT 0, held_usdc REAL NOT NULL DEFAULT 0, action TEXT, tier TEXT, score INTEGER,
     reason TEXT, mode TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS treasury_invoices_status ON treasury_invoices(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS treasury_spend (day TEXT PRIMARY KEY, spent_usdc REAL NOT NULL DEFAULT 0, payouts INTEGER NOT NULL DEFAULT 0)`,
  // risk-aware routing: MEDIUM payees are paid in tranches (src/lib/treasury/schedule.ts)
  `CREATE TABLE IF NOT EXISTS invoice_tranches (
     invoice_id TEXT NOT NULL, n INTEGER NOT NULL, amount REAL NOT NULL, due_condition TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'PENDING', tx TEXT, decision_id TEXT, decision_hash TEXT, note TEXT,
     created_at INTEGER NOT NULL, released_at INTEGER, PRIMARY KEY (invoice_id, n))`,
  `CREATE INDEX IF NOT EXISTS invoice_tranches_status ON invoice_tranches(status, invoice_id)`,
];
/** additive columns on existing tables (SQLite has no ADD COLUMN IF NOT EXISTS) */
const ALTERS = [`ALTER TABLE treasury_invoices ADD COLUMN decision_hash TEXT`];

let migrated: Promise<void> | null = null;
export function migrateTreasury(): Promise<void> {
  if (!migrated) migrated = (async () => {
    await migrate();
    for (const s of SCHEMA) await db().execute(s);
    for (const s of ALTERS) { try { await db().execute(s); } catch { /* column exists */ } }
  })();
  return migrated;
}
/** test helper */
export function __resetTreasury() { migrated = null; }

const now = () => Math.floor(Date.now() / 1000);
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => Number(v ?? 0);

function rowToInvoice(r: Record<string, unknown>): Invoice {
  return {
    id: String(r.id), payee: String(r.payee) as Address, label: String(r.label), amountUsdc: num(r.amount_usdc), memo: str(r.memo),
    status: r.status as InvoiceStatus, decisionId: str(r.decision_id), payoutDecisionId: str(r.payout_decision_id),
    decisionHash: str(r.decision_hash) as `0x${string}` | null, txHash: str(r.tx_hash) as `0x${string}` | null, paidUsdc: num(r.paid_usdc), heldUsdc: num(r.held_usdc),
    action: str(r.action) as PayoutAction | null, tier: str(r.tier) as Tier | null, score: r.score == null ? null : num(r.score),
    reason: str(r.reason), mode: str(r.mode) as Invoice["mode"], createdAt: num(r.created_at), decidedAt: r.decided_at == null ? null : num(r.decided_at),
  };
}

function newId(): string {
  return `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function createInvoice(input: NewInvoice, id = newId(), createdAt = now()): Promise<Invoice> {
  await migrateTreasury();
  const inv = NewInvoiceSchema.parse(input);
  await db().execute({
    sql: `INSERT OR IGNORE INTO treasury_invoices (id, payee, label, amount_usdc, memo, status, created_at) VALUES (?,?,?,?,?,'PENDING',?)`,
    args: [id, inv.payee, inv.label, inv.amountUsdc, inv.memo ?? null, createdAt],
  });
  return (await getInvoice(id))!;
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  await migrateTreasury();
  const r = await db().execute({ sql: `SELECT * FROM treasury_invoices WHERE id = ?`, args: [id] });
  return r.rows[0] ? rowToInvoice(r.rows[0] as Record<string, unknown>) : null;
}

export async function listInvoices(limit = 200): Promise<Invoice[]> {
  await migrateTreasury();
  const r = await db().execute({ sql: `SELECT * FROM treasury_invoices ORDER BY created_at DESC, id DESC LIMIT ?`, args: [Math.min(Math.max(limit, 1), 1000)] });
  return r.rows.map((x) => rowToInvoice(x as Record<string, unknown>));
}

export async function pendingInvoices(): Promise<Invoice[]> {
  await migrateTreasury();
  const r = await db().execute(`SELECT * FROM treasury_invoices WHERE status = 'PENDING' ORDER BY created_at ASC, id ASC`);
  return r.rows.map((x) => rowToInvoice(x as Record<string, unknown>));
}

/**
 * The agent's payee book: every payee we have actually paid (PAID / LIMITED), label + address.
 * Used for lookalike (address-poisoning) detection on *new* addresses - a never-paid address that resembles
 * a trusted payee is suspicious; a payee that is itself in the book is screened on its own merits.
 */
export async function payeeBook(opts: { all?: boolean } = {}): Promise<{ label: string; address: Address }[]> {
  await migrateTreasury();
  const where = opts.all ? "" : "WHERE status IN ('PAID','LIMITED','SCHEDULED')";
  const r = await db().execute(`SELECT label, payee FROM treasury_invoices ${where} GROUP BY payee ORDER BY MIN(created_at) ASC`);
  return r.rows.map((x) => ({ label: String(x.label), address: String(x.payee) as Address }));
}

export interface InvoiceOutcome {
  status: InvoiceStatus;
  decisionId: string | null;
  payoutDecisionId: string | null;
  decisionHash?: `0x${string}` | null;
  txHash: `0x${string}` | null;
  paidUsdc: number;
  heldUsdc: number;
  action: PayoutAction | null;
  tier: Tier | null;
  score: number | null;
  reason: string;
  mode: "dry-run" | "live";
}
export async function settleInvoice(id: string, o: InvoiceOutcome): Promise<void> {
  await migrateTreasury();
  await db().execute({
    sql: `UPDATE treasury_invoices SET status=?, decision_id=?, payout_decision_id=?, decision_hash=?, tx_hash=?, paid_usdc=?, held_usdc=?, action=?, tier=?, score=?, reason=?, mode=?, decided_at=? WHERE id=?`,
    args: [o.status, o.decisionId, o.payoutDecisionId, o.decisionHash ?? null, o.txHash, o.paidUsdc, o.heldUsdc, o.action, o.tier, o.score, o.reason, o.mode, now(), id],
  });
}

/** Progress update for a SCHEDULED invoice after a tranche was released / cancelled (status stays SCHEDULED). */
export async function updateScheduledInvoice(id: string, o: { paidUsdc: number; heldUsdc: number; txHash: `0x${string}` | null; reason: string; payoutDecisionId: string | null }): Promise<void> {
  await migrateTreasury();
  await db().execute({
    sql: `UPDATE treasury_invoices SET paid_usdc=?, held_usdc=?, tx_hash=COALESCE(?, tx_hash), reason=?, payout_decision_id=COALESCE(?, payout_decision_id), decided_at=? WHERE id=? AND status='SCHEDULED'`,
    args: [o.paidUsdc, o.heldUsdc, o.txHash, o.reason, o.payoutDecisionId, now(), id],
  });
}

/** Terminal status once every tranche is RELEASED or CANCELLED (PAID when all released and nothing unscheduled, else LIMITED). */
export async function finalizeScheduledInvoice(id: string, status: "PAID" | "LIMITED"): Promise<void> {
  await migrateTreasury();
  await db().execute({ sql: `UPDATE treasury_invoices SET status=?, action=?, decided_at=? WHERE id=? AND status='SCHEDULED'`, args: [status, status === "PAID" ? "PAY" : "LIMIT", now(), id] });
}

export async function scheduledInvoices(): Promise<Invoice[]> {
  await migrateTreasury();
  const r = await db().execute(`SELECT * FROM treasury_invoices WHERE status = 'SCHEDULED' ORDER BY created_at ASC, id ASC`);
  return r.rows.map((x) => rowToInvoice(x as Record<string, unknown>));
}

// ── tranches (risk-aware routing) ────────────────────────────────────────────
export const TRANCHE_STATUSES = ["PENDING", "RELEASED", "CANCELLED"] as const;
export type TrancheStatus = (typeof TRANCHE_STATUSES)[number];
export interface TrancheRow<C = unknown> {
  invoiceId: string;
  n: number;
  amountUsdc: number;
  dueCondition: C;
  status: TrancheStatus;
  txHash: `0x${string}` | null;
  /** verdict (SCREEN/RESCREEN) decision id the tranche was released against */
  decisionId: string | null;
  decisionHash: `0x${string}` | null;
  /** why it is still pending / was cancelled */
  note: string | null;
  createdAt: number;
  releasedAt: number | null;
}
function rowToTranche(r: Record<string, unknown>): TrancheRow {
  let cond: unknown = null;
  try { cond = JSON.parse(String(r.due_condition)); } catch { cond = null; }
  return {
    invoiceId: String(r.invoice_id), n: num(r.n), amountUsdc: num(r.amount), dueCondition: cond, status: String(r.status) as TrancheStatus,
    txHash: str(r.tx) as `0x${string}` | null, decisionId: str(r.decision_id), decisionHash: str(r.decision_hash) as `0x${string}` | null,
    note: str(r.note), createdAt: num(r.created_at), releasedAt: r.released_at == null ? null : num(r.released_at),
  };
}
export async function insertTranches(invoiceId: string, rows: { n: number; amountUsdc: number; dueCondition: unknown }[], createdAt = now()): Promise<void> {
  await migrateTreasury();
  for (const t of rows) {
    await db().execute({
      sql: `INSERT OR IGNORE INTO invoice_tranches (invoice_id, n, amount, due_condition, status, created_at) VALUES (?,?,?,?,'PENDING',?)`,
      args: [invoiceId, t.n, t.amountUsdc, JSON.stringify(t.dueCondition), createdAt],
    });
  }
}
export async function listTranches(invoiceId: string): Promise<TrancheRow[]> {
  await migrateTreasury();
  const r = await db().execute({ sql: `SELECT * FROM invoice_tranches WHERE invoice_id = ? ORDER BY n ASC`, args: [invoiceId] });
  return r.rows.map((x) => rowToTranche(x as Record<string, unknown>));
}
/** tranches for many invoices at once (the page) */
export async function tranchesByInvoice(invoiceIds: string[]): Promise<Record<string, TrancheRow[]>> {
  await migrateTreasury();
  const out: Record<string, TrancheRow[]> = {};
  if (!invoiceIds.length) return out;
  const r = await db().execute({ sql: `SELECT * FROM invoice_tranches WHERE invoice_id IN (${invoiceIds.map(() => "?").join(",")}) ORDER BY invoice_id, n ASC`, args: invoiceIds });
  for (const x of r.rows) { const t = rowToTranche(x as Record<string, unknown>); (out[t.invoiceId] ??= []).push(t); }
  return out;
}
export async function markTrancheReleased(invoiceId: string, n: number, o: { txHash: `0x${string}` | null; decisionId: string | null; decisionHash: `0x${string}` | null; note: string | null }, at = now()): Promise<void> {
  await migrateTreasury();
  await db().execute({
    sql: `UPDATE invoice_tranches SET status='RELEASED', tx=?, decision_id=?, decision_hash=?, note=?, released_at=? WHERE invoice_id=? AND n=? AND status='PENDING'`,
    args: [o.txHash, o.decisionId, o.decisionHash, o.note, at, invoiceId, n],
  });
}
export async function noteTranche(invoiceId: string, n: number, note: string): Promise<void> {
  await migrateTreasury();
  await db().execute({ sql: `UPDATE invoice_tranches SET note=? WHERE invoice_id=? AND n=? AND status='PENDING'`, args: [note, invoiceId, n] });
}
/** HIGH re-grade (or expiry): every PENDING tranche of the invoice is cancelled. Returns how many. */
export async function cancelPendingTranches(invoiceId: string, note: string, decisionId: string | null = null): Promise<number> {
  await migrateTreasury();
  const r = await db().execute({ sql: `UPDATE invoice_tranches SET status='CANCELLED', note=?, decision_id=COALESCE(?, decision_id) WHERE invoice_id=? AND status='PENDING'`, args: [note, decisionId, invoiceId] });
  return r.rowsAffected;
}

/** Re-queue a HELD / FAILED invoice (e.g. after the payee was re-screened). */
export async function requeueInvoice(id: string): Promise<void> {
  await migrateTreasury();
  await db().execute({ sql: `UPDATE treasury_invoices SET status='PENDING', decided_at=NULL WHERE id=? AND status IN ('HELD','FAILED')`, args: [id] });
}

// ── daily spend ──────────────────────────────────────────────────────────────
export function dayKey(unix = now()): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}
export async function spentToday(unix = now()): Promise<number> {
  await migrateTreasury();
  const r = await db().execute({ sql: `SELECT spent_usdc FROM treasury_spend WHERE day = ?`, args: [dayKey(unix)] });
  return r.rows[0] ? num((r.rows[0] as Record<string, unknown>).spent_usdc) : 0;
}
export async function addSpend(amountUsdc: number, unix = now()): Promise<void> {
  await migrateTreasury();
  if (amountUsdc <= 0) return;
  await db().execute({
    sql: `INSERT INTO treasury_spend (day, spent_usdc, payouts) VALUES (?,?,1)
          ON CONFLICT(day) DO UPDATE SET spent_usdc = spent_usdc + excluded.spent_usdc, payouts = payouts + 1`,
    args: [dayKey(unix), amountUsdc],
  });
}

// ── totals for the page ──────────────────────────────────────────────────────
export interface InvoiceTotals { paid: number; limited: number; scheduled: number; held: number; count: number; pending: number; failed: number; paidUsdc: number; heldUsdc: number }
export async function invoiceTotals(): Promise<InvoiceTotals> {
  await migrateTreasury();
  const r = await db().execute(`SELECT status, COUNT(*) AS n, COALESCE(SUM(paid_usdc),0) AS paid, COALESCE(SUM(held_usdc),0) AS held FROM treasury_invoices GROUP BY status`);
  const t: InvoiceTotals = { paid: 0, limited: 0, scheduled: 0, held: 0, count: 0, pending: 0, failed: 0, paidUsdc: 0, heldUsdc: 0 };
  for (const row of r.rows as unknown as Record<string, unknown>[]) {
    const n = num(row.n);
    t.count += n; t.paidUsdc += num(row.paid); t.heldUsdc += num(row.held);
    switch (String(row.status)) {
      case "PAID": t.paid += n; break;
      case "LIMITED": t.limited += n; break;
      case "SCHEDULED": t.scheduled += n; break;
      case "HELD": t.held += n; break;
      case "PENDING": t.pending += n; break;
      case "FAILED": t.failed += n; break;
    }
  }
  t.paidUsdc = Math.round(t.paidUsdc * 1e6) / 1e6; t.heldUsdc = Math.round(t.heldUsdc * 1e6) / 1e6;
  return t;
}

// ── demo seed (idempotent: fixed ids, INSERT OR IGNORE) ──────────────────────
/** No synthetic invoices: every invoice is created by a real request (UI or API). Kept as an empty list so seeding is a no-op. */
export const DEMO_INVOICES: (NewInvoice & { id: string })[] = [];
export async function seedDemoInvoices(): Promise<{ inserted: number }> {
  await migrateTreasury();
  let inserted = 0;
  const base = now() - DEMO_INVOICES.length;
  for (const [i, d] of DEMO_INVOICES.entries()) {
    const before = await getInvoice(d.id);
    if (before) continue;
    await createInvoice(d, d.id, base + i); // deterministic processing order: cafe → beef → dead
    inserted++;
  }
  return { inserted };
}
