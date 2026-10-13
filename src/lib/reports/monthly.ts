/**
 * Monthly transparency rollup: one signed document per calendar month (UTC) built from the daily reports
 * (stored ones, or generated on the fly for days without a stored report), the daily risk dataset rows
 * (`stats_daily`, for tailer uptime), and a few direct queries (EDD outcomes, guarantees when the table exists).
 *
 *   generateMonthlyReport("2026-10") → { report, markdown }
 *   publishMonthly("2026-10")        → hash = keccak256(canonical(report)); EIP-191 signature by the attester;
 *                                      ledger REPORT entry (payload.type = "REPORT_MONTHLY"); stored in `reports_monthly`
 *
 * Idempotent per period once the month has ended; a running month is regenerated on every call.
 */
import { privateKeyToAccount } from "viem/accounts";
import { canonicalize, hashCanonical } from "../attest/canonical";
import { config } from "../config";
import { appendDecision } from "../ledger";
import { attesterPrivateKey } from "../pipeline";
import { db, migrate } from "../store/db";
import { lastDecision } from "../store/repo";
import { listDailyStats, tableExists } from "../stats";
import type { Address, Tier } from "../types";
import { generateDailyReport, getReport, readReportNotes, REPORT_CLIENT_ID, type DailyReport, type ReportMistake } from "./generate";

export const MONTHLY_VERSION = 1 as const;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface MonthlyDay { date: string; stored: boolean; final: boolean; hash: `0x${string}` | null; verdicts: number; usdcIn: number; ticks: number | null }
export interface MonthlyReport {
  version: typeof MONTHLY_VERSION;
  generator: "complir-report-agent";
  period: string;
  range: { from: string; to: string; days: number; daysElapsed: number; final: boolean };
  generatedAt: string;
  chain: { chainId: number; explorerUrl: string; usdc: string };
  signer: Address;
  verdicts: { total: number; outside: number; byTier: Record<Tier, number>; outsideByTier: Record<Tier, number>; addressesGraded: number | null };
  outsidePayers: { count: number; paidCalls: number; addresses: string[] };
  revenue: { usdcGross: number; usdcRefunded: number; usdcIn: number; ownPaymentsUsdc: number };
  refunds: { count: number; sentUsdc: number; owedUsdc: number };
  edd: { opened: number; answered: number; reviewed: number; cleared: number; stillHigh: number; openAtEnd: number };
  guarantees: { available: boolean; count: number; activeAtEnd: number; usdcCovered: number; claims: number };
  payouts: { count: number; paid: number; limited: number; held: number; failed: number; paidUsdc: number; heldUsdc: number; simulated: number };
  watches: { created: number; activeAtEnd: number };
  tierChanges: { count: number; up: number; down: number };
  incidents: { mistakes: ReportMistake[]; notes: { date: string | null; text: string }[] };
  uptime: { daysWithTicks: number; daysWithStats: number; ticks: number; share: number };
  days: MonthlyDay[];
  ledger: { lastSeq: number; headHash: string | null };
  caveats: string[];
}
export interface StoredMonthly {
  period: string; report: MonthlyReport; markdown: string; hash: `0x${string}`; signature: `0x${string}`; signer: Address; ledgerId: string | null; createdAt: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reports_monthly (
     period TEXT PRIMARY KEY, json TEXT NOT NULL, markdown TEXT NOT NULL, hash TEXT NOT NULL, signature TEXT NOT NULL,
     signer TEXT NOT NULL, ledger_id TEXT, created_at INTEGER NOT NULL)`,
];
let migrated: Promise<void> | null = null;
export function migrateMonthly(): Promise<void> {
  if (!migrated) migrated = (async () => { await migrate(); for (const s of SCHEMA) await db().execute(s); })().catch((e) => { migrated = null; throw e; });
  return migrated;
}
/** test helper */
export function __resetMonthly() { migrated = null; }

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (v == null ? null : String(v));
const round6 = (n: number) => Number(n.toFixed(6));
const iso = (unix: number) => new Date(unix * 1000).toISOString();
const TIER_ORDER: Record<Tier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function currentMonthUtc(at = Date.now()): string { return new Date(at).toISOString().slice(0, 7); }
export function previousMonthUtc(at = Date.now()): string {
  const d = new Date(at); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}
export function monthPeriod(period: string): { from: number; to: number; dates: string[] } {
  if (!MONTH_RE.test(period)) throw new Error(`report period must be YYYY-MM, got ${period}`);
  const [y, m] = period.split("-").map(Number);
  const from = Date.UTC(y, m - 1, 1) / 1000;
  const to = Date.UTC(y, m, 1) / 1000;
  const dates: string[] = [];
  for (let t = from; t < to; t += 86_400) dates.push(iso(t).slice(0, 10));
  return { from, to, dates };
}

export async function generateMonthlyReport(period: string, opts: { now?: number } = {}): Promise<{ report: MonthlyReport; markdown: string }> {
  await migrateMonthly();
  const { from, to, dates } = monthPeriod(period);
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const c = config();
  const explorerUrl = c.ARC_EXPLORER_URL.replace(/\/+$/, "");
  const signer = privateKeyToAccount(attesterPrivateKey()).address.toLowerCase() as Address;
  const d = db();
  const elapsed = dates.filter((x) => Date.parse(`${x}T00:00:00Z`) / 1000 < nowSec);

  // ── daily reports (stored or generated on the fly) ─────────────────────────
  const dailies: { date: string; report: DailyReport; stored: boolean; hash: `0x${string}` | null }[] = [];
  for (const date of elapsed) {
    const stored = await getReport(date);
    if (stored && stored.report.period.final) dailies.push({ date, report: stored.report, stored: true, hash: stored.hash });
    else dailies.push({ date, report: (await generateDailyReport(date, { now: nowSec })).report, stored: false, hash: null });
  }
  const byTier: Record<Tier, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  const outsideByTier: Record<Tier, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  const verdicts = { total: 0, outside: 0 };
  const payers = new Map<string, number>();
  let paidCalls = 0, usdcGross = 0, usdcRefunded = 0, ownPaymentsUsdc = 0;
  const refunds = { count: 0, sentUsdc: 0, owedUsdc: 0 };
  const payouts = { count: 0, paid: 0, limited: 0, held: 0, failed: 0, paidUsdc: 0, heldUsdc: 0, simulated: 0 };
  const tierChanges = { count: 0, up: 0, down: 0 };
  let watchesCreated = 0, watchesActiveAtEnd = 0;
  const mistakes: ReportMistake[] = [];
  for (const { report: r } of dailies) {
    verdicts.total += r.screenings.total; verdicts.outside += r.screenings.outside;
    for (const t of ["LOW", "MEDIUM", "HIGH"] as const) { byTier[t] += r.screenings.byTier[t]; outsideByTier[t] += r.screenings.outsideByTier[t]; }
    for (const p of r.outsidePayers) payers.set(p.address, (payers.get(p.address) ?? 0) + p.calls);
    paidCalls += r.totals.paidCalls; usdcGross = round6(usdcGross + r.totals.usdcGross); usdcRefunded = round6(usdcRefunded + r.totals.usdcRefunded);
    ownPaymentsUsdc = round6(ownPaymentsUsdc + r.excluded.ownPaymentsUsdc);
    refunds.count += r.refunds.count; refunds.sentUsdc = round6(refunds.sentUsdc + r.refunds.sentUsdc); refunds.owedUsdc = round6(refunds.owedUsdc + r.refunds.owedUsdc);
    for (const k of ["count", "paid", "limited", "held", "failed", "simulated"] as const) payouts[k] += r.payouts[k];
    payouts.paidUsdc = round6(payouts.paidUsdc + r.payouts.paidUsdc); payouts.heldUsdc = round6(payouts.heldUsdc + r.payouts.heldUsdc);
    tierChanges.count += r.tierChanges.count;
    for (const t of r.tierChanges.items) {
      if (!t.from) continue;
      if (TIER_ORDER[t.to] > TIER_ORDER[t.from]) tierChanges.up++; else if (TIER_ORDER[t.to] < TIER_ORDER[t.from]) tierChanges.down++;
    }
    watchesCreated += r.watches.created; watchesActiveAtEnd = r.watches.active;
    for (const m of r.mistakes) if (m.date && !mistakes.some((x) => x.date === m.date && x.what === m.what)) mistakes.push(m);
  }

  // ── EDD outcomes (direct) ──────────────────────────────────────────────────
  const edd = { opened: 0, answered: 0, reviewed: 0, cleared: 0, stillHigh: 0, openAtEnd: 0 };
  if (await tableExists("edd_requests")) {
    edd.opened = num(((await d.execute({ sql: `SELECT COUNT(*) AS n FROM edd_requests WHERE created_at >= ? AND created_at < ?`, args: [from, to] })).rows[0] as Row).n);
    const answered = (await d.execute({ sql: `SELECT status, response FROM edd_requests WHERE answered_at >= ? AND answered_at < ?`, args: [from, to] })).rows as Row[];
    for (const r of answered) {
      edd.answered++;
      if (r.status === "REVIEWED") edd.reviewed++;
      try {
        const resp = JSON.parse(String(r.response ?? "null")) as { rescreen?: { tier?: Tier } | null } | null;
        const tier = resp?.rescreen?.tier;
        if (tier && tier !== "HIGH") edd.cleared++; else if (tier === "HIGH") edd.stillHigh++;
      } catch { /* ignore */ }
    }
    edd.openAtEnd = num(((await d.execute({ sql: `SELECT COUNT(*) AS n FROM edd_requests WHERE status = 'OPEN' AND created_at < ?`, args: [Math.min(to, nowSec)] })).rows[0] as Row).n);
  }

  // ── guarantees (optional table) ────────────────────────────────────────────
  const guarantees = { available: false, count: 0, activeAtEnd: 0, usdcCovered: 0, claims: 0 };
  if (await tableExists("guarantees")) {
    const cols = (await d.execute(`PRAGMA table_info(guarantees)`)).rows.map((x) => String((x as Row).name));
    const atCol = ["created_at", "issued_at", "at"].find((x) => cols.includes(x));
    const amtCol = ["amount_usdc", "covered_usdc", "usdc", "amount"].find((x) => cols.includes(x));
    if (atCol) {
      guarantees.available = true;
      const rows = (await d.execute({ sql: `SELECT * FROM guarantees WHERE ${atCol} >= ? AND ${atCol} < ?`, args: [from, to] })).rows as Row[];
      for (const r of rows) {
        guarantees.count++;
        if (amtCol) guarantees.usdcCovered = round6(guarantees.usdcCovered + num(r[amtCol]));
        const s = String(r.status ?? "").toUpperCase();
        if (s === "ACTIVE") guarantees.activeAtEnd++;
        if (s === "CLAIMED" || s === "CLAIM" || num(r.claimed) > 0) guarantees.claims++;
      }
    }
  }

  // ── uptime from stats_daily ────────────────────────────────────────────────
  const statRows = await listDailyStats(31, { from: dates[0], to: dates[dates.length - 1] });
  const ticksByDate = new Map(statRows.map((r) => [r.date, r.stats.tailer.ticks]));
  const daysWithTicks = [...ticksByDate.values()].filter((t) => t > 0).length;
  const ticks = [...ticksByDate.values()].reduce((a, b) => a + b, 0);
  const uptime = { daysWithTicks, daysWithStats: ticksByDate.size, ticks, share: elapsed.length ? Number((daysWithTicks / elapsed.length).toFixed(4)) : 0 };

  // ── notes / incidents ──────────────────────────────────────────────────────
  const notes = await readReportNotes();
  const inMonth = (dt?: string) => !!dt && dt.startsWith(period);
  for (const m of notes.mistakes ?? []) if (inMonth(m.date) && !mistakes.some((x) => x.date === m.date && x.what === m.what)) mistakes.push({ ...m, refundTx: m.refundTx ?? null });
  mistakes.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const noteItems = (notes.notes ?? []).filter((n) => inMonth(n.date)).map((n) => ({ date: n.date ?? null, text: n.text }));
  const head = await lastDecision();

  const report: MonthlyReport = {
    version: MONTHLY_VERSION, generator: "complir-report-agent", period,
    range: { from: iso(from), to: iso(to), days: dates.length, daysElapsed: elapsed.length, final: nowSec >= to },
    generatedAt: iso(nowSec),
    chain: { chainId: c.ARC_CHAIN_ID, explorerUrl, usdc: c.USDC_ADDRESS.toLowerCase() },
    signer,
    verdicts: { ...verdicts, byTier, outsideByTier, addressesGraded: statRows.length ? statRows.reduce((a, r) => a + r.stats.graded.addresses, 0) : null },
    outsidePayers: { count: payers.size, paidCalls, addresses: [...payers.keys()].sort() },
    revenue: { usdcGross, usdcRefunded, usdcIn: round6(usdcGross - usdcRefunded), ownPaymentsUsdc },
    refunds, edd, guarantees, payouts,
    watches: { created: watchesCreated, activeAtEnd: watchesActiveAtEnd },
    tierChanges,
    incidents: { mistakes, notes: noteItems },
    uptime,
    days: dailies.map(({ date, report: r, stored, hash }) => ({ date, stored, final: r.period.final, hash, verdicts: r.screenings.total, usdcIn: r.totals.usdcIn, ticks: ticksByDate.get(date) ?? null })),
    ledger: { lastSeq: head?.seq ?? 0, headHash: head?.hash ?? null },
    caveats: [
      "Rolled up from the signed daily reports (stored, final ones are reused by hash; other days are regenerated from the database at rollup time) and the daily risk dataset.",
      "Numbers are self-reported by the CompliR agent; verify every USDC figure via the tx links in the daily reports.",
      "Uptime = UTC days with at least one tailer tick that wrote rows, over days elapsed; days without a stats row count as down.",
      ...(guarantees.available ? [] : ["No guarantees table on this deployment; guarantee figures are zero and marked unavailable."]),
      ...(nowSec < to ? ["The month has not ended; this rollup is regenerated on every publish until it is final."] : []),
    ],
  };
  return { report, markdown: renderMonthlyMarkdown(report) };
}

// ─── markdown ────────────────────────────────────────────────────────────────
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
const code = (s: string) => `\`${s}\``;
const row = (cells: (string | number)[]) => `| ${cells.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`;
const table = (head: string[], rows: (string | number)[][]) => [row(head), `|${head.map(() => "---").join("|")}|`, ...rows.map(row)].join("\n");
const short = (h: string, head = 10, tail = 6) => (h.length > head + tail + 2 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h);

export function renderMonthlyMarkdown(r: MonthlyReport, sig?: { hash: `0x${string}`; signature: `0x${string}`; signer: string; ledgerId: string | null }): string {
  const chainName = r.chain.chainId === 5042 ? "Arc mainnet" : r.chain.chainId === 5042002 ? "Arc testnet" : `chain ${r.chain.chainId}`;
  const out: string[] = [];
  out.push(`# CompliR transparency report - ${r.period}`);
  out.push(`_Written and signed by the CompliR agent at ${r.generatedAt}. ${r.range.daysElapsed} of ${r.range.days} UTC days${r.range.final ? "" : ", **month not finished**"}. ${chainName}, USDC ${code(r.chain.usdc)}._`);
  out.push("");
  out.push("## Summary");
  out.push(table(["Metric", "Value"], [
    ["Verdicts issued (outside / all)", `${r.verdicts.outside} / ${r.verdicts.total}`],
    ["HIGH / MEDIUM / LOW (outside)", `${r.verdicts.outsideByTier.HIGH} / ${r.verdicts.outsideByTier.MEDIUM} / ${r.verdicts.outsideByTier.LOW}`],
    ["Addresses graded (dataset)", r.verdicts.addressesGraded ?? "-"],
    ["Outside payers / paid calls", `${r.outsidePayers.count} / ${r.outsidePayers.paidCalls}`],
    ["Revenue USDC gross / refunded / net", `${fmt(r.revenue.usdcGross)} / ${fmt(r.revenue.usdcRefunded)} / ${fmt(r.revenue.usdcIn)}`],
    ["Refunds (sent / still owed USDC)", `${r.refunds.count} (${fmt(r.refunds.sentUsdc)} / ${fmt(r.refunds.owedUsdc)})`],
    ["EDD opened / answered / cleared / still HIGH", `${r.edd.opened} / ${r.edd.answered} / ${r.edd.cleared} / ${r.edd.stillHigh}`],
    ["Guarantees", r.guarantees.available ? `${r.guarantees.count} issued, ${r.guarantees.activeAtEnd} active, ${fmt(r.guarantees.usdcCovered)} USDC covered, ${r.guarantees.claims} claims` : "not tracked"],
    ["Payouts paid / limited / held / failed", `${r.payouts.paid} / ${r.payouts.limited} / ${r.payouts.held} / ${r.payouts.failed}${r.payouts.simulated ? ` (${r.payouts.simulated} simulated)` : ""}`],
    ["Payout USDC paid / held", `${fmt(r.payouts.paidUsdc)} / ${fmt(r.payouts.heldUsdc)}`],
    ["Watches created / active at end", `${r.watches.created} / ${r.watches.activeAtEnd}`],
    ["Tier changes (up / down)", `${r.tierChanges.count} (${r.tierChanges.up} / ${r.tierChanges.down})`],
    ["Tailer uptime", `${(r.uptime.share * 100).toFixed(1)}% (${r.uptime.daysWithTicks} of ${r.range.daysElapsed} days, ${r.uptime.ticks} ticks)`],
    ["Incidents", r.incidents.mistakes.length],
  ]));
  out.push("");
  out.push("## Outside payers");
  out.push(r.outsidePayers.addresses.length ? r.outsidePayers.addresses.map((a) => `- [${code(a)}](${r.chain.explorerUrl}/address/${a})`).join("\n") : "_No outside payers this month._");
  out.push("");
  out.push("## Incidents");
  if (r.incidents.mistakes.length) for (const m of r.incidents.mistakes) out.push(`- ${m.date ?? ""} ${m.what}${m.refundTx ? ` - refund ${code(short(m.refundTx))}` : ""}`);
  else out.push("_No mistakes logged this month._");
  if (r.incidents.notes.length) { out.push(""); out.push("## Notes"); for (const n of r.incidents.notes) out.push(`- ${n.date ?? ""} ${n.text}`.trim()); }
  out.push("");
  out.push("## Days");
  out.push(table(["Date", "Report", "Verdicts", "USDC in", "Ticks"], r.days.map((d) => [
    `[${d.date}](/report?date=${d.date})`, d.stored ? `signed ${code(short(d.hash ?? "", 8, 4))}` : d.final ? "regenerated" : "partial", d.verdicts, fmt(d.usdcIn), d.ticks ?? "-",
  ])));
  out.push("");
  out.push("## Caveats");
  for (const c of r.caveats) out.push(`- ${c}`);
  out.push("");
  out.push("## Verify");
  out.push(`- Ledger head at generation: seq ${r.ledger.lastSeq}${r.ledger.headHash ? `, ${code(r.ledger.headHash)}` : ""}`);
  out.push(`- JSON: ${code(`/api/v1/report/monthly/${r.period}`)} · Markdown: ${code(`/api/v1/report/monthly/${r.period}.md`)}`);
  if (sig) {
    out.push(`- Hash: ${code(sig.hash)} (keccak256 of the canonical JSON, signature and markdown excluded)`);
    out.push(`- Signer: ${code(sig.signer)} (CompliR attester) · Signature (EIP-191 personal_sign over the hash string): ${code(sig.signature)}`);
    if (sig.ledgerId) out.push(`- Ledger entry: [${sig.ledgerId}](/log/${sig.ledgerId})`);
    out.push(`- Check: \`verifyMessage({ address: "${sig.signer}", message: "${sig.hash}", signature })\` (viem)`);
  }
  return out.join("\n") + "\n";
}

// ─── signing + storage ───────────────────────────────────────────────────────
export function monthlyHash(report: MonthlyReport): `0x${string}` { return hashCanonical(canonicalize(report)); }

function rowToStored(r: Row): StoredMonthly {
  return {
    period: String(r.period), report: JSON.parse(String(r.json)) as MonthlyReport, markdown: String(r.markdown), hash: String(r.hash) as `0x${string}`,
    signature: String(r.signature) as `0x${string}`, signer: String(r.signer) as Address, ledgerId: str(r.ledger_id), createdAt: num(r.created_at),
  };
}
export async function getMonthly(period: string): Promise<StoredMonthly | null> {
  await migrateMonthly();
  const r = await db().execute({ sql: `SELECT * FROM reports_monthly WHERE period = ?`, args: [period] });
  return r.rows[0] ? rowToStored(r.rows[0] as Row) : null;
}
export async function latestMonthly(): Promise<StoredMonthly | null> {
  await migrateMonthly();
  const r = await db().execute(`SELECT * FROM reports_monthly ORDER BY period DESC LIMIT 1`);
  return r.rows[0] ? rowToStored(r.rows[0] as Row) : null;
}
export async function listMonthlyPeriods(limit = 120): Promise<{ period: string; hash: `0x${string}`; createdAt: number; final: boolean }[]> {
  await migrateMonthly();
  const r = await db().execute({ sql: `SELECT period, hash, created_at, json FROM reports_monthly ORDER BY period DESC LIMIT ?`, args: [Math.min(Math.max(limit, 1), 1200)] });
  return r.rows.map((x0) => {
    const x = x0 as Row;
    let final = false;
    try { final = Boolean((JSON.parse(String(x.json)) as MonthlyReport).range?.final); } catch { /* ignore */ }
    return { period: String(x.period), hash: String(x.hash) as `0x${string}`, createdAt: num(x.created_at), final };
  });
}

let publishing: Promise<unknown> = Promise.resolve();
export function publishMonthly(period: string, opts: { force?: boolean; now?: number } = {}): Promise<StoredMonthly & { created: boolean }> {
  const run = async () => {
    const existing = await getMonthly(period);
    if (existing && existing.report.range.final && !opts.force) return { ...existing, created: false };
    const { report } = await generateMonthlyReport(period, { now: opts.now });
    const account = privateKeyToAccount(attesterPrivateKey());
    const hash = monthlyHash(report);
    const signature = await account.signMessage({ message: hash });
    const signer = account.address.toLowerCase() as Address;
    const counts = { verdicts: report.verdicts.total, outsidePayers: report.outsidePayers.count, usdcIn: report.revenue.usdcIn, refunds: report.refunds.count, incidents: report.incidents.mistakes.length, uptime: report.uptime.share };
    const entry = await appendDecision({
      kind: "REPORT", subject: null, clientId: REPORT_CLIENT_ID,
      payload: { type: "REPORT_MONTHLY", period, hash, signature, signer, counts, final: report.range.final, supersedes: existing?.ledgerId ?? null, url: `/api/v1/report/monthly/${period}` },
    });
    const markdown = renderMonthlyMarkdown(report, { hash, signature, signer, ledgerId: entry.id });
    const createdAt = Math.floor(Date.now() / 1000);
    await db().execute({
      sql: `INSERT INTO reports_monthly (period, json, markdown, hash, signature, signer, ledger_id, created_at) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(period) DO UPDATE SET json = excluded.json, markdown = excluded.markdown, hash = excluded.hash, signature = excluded.signature,
              signer = excluded.signer, ledger_id = excluded.ledger_id, created_at = excluded.created_at`,
      args: [period, JSON.stringify(report), markdown, hash, signature, signer, entry.id, createdAt],
    });
    console.log(`[complir/report] ${existing ? "regenerated" : "published"} monthly ${period}: ${counts.verdicts} verdicts, ${counts.outsidePayers} outside payers, ${counts.usdcIn} USDC · ${hash}`);
    return { period, report, markdown, hash, signature, signer, ledgerId: entry.id, createdAt, created: true };
  };
  const p = publishing.then(run, run);
  publishing = p.catch(() => undefined);
  return p;
}
