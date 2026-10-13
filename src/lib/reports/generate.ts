/**
 * Daily traction report, written and signed by the agent itself (docs/TRACTION.md).
 *
 * Honest by construction: own wallets + internal client ids are excluded and *listed*, every outside payer carries a
 * tx link, refunds and mistakes get their own section, and the caveat line says the numbers are self-reported.
 *
 *   generateDailyReport(date) → { report (JSON), markdown }
 *   publishReport(date)       → hash = keccak256(canonical(report)); signature = attester EIP-191 signMessage(hash);
 *                               ledger "REPORT" entry; stored in `reports` (idempotent per date; `force` regenerates)
 *
 * Verify: viem `verifyMessage({ address: signer, message: hash, signature })` where hash = keccak256(canonical(report)).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalize, hashCanonical } from "../attest/canonical";
import { config } from "../config";
import { appendDecision } from "../ledger";
import { attesterPrivateKey } from "../pipeline";
import { refundsBetween, type RefundStatus } from "../refunds";
import { db, migrate } from "../store/db";
import { INTERNAL_CLIENT_IDS, lastDecision, maskAddress, ownWallets } from "../store/repo";
import type { Address, Tier } from "../types";
import { renderReportMarkdown } from "./markdown";

export const REPORT_VERSION = 1 as const;
export const REPORT_CLIENT_ID = "report";
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface OutsidePayer {
  address: Address;
  addressUrl: string;
  calls: number;
  /** Net of refunds. */
  usdcPaid: number;
  usdcRefunded: number;
  firstTx: string | null;
  firstTxUrl: string | null;
  endpoints: string[];
}
export interface ReportRefund {
  id: string; payer: Address; amountUsdc: number; reason: string; status: RefundStatus; source: "auto" | "manual";
  originalTx: string | null; originalTxUrl: string | null; refundTx: string | null; refundTxUrl: string | null; queuedAt: string; sentAt: string | null;
}
export interface ReportMistake { date?: string; what: string; refundTx?: string | null; refundTxUrl?: string | null }
export interface ReportIntegration { name: string; repo: string | null; status: string; pr: string | null; notes: boolean }

export interface DailyReport {
  version: typeof REPORT_VERSION;
  generator: "complir-report-agent";
  date: string;
  period: { from: string; to: string; /** true once the period has ended (numbers will not move). */ final: boolean };
  generatedAt: string;
  chain: { chainId: number; explorerUrl: string; usdc: string };
  signer: Address;
  totals: { outsidePayers: number; paidCalls: number; usdcIn: number; usdcGross: number; usdcRefunded: number };
  outsidePayers: OutsidePayer[];
  excluded: { ownWallets: string[]; internalClientIds: string[]; ownPayments: number; ownPaymentsUsdc: number; ownScreenings: number };
  screenings: { total: number; outside: number; byTier: Record<Tier, number>; outsideByTier: Record<Tier, number> };
  watches: { created: number; active: number };
  tierChanges: { count: number; items: { address: string; from: Tier | null; to: Tier; decisionId: string | null }[] };
  payouts: { count: number; paid: number; limited: number; held: number; failed: number; paidUsdc: number; heldUsdc: number; simulated: number };
  refunds: { count: number; sentUsdc: number; owedUsdc: number; items: ReportRefund[] };
  mistakes: ReportMistake[];
  notes: string[];
  integrations: ReportIntegration[];
  ledger: { lastSeq: number; headHash: string | null };
  caveats: string[];
}

export interface StoredReport {
  date: string;
  report: DailyReport;
  markdown: string;
  hash: `0x${string}`;
  signature: `0x${string}`;
  signer: Address;
  ledgerId: string | null;
  createdAt: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reports (
     date TEXT PRIMARY KEY, json TEXT NOT NULL, markdown TEXT NOT NULL, hash TEXT NOT NULL, signature TEXT NOT NULL,
     signer TEXT NOT NULL, ledger_id TEXT, created_at INTEGER NOT NULL)`,
];
let migrated: Promise<void> | null = null;
export function migrateReports(): Promise<void> {
  if (!migrated) migrated = (async () => { await migrate(); for (const s of SCHEMA) await db().execute(s); })();
  return migrated;
}
/** test helper */
export function __resetReports() { migrated = null; }

const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (v == null ? null : String(v));
const round6 = (n: number) => Number(n.toFixed(6));
const iso = (unix: number) => new Date(unix * 1000).toISOString();
const TX = /^0x[0-9a-fA-F]{64}$/;

export function todayUtc(at = Date.now()): string { return new Date(at).toISOString().slice(0, 10); }
export function yesterdayUtc(at = Date.now()): string { return todayUtc(at - 86_400_000); }
export function periodFor(date: string): { from: number; to: number } {
  if (!DATE_RE.test(date)) throw new Error(`report date must be YYYY-MM-DD, got ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  const from = Date.UTC(y, m - 1, d) / 1000;
  if (!Number.isFinite(from) || iso(from).slice(0, 10) !== date) throw new Error(`invalid calendar date ${date}`);
  return { from, to: from + 86_400 };
}
const explorer = (base: string) => base.replace(/\/+$/, "");
export const txUrl = (base: string, h: string | null) => (h && TX.test(h) ? `${explorer(base)}/tx/${h}` : null);
export const addressUrl = (base: string, a: string) => `${explorer(base)}/address/${a}`;

// ─── notes file (.data/report-notes.json) ────────────────────────────────────
/**
 * Shape (every key optional):
 * {
 *   "notes":        [{ "date": "2026-10-13", "text": "free text" }],
 *   "mistakes":     [{ "date": "2026-10-13", "what": "charged twice for …", "refundTx": "0x…" }],
 *   "integrations": { "steward": { "repo": "big14way/steward", "status": "opened", "pr": "https://github.com/…/pull/1" } }
 * }
 * Entries with a `date` show up on that day's report only; entries without a date show up on every report.
 */
export interface ReportNotes {
  notes?: { date?: string; text: string }[];
  mistakes?: ReportMistake[];
  integrations?: Record<string, { repo?: string; status?: string; pr?: string }>;
}
export function notesPath(): string {
  return process.env.REPORT_NOTES_PATH?.trim() || path.join(process.cwd(), ".data", "report-notes.json");
}
export async function readReportNotes(): Promise<ReportNotes> {
  try {
    const raw = JSON.parse(await readFile(/*turbopackIgnore: true*/ notesPath(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const o = raw as Record<string, unknown>;
    const notes = Array.isArray(o.notes) ? o.notes.filter((n): n is { date?: string; text: string } => !!n && typeof n === "object" && typeof (n as { text?: unknown }).text === "string") : [];
    const mistakes = Array.isArray(o.mistakes) ? o.mistakes.filter((m): m is ReportMistake => !!m && typeof m === "object" && typeof (m as { what?: unknown }).what === "string") : [];
    const integrations = o.integrations && typeof o.integrations === "object" && !Array.isArray(o.integrations) ? (o.integrations as ReportNotes["integrations"]) : {};
    return { notes, mistakes, integrations };
  } catch {
    return {};
  }
}

export function integrationsDir(): string {
  return process.env.REPORT_INTEGRATIONS_DIR?.trim() || path.join(process.cwd(), "docs", "integrations");
}
async function listIntegrations(notes: ReportNotes): Promise<ReportIntegration[]> {
  const out: ReportIntegration[] = [];
  const seen = new Set<string>();
  try {
    for (const name of (await readdir(/*turbopackIgnore: true*/ integrationsDir())).sort()) {
      const dir = path.join(/*turbopackIgnore: true*/ integrationsDir(), name);
      try { if (!(await stat(/*turbopackIgnore: true*/ dir)).isDirectory()) continue; } catch { continue; }
      let hasNotes = false;
      try { hasNotes = (await stat(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, "NOTES.md"))).isFile(); } catch { /* none */ }
      const n = notes.integrations?.[name];
      seen.add(name);
      out.push({ name, repo: n?.repo ?? null, status: n?.status ?? "prepared, not submitted", pr: n?.pr ?? null, notes: hasNotes });
    }
  } catch { /* no docs/integrations */ }
  for (const [name, n] of Object.entries(notes.integrations ?? {})) {
    if (seen.has(name)) continue;
    out.push({ name, repo: n?.repo ?? null, status: n?.status ?? "unknown", pr: n?.pr ?? null, notes: false });
  }
  return out;
}

// ─── generation ──────────────────────────────────────────────────────────────
export async function generateDailyReport(date: string, opts: { now?: number } = {}): Promise<{ report: DailyReport; markdown: string }> {
  await migrateReports();
  const { from, to } = periodFor(date);
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const c = config();
  const explorerUrl = explorer(c.ARC_EXPLORER_URL);
  const own = ownWallets();
  const internal = [...INTERNAL_CLIENT_IDS].sort();
  const isOwn = (p: string) => own.has(p.toLowerCase()) || INTERNAL_CLIENT_IDS.has(p.toLowerCase());
  const d = db();
  const signer = privateKeyToAccount(attesterPrivateKey()).address.toLowerCase() as Address;

  // payments
  const pays = (await d.execute({ sql: `SELECT * FROM payments WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC, id ASC`, args: [from, to] })).rows as Record<string, unknown>[];
  const byPayer = new Map<string, OutsidePayer>();
  let ownPayments = 0, ownPaymentsUsdc = 0, gross = 0, refundedUsdc = 0, paidCalls = 0;
  for (const p of pays) {
    const payer = String(p.payer).toLowerCase();
    const amount = num(p.amount_usdc);
    if (isOwn(payer)) { ownPayments++; ownPaymentsUsdc = round6(ownPaymentsUsdc + amount); continue; }
    const refunded = num(p.refunded) > 0;
    const tx = str(p.tx_hash);
    let e = byPayer.get(payer);
    if (!e) { e = { address: payer as Address, addressUrl: addressUrl(explorerUrl, payer), calls: 0, usdcPaid: 0, usdcRefunded: 0, firstTx: null, firstTxUrl: null, endpoints: [] }; byPayer.set(payer, e); }
    e.calls++; paidCalls++; gross = round6(gross + amount);
    if (refunded) { e.usdcRefunded = round6(e.usdcRefunded + amount); refundedUsdc = round6(refundedUsdc + amount); } else e.usdcPaid = round6(e.usdcPaid + amount);
    if (!e.firstTx && tx) { e.firstTx = tx; e.firstTxUrl = txUrl(explorerUrl, tx); }
    const ep = String(p.endpoint); if (!e.endpoints.includes(ep)) e.endpoints.push(ep);
  }
  const outsidePayers = [...byPayer.values()].sort((a, b) => b.usdcPaid - a.usdcPaid || a.address.localeCompare(b.address));

  // screenings
  const tiers = (await d.execute({ sql: `SELECT tier, payer, COUNT(*) AS n FROM screenings WHERE created_at >= ? AND created_at < ? GROUP BY tier, payer`, args: [from, to] })).rows as Record<string, unknown>[];
  const byTier: Record<Tier, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  const outsideByTier: Record<Tier, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  let screeningsTotal = 0, screeningsOutside = 0, ownScreenings = 0;
  for (const r of tiers) {
    const t = String(r.tier) as Tier; const n = num(r.n); const ownRow = String(r.payer) === "own";
    if (!(t in byTier)) continue;
    byTier[t] += n; screeningsTotal += n;
    if (ownRow) ownScreenings += n; else { outsideByTier[t] += n; screeningsOutside += n; }
  }

  // watches
  const wCreated = num(((await d.execute({ sql: `SELECT COUNT(*) AS n FROM watches WHERE created_at >= ? AND created_at < ?`, args: [from, to] })).rows[0] as Record<string, unknown>).n);
  const wActive = num(((await d.execute({ sql: `SELECT COUNT(*) AS n FROM watches WHERE created_at < ? AND expires_at > ?`, args: [to, Math.min(to, nowSec)] })).rows[0] as Record<string, unknown>).n);

  // ledger-derived: tier changes + payouts
  const decs = (await d.execute({ sql: `SELECT kind, subject, payload, id FROM decisions WHERE created_at >= ? AND created_at < ? AND kind IN ('TIER_CHANGE','PAYOUT') ORDER BY seq ASC`, args: [from, to] })).rows as Record<string, unknown>[];
  const tierItems: DailyReport["tierChanges"]["items"] = [];
  const payouts = { count: 0, paid: 0, limited: 0, held: 0, failed: 0, paidUsdc: 0, heldUsdc: 0, simulated: 0 };
  for (const r of decs) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(String(r.payload)); } catch { /* ignore */ }
    if (r.kind === "TIER_CHANGE") {
      tierItems.push({ address: maskAddress(String(r.subject ?? "")), from: (payload.from as Tier | null) ?? null, to: payload.to as Tier, decisionId: str(payload.decisionId) });
    } else {
      payouts.count++;
      const s = String(payload.status ?? "");
      if (s === "PAID") payouts.paid++; else if (s === "LIMITED") payouts.limited++; else if (s === "HELD") payouts.held++; else if (s === "FAILED") payouts.failed++;
      payouts.paidUsdc = round6(payouts.paidUsdc + num(payload.paidUsdc)); payouts.heldUsdc = round6(payouts.heldUsdc + num(payload.heldUsdc));
      if (payload.simulated) payouts.simulated++;
    }
  }

  // refunds + notes
  const refundRows = await refundsBetween(from, to);
  const refundItems: ReportRefund[] = refundRows.map((r) => ({
    id: r.id, payer: r.payer, amountUsdc: r.amountUsdc, reason: r.reason, status: r.status, source: r.source,
    originalTx: r.originalTx, originalTxUrl: txUrl(explorerUrl, r.originalTx), refundTx: r.txHash, refundTxUrl: txUrl(explorerUrl, r.txHash),
    queuedAt: iso(r.createdAt), sentAt: r.sentAt ? iso(r.sentAt) : null,
  }));
  const sentUsdc = round6(refundRows.filter((r) => r.status === "SENT").reduce((a, r) => a + r.amountUsdc, 0));
  const owedUsdc = round6(refundRows.filter((r) => r.status !== "SENT").reduce((a, r) => a + r.amountUsdc, 0));
  const notes = await readReportNotes();
  const forDay = <T extends { date?: string }>(xs: T[] | undefined) => (xs ?? []).filter((x) => !x.date || x.date === date);
  const mistakes = forDay(notes.mistakes).map((m) => ({ ...m, refundTx: m.refundTx ?? null, refundTxUrl: txUrl(explorerUrl, m.refundTx ?? null) }));
  const head = await lastDecision();

  const report: DailyReport = {
    version: REPORT_VERSION, generator: "complir-report-agent", date,
    period: { from: iso(from), to: iso(to), final: nowSec >= to },
    generatedAt: iso(nowSec),
    chain: { chainId: c.ARC_CHAIN_ID, explorerUrl, usdc: c.USDC_ADDRESS.toLowerCase() },
    signer,
    totals: { outsidePayers: outsidePayers.length, paidCalls, usdcIn: round6(gross - refundedUsdc), usdcGross: gross, usdcRefunded: refundedUsdc },
    outsidePayers,
    excluded: { ownWallets: [...own].sort(), internalClientIds: internal, ownPayments, ownPaymentsUsdc, ownScreenings },
    screenings: { total: screeningsTotal, outside: screeningsOutside, byTier, outsideByTier },
    watches: { created: wCreated, active: wActive },
    tierChanges: { count: tierItems.length, items: tierItems },
    payouts,
    refunds: { count: refundItems.length, sentUsdc, owedUsdc, items: refundItems },
    mistakes,
    notes: forDay(notes.notes).map((n) => n.text),
    integrations: await listIntegrations(notes),
    ledger: { lastSeq: head?.seq ?? 0, headHash: head?.hash ?? null },
    caveats: [
      "Numbers are self-reported by the CompliR agent from its own database; verify every USDC figure via the tx links.",
      `Own wallets (${own.size}) and internal client ids (${internal.length}) are excluded from every count and listed above.`,
      "Refunds marked DRY_RUN or QUEUED have NOT been paid out yet; the amount is still owed to the payer.",
      ...(nowSec < to ? ["This report was generated before the period ended; numbers may still change until it is regenerated."] : []),
    ],
  };
  return { report, markdown: renderReportMarkdown(report) };
}

// ─── signing + storage ───────────────────────────────────────────────────────
export function reportHash(report: DailyReport): `0x${string}` {
  return hashCanonical(canonicalize(report));
}
export async function signReport(report: DailyReport): Promise<{ hash: `0x${string}`; signature: `0x${string}`; signer: Address }> {
  const account = privateKeyToAccount(attesterPrivateKey());
  const hash = reportHash(report);
  const signature = await account.signMessage({ message: hash });
  return { hash, signature, signer: account.address.toLowerCase() as Address };
}

function rowToStored(r: Record<string, unknown>): StoredReport {
  return {
    date: String(r.date), report: JSON.parse(String(r.json)) as DailyReport, markdown: String(r.markdown), hash: String(r.hash) as `0x${string}`,
    signature: String(r.signature) as `0x${string}`, signer: String(r.signer) as Address, ledgerId: str(r.ledger_id), createdAt: num(r.created_at),
  };
}
export async function getReport(date: string): Promise<StoredReport | null> {
  await migrateReports();
  const r = await db().execute({ sql: `SELECT * FROM reports WHERE date = ?`, args: [date] });
  return r.rows[0] ? rowToStored(r.rows[0] as Record<string, unknown>) : null;
}
export async function latestReport(): Promise<StoredReport | null> {
  await migrateReports();
  const r = await db().execute(`SELECT * FROM reports ORDER BY date DESC LIMIT 1`);
  return r.rows[0] ? rowToStored(r.rows[0] as Record<string, unknown>) : null;
}
export async function listReportDates(limit = 365): Promise<{ date: string; hash: `0x${string}`; createdAt: number; final: boolean }[]> {
  await migrateReports();
  const r = await db().execute({ sql: `SELECT date, hash, created_at, json FROM reports ORDER BY date DESC LIMIT ?`, args: [Math.min(Math.max(limit, 1), 3650)] });
  return r.rows.map((x0) => {
    const x = x0 as Record<string, unknown>;
    let final = false;
    try { final = Boolean((JSON.parse(String(x.json)) as DailyReport).period?.final); } catch { /* ignore */ }
    return { date: String(x.date), hash: String(x.hash) as `0x${string}`, createdAt: num(x.created_at), final };
  });
}

let publishing: Promise<unknown> = Promise.resolve();
/**
 * Generate + sign + ledger + store. Idempotent per date: a second call returns the stored report without a new
 * ledger entry. `force` regenerates (new hash, new signature, new ledger entry that references the previous one).
 */
export function publishReport(date: string, opts: { force?: boolean; now?: number } = {}): Promise<StoredReport & { created: boolean }> {
  const run = async () => {
    const existing = await getReport(date);
    if (existing && !opts.force) return { ...existing, created: false };
    const { report } = await generateDailyReport(date, { now: opts.now });
    const { hash, signature, signer } = await signReport(report);
    const counts = { outsidePayers: report.totals.outsidePayers, paidCalls: report.totals.paidCalls, usdcIn: report.totals.usdcIn, screenings: report.screenings.outside, refunds: report.refunds.count, mistakes: report.mistakes.length };
    const entry = await appendDecision({
      kind: "REPORT", subject: null, clientId: REPORT_CLIENT_ID,
      payload: { type: "REPORT", date, hash, signature, signer, counts, final: report.period.final, supersedes: existing?.ledgerId ?? null, url: `/api/v1/report/${date}` },
    });
    const markdown = renderReportMarkdown(report, { hash, signature, signer, ledgerId: entry.id });
    const createdAt = Math.floor(Date.now() / 1000);
    await db().execute({
      sql: `INSERT INTO reports (date, json, markdown, hash, signature, signer, ledger_id, created_at) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(date) DO UPDATE SET json = excluded.json, markdown = excluded.markdown, hash = excluded.hash, signature = excluded.signature,
              signer = excluded.signer, ledger_id = excluded.ledger_id, created_at = excluded.created_at`,
      args: [date, JSON.stringify(report), markdown, hash, signature, signer, entry.id, createdAt],
    });
    console.log(`[complir/report] ${existing ? "regenerated" : "published"} ${date}: ${counts.outsidePayers} outside payers, ${counts.paidCalls} paid calls, ${counts.usdcIn} USDC, ${counts.refunds} refunds · ${hash}`);
    return { date, report, markdown, hash, signature, signer, ledgerId: entry.id, createdAt, created: true };
  };
  const p = publishing.then(run, run);
  publishing = p.catch(() => undefined);
  return p;
}
