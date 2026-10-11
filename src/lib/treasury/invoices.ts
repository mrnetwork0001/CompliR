/**
 * Treasury invoices + daily spend. Own tables on the shared libsql client (src/lib/store/db.ts);
 * migrations live here so the core schema stays untouched.
 */
import { z } from "zod";
import { db, migrate } from "../store/db";
import { AddressSchema, type Address, type Tier } from "../types";
import type { PayoutAction } from "./policy";

export const INVOICE_STATUSES = ["PENDING", "PAID", "LIMITED", "HELD", "FAILED"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface Invoice {
  id: string;
  payee: Address;
  label: string;
  amountUsdc: number;
  memo: string | null;
  status: InvoiceStatus;
  /** verdict (SCREEN) decision id — replay at /log/{decisionId} */
  decisionId: string | null;
  /** PAYOUT ledger entry id (the signed payout decision) */
  payoutDecisionId: string | null;
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
];

let migrated: Promise<void> | null = null;
export function migrateTreasury(): Promise<void> {
  if (!migrated) migrated = (async () => { await migrate(); for (const s of SCHEMA) await db().execute(s); })();
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
    txHash: str(r.tx_hash) as `0x${string}` | null, paidUsdc: num(r.paid_usdc), heldUsdc: num(r.held_usdc),
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
 * Used for lookalike (address-poisoning) detection on *new* addresses — a never-paid address that resembles
 * a trusted payee is suspicious; a payee that is itself in the book is screened on its own merits.
 */
export async function payeeBook(opts: { all?: boolean } = {}): Promise<{ label: string; address: Address }[]> {
  await migrateTreasury();
  const where = opts.all ? "" : "WHERE status IN ('PAID','LIMITED')";
  const r = await db().execute(`SELECT label, payee FROM treasury_invoices ${where} GROUP BY payee ORDER BY MIN(created_at) ASC`);
  return r.rows.map((x) => ({ label: String(x.label), address: String(x.payee) as Address }));
}

export interface InvoiceOutcome {
  status: InvoiceStatus;
  decisionId: string | null;
  payoutDecisionId: string | null;
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
    sql: `UPDATE treasury_invoices SET status=?, decision_id=?, payout_decision_id=?, tx_hash=?, paid_usdc=?, held_usdc=?, action=?, tier=?, score=?, reason=?, mode=?, decided_at=? WHERE id=?`,
    args: [o.status, o.decisionId, o.payoutDecisionId, o.txHash, o.paidUsdc, o.heldUsdc, o.action, o.tier, o.score, o.reason, o.mode, now(), id],
  });
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
export interface InvoiceTotals { paid: number; limited: number; held: number; count: number; pending: number; failed: number; paidUsdc: number; heldUsdc: number }
export async function invoiceTotals(): Promise<InvoiceTotals> {
  await migrateTreasury();
  const r = await db().execute(`SELECT status, COUNT(*) AS n, COALESCE(SUM(paid_usdc),0) AS paid, COALESCE(SUM(held_usdc),0) AS held FROM treasury_invoices GROUP BY status`);
  const t: InvoiceTotals = { paid: 0, limited: 0, held: 0, count: 0, pending: 0, failed: 0, paidUsdc: 0, heldUsdc: 0 };
  for (const row of r.rows as unknown as Record<string, unknown>[]) {
    const n = num(row.n);
    t.count += n; t.paidUsdc += num(row.paid); t.heldUsdc += num(row.held);
    switch (String(row.status)) {
      case "PAID": t.paid += n; break;
      case "LIMITED": t.limited += n; break;
      case "HELD": t.held += n; break;
      case "PENDING": t.pending += n; break;
      case "FAILED": t.failed += n; break;
    }
  }
  t.paidUsdc = Math.round(t.paidUsdc * 1e6) / 1e6; t.heldUsdc = Math.round(t.heldUsdc * 1e6) / 1e6;
  return t;
}

// ── demo seed (idempotent: fixed ids, INSERT OR IGNORE) ──────────────────────
export const DEMO_INVOICES: (NewInvoice & { id: string })[] = [
  { id: "inv_demo_cafe", payee: "0x000000000000000000000000000000000000cafe", label: "Lela — logo design", amountUsdc: 10, memo: "Invoice #1041, brand refresh" },
  { id: "inv_demo_beef", payee: "0x000000000000000000000000000000000000beef", label: "Nova Labs — API work", amountUsdc: 120, memo: "Sprint 7, milestone 2" },
  { id: "inv_demo_dead", payee: "0x000000000000000000000000000000000000dead", label: "Unknown vendor", amountUsdc: 50, memo: "Unsolicited invoice received by email" },
];
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
