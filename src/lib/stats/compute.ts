/**
 * Public risk dataset: one signed row per UTC day, aggregated from our own tables only (docs/DATASET.md).
 *
 *   computeDailyStats(date) → DailyStats (JSON, no signature)
 *   publishDailyStats(date) → hash = keccak256(canonical(stats)); signature = attester EIP-191 signMessage(hash);
 *                             stored in `stats_daily` (upsert; a day is recomputed until it is final)
 *
 * Sources (all read-only, every table tolerated when absent):
 *   screenings             graded addresses, tier mix, reason codes, client class
 *   trustmap_nodes         flagged set (HIGH or blocklist reason code)
 *   trustmap_candidates    observed-but-ungraded wallets
 *   trustmap_edges         USDC volume the tailer observed; share touching a flagged wallet
 *   trustmap_tier_changes  regrades on the map; decisions(kind=TIER_CHANGE) for watched addresses
 *   trustmap_inflow/edges  tailer ticks (distinct tick timestamps that wrote rows)
 *   cctp_inbound           bridged volume (optional table; `bridged.available=false` when missing)
 *   tips, treasury_invoices, payments  side counts
 *
 * Verify: viem `verifyMessage({ address: signer, message: hash, signature })`, hash = keccak256(canonical(stats)).
 */
import { privateKeyToAccount } from "viem/accounts";
import { canonicalize, hashCanonical } from "../attest/canonical";
import { config } from "../config";
import { attesterPrivateKey } from "../pipeline";
import { db, migrate } from "../store/db";
import { INTERNAL_CLIENT_IDS, ownWallets } from "../store/repo";
import type { Address, ReasonCode, Tier } from "../types";

export const STATS_VERSION = 1 as const;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** reason codes that mark a wallet as blocklisted (independent of its tier) */
export const BLOCKLIST_CODES: readonly ReasonCode[] = ["SANCTIONS_DIRECT", "USDC_BLACKLISTED", "PROTOCOL_BLOCKLISTED"];

export interface TierCounts { LOW: number; MEDIUM: number; HIGH: number }
export interface DailyStats {
  version: typeof STATS_VERSION;
  generator: "complir-stats";
  date: string;
  period: { from: string; to: string; /** true once the UTC day has ended */ final: boolean };
  generatedAt: string;
  chain: { chainId: number; explorerUrl: string; usdc: string };
  signer: Address;
  /** screenings in the day: distinct addresses, tier of the last screening of each address that day */
  graded: { addresses: number; screenings: number; byTier: TierCounts; share: TierCounts };
  /** wallets the tailer saw (candidates + graded nodes with activity that day) and the current map size */
  observed: { wallets: number; candidatesNow: number; nodesNow: number };
  /** USDC Transfer edges the tailer persisted that day */
  volume: { usdc: number; edges: number; flaggedUsdc: number; flaggedShare: number; flaggedEdges: number; flaggedWalletsNow: number };
  tierChanges: { total: number; map: number; watch: number; up: number; down: number };
  reasons: { code: ReasonCode | string; count: number; share: number }[];
  bridged: { available: boolean; table: string | null; transfers: number; usdc: number; flaggedUsdc: number; flaggedShare: number };
  clients: { outside: number; internal: number; unknown: number; distinctClientIds: number; outsidePayers: number };
  tailer: { ticks: number; lastTickAt: string | null; cursorBlock: number | null; blocksScanned: number | null };
  side: { tips: number; tipsVerified: number; payouts: number; payoutsHeld: number; paidCalls: number; usdcPaid: number };
  caveats: string[];
}
export interface StoredStats {
  date: string;
  stats: DailyStats;
  hash: `0x${string}`;
  signature: `0x${string}`;
  signer: Address;
  createdAt: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS stats_daily (
     date TEXT PRIMARY KEY, json TEXT NOT NULL, hash TEXT NOT NULL, signature TEXT NOT NULL, signer TEXT NOT NULL, created_at INTEGER NOT NULL)`,
];
let migrated: Promise<void> | null = null;
export function migrateStats(): Promise<void> {
  if (!migrated) migrated = (async () => { await migrate(); for (const s of SCHEMA) await db().execute(s); })().catch((e) => { migrated = null; throw e; });
  return migrated;
}
/** test helper */
export function __resetStats() { migrated = null; }

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (v == null ? null : String(v));
const round6 = (n: number) => Number(n.toFixed(6));
const round4 = (n: number) => Number(n.toFixed(4));
const iso = (unix: number) => new Date(unix * 1000).toISOString();
const share = (part: number, whole: number) => (whole > 0 ? round4(part / whole) : 0);
const TIER_ORDER: Record<Tier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function todayUtc(at = Date.now()): string { return new Date(at).toISOString().slice(0, 10); }
export function yesterdayUtc(at = Date.now()): string { return todayUtc(at - 86_400_000); }
export function periodFor(date: string): { from: number; to: number } {
  if (!DATE_RE.test(date)) throw new Error(`stats date must be YYYY-MM-DD, got ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  const from = Date.UTC(y, m - 1, d) / 1000;
  if (!Number.isFinite(from) || iso(from).slice(0, 10) !== date) throw new Error(`invalid calendar date ${date}`);
  return { from, to: from + 86_400 };
}

/** Table present on this database? (other modules own their tables; we only read them.) */
export async function tableExists(name: string): Promise<boolean> {
  const r = await db().execute({ sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, args: [name] });
  return r.rows.length > 0;
}
async function columns(name: string): Promise<string[]> {
  const r = await db().execute(`PRAGMA table_info(${name})`);
  return r.rows.map((x) => String((x as Row).name));
}
function parseCodes(raw: unknown): string[] {
  if (raw == null) return [];
  const s = String(raw);
  try { const v = JSON.parse(s); if (Array.isArray(v)) return v.map(String); } catch { /* not json */ }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

// ─── compute ─────────────────────────────────────────────────────────────────
export async function computeDailyStats(date: string, opts: { now?: number } = {}): Promise<DailyStats> {
  await migrateStats();
  const { from, to } = periodFor(date);
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const c = config();
  const d = db();
  const signer = privateKeyToAccount(attesterPrivateKey()).address.toLowerCase() as Address;
  const own = ownWallets();
  const has = async (t: string) => tableExists(t);

  // ── graded (screenings) ────────────────────────────────────────────────────
  const byTier: TierCounts = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  const lastTier = new Map<string, Tier>();
  const reasonCounts = new Map<string, number>();
  const clients = { outside: 0, internal: 0, unknown: 0 };
  const clientIds = new Set<string>();
  const flagged = new Set<string>();
  let screenings = 0;
  if (await has("screenings")) {
    const rows = (await d.execute({ sql: `SELECT subject, tier, reason_codes, client_id, payer FROM screenings WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC, id ASC`, args: [from, to] })).rows as Row[];
    for (const r of rows) {
      screenings++;
      const tier = String(r.tier) as Tier;
      if (tier in byTier) lastTier.set(String(r.subject).toLowerCase(), tier);
      const codes = parseCodes(r.reason_codes);
      for (const code of codes) reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
      if (codes.some((x) => BLOCKLIST_CODES.includes(x as ReasonCode)) || tier === "HIGH") flagged.add(String(r.subject).toLowerCase());
      const payer = String(r.payer ?? "unknown");
      const cid = str(r.client_id);
      if (cid) clientIds.add(cid);
      if (payer === "own" || (cid && INTERNAL_CLIENT_IDS.has(cid.toLowerCase()))) clients.internal++;
      else if (payer === "outside") clients.outside++;
      else clients.unknown++;
    }
  }
  for (const t of lastTier.values()) byTier[t]++;
  const addresses = lastTier.size;
  const graded = { addresses, screenings, byTier, share: { LOW: share(byTier.LOW, addresses), MEDIUM: share(byTier.MEDIUM, addresses), HIGH: share(byTier.HIGH, addresses) } };
  const reasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)
    .map(([code, count]) => ({ code, count, share: share(count, screenings) }));

  // ── flagged set from the map (current state) ───────────────────────────────
  let nodesNow = 0;
  if (await has("trustmap_nodes")) {
    const rows = (await d.execute(`SELECT address, tier, reason_codes FROM trustmap_nodes`)).rows as Row[];
    nodesNow = rows.length;
    for (const r of rows) {
      const codes = parseCodes(r.reason_codes);
      if (String(r.tier) === "HIGH" || codes.some((x) => BLOCKLIST_CODES.includes(x as ReasonCode))) flagged.add(String(r.address).toLowerCase());
    }
  }

  // ── observed wallets + candidates ──────────────────────────────────────────
  const observedSet = new Set<string>();
  let candidatesNow = 0;
  if (await has("trustmap_candidates")) {
    candidatesNow = num(((await d.execute(`SELECT COUNT(*) AS n FROM trustmap_candidates`)).rows[0] as Row).n);
    const rows = (await d.execute({ sql: `SELECT address FROM trustmap_candidates WHERE last_seen_at >= ? AND last_seen_at < ?`, args: [from, to] })).rows as Row[];
    for (const r of rows) observedSet.add(String(r.address).toLowerCase());
  }
  if (await has("trustmap_nodes")) {
    const rows = (await d.execute({ sql: `SELECT address FROM trustmap_nodes WHERE last_graded_at >= ? AND last_graded_at < ?`, args: [from, to] })).rows as Row[];
    for (const r of rows) observedSet.add(String(r.address).toLowerCase());
  }

  // ── volume (edges persisted that day) ──────────────────────────────────────
  const tickAts = new Set<number>();
  let usdc = 0, flaggedUsdc = 0, edges = 0, flaggedEdges = 0;
  if (await has("trustmap_edges")) {
    const rows = (await d.execute({ sql: `SELECT from_addr, to_addr, usdc, created_at FROM trustmap_edges WHERE created_at >= ? AND created_at < ?`, args: [from, to] })).rows as Row[];
    for (const r of rows) {
      edges++;
      const v = num(r.usdc);
      usdc += v;
      tickAts.add(num(r.created_at));
      observedSet.add(String(r.from_addr).toLowerCase()); observedSet.add(String(r.to_addr).toLowerCase());
      if (flagged.has(String(r.from_addr).toLowerCase()) || flagged.has(String(r.to_addr).toLowerCase())) { flaggedUsdc += v; flaggedEdges++; }
    }
  }
  if (await has("trustmap_inflow")) {
    const rows = (await d.execute({ sql: `SELECT DISTINCT at FROM trustmap_inflow WHERE at >= ? AND at < ?`, args: [from, to] })).rows as Row[];
    for (const r of rows) tickAts.add(num(r.at));
  }
  const volume = { usdc: round6(usdc), edges, flaggedUsdc: round6(flaggedUsdc), flaggedShare: share(flaggedUsdc, usdc), flaggedEdges, flaggedWalletsNow: flagged.size };

  // ── tier changes ───────────────────────────────────────────────────────────
  let map = 0, watch = 0, up = 0, down = 0;
  const dir = (f: string | null, t: string) => {
    if (!f || !(f in TIER_ORDER) || !(t in TIER_ORDER)) return;
    if (TIER_ORDER[t as Tier] > TIER_ORDER[f as Tier]) up++; else if (TIER_ORDER[t as Tier] < TIER_ORDER[f as Tier]) down++;
  };
  if (await has("trustmap_tier_changes")) {
    const rows = (await d.execute({ sql: `SELECT from_tier, to_tier FROM trustmap_tier_changes WHERE at >= ? AND at < ?`, args: [from, to] })).rows as Row[];
    map = rows.length;
    for (const r of rows) dir(str(r.from_tier), String(r.to_tier));
  }
  if (await has("decisions")) {
    const rows = (await d.execute({ sql: `SELECT payload FROM decisions WHERE kind = 'TIER_CHANGE' AND created_at >= ? AND created_at < ?`, args: [from, to] })).rows as Row[];
    watch = rows.length;
    for (const r of rows) {
      try { const p = JSON.parse(String(r.payload)) as { from?: string | null; to?: string }; dir(p.from ?? null, String(p.to ?? "")); } catch { /* ignore */ }
    }
  }
  const tierChanges = { total: map + watch, map, watch, up, down };

  // ── bridged (optional table, columns sniffed) ──────────────────────────────
  const bridged = { available: false, table: null as string | null, transfers: 0, usdc: 0, flaggedUsdc: 0, flaggedShare: 0 };
  if (await has("cctp_inbound")) {
    const cols = await columns("cctp_inbound");
    const pick = (...names: string[]) => names.find((n) => cols.includes(n)) ?? null;
    const amountCol = pick("amount_usdc", "usdc", "amount");
    const toCol = pick("recipient", "mint_recipient", "to_addr", "to_address", "to");
    const atCol = pick("created_at", "received_at", "minted_at", "at", "timestamp");
    if (amountCol && atCol) {
      bridged.available = true; bridged.table = "cctp_inbound";
      const flagCol = cols.includes("flagged") ? ", flagged AS flg" : "";
      const rows = (await d.execute({ sql: `SELECT ${amountCol} AS amt${toCol ? `, ${toCol} AS rcpt` : ""}${flagCol} FROM cctp_inbound WHERE ${atCol} >= ? AND ${atCol} < ?`, args: [from, to] })).rows as Row[];
      for (const r of rows) {
        const v = num(r.amt);
        bridged.transfers++; bridged.usdc += v;
        // flagged by the CCTP watcher itself (sender sanctions / blacklist) or minted to a wallet in our flagged set
        if (num(r.flg) > 0 || (toCol && flagged.has(String(r.rcpt ?? "").toLowerCase()))) bridged.flaggedUsdc += v;
      }
      bridged.usdc = round6(bridged.usdc); bridged.flaggedUsdc = round6(bridged.flaggedUsdc); bridged.flaggedShare = share(bridged.flaggedUsdc, bridged.usdc);
    }
  }

  // ── tailer ─────────────────────────────────────────────────────────────────
  let lastTickAt: string | null = null, cursorBlock: number | null = null, blocksScanned: number | null = null;
  if (await has("trustmap_meta")) {
    const rows = (await d.execute(`SELECT key, value FROM trustmap_meta WHERE key IN ('cursor_block','last_tick')`)).rows as Row[];
    for (const r of rows) {
      if (r.key === "cursor_block") cursorBlock = num(r.value);
      else {
        try {
          const t = JSON.parse(String(r.value)) as { at?: number; blocksScanned?: number };
          if (t.at && t.at >= from && t.at < to) { lastTickAt = iso(t.at); blocksScanned = t.blocksScanned ?? null; tickAts.add(t.at); }
        } catch { /* ignore */ }
      }
    }
  }
  const tailer = { ticks: tickAts.size, lastTickAt, cursorBlock, blocksScanned };

  // ── side counts ────────────────────────────────────────────────────────────
  const side = { tips: 0, tipsVerified: 0, payouts: 0, payoutsHeld: 0, paidCalls: 0, usdcPaid: 0 };
  const outsidePayers = new Set<string>();
  if (await has("tips")) {
    const r = (await d.execute({ sql: `SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('VERIFIED','PAID') THEN 1 ELSE 0 END) AS v FROM tips WHERE created_at >= ? AND created_at < ?`, args: [from, to] })).rows[0] as Row;
    side.tips = num(r.n); side.tipsVerified = num(r.v);
  }
  if (await has("treasury_invoices")) {
    const r = (await d.execute({ sql: `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'HELD' THEN 1 ELSE 0 END) AS h FROM treasury_invoices WHERE decided_at >= ? AND decided_at < ?`, args: [from, to] })).rows[0] as Row;
    side.payouts = num(r.n); side.payoutsHeld = num(r.h);
  }
  if (await has("payments")) {
    const rows = (await d.execute({ sql: `SELECT payer, amount_usdc FROM payments WHERE created_at >= ? AND created_at < ?`, args: [from, to] })).rows as Row[];
    for (const r of rows) {
      const payer = String(r.payer).toLowerCase();
      if (own.has(payer) || INTERNAL_CLIENT_IDS.has(payer)) continue;
      side.paidCalls++; side.usdcPaid += num(r.amount_usdc); outsidePayers.add(payer);
    }
    side.usdcPaid = round6(side.usdcPaid);
  }

  return {
    version: STATS_VERSION, generator: "complir-stats", date,
    period: { from: iso(from), to: iso(to), final: nowSec >= to },
    generatedAt: iso(nowSec),
    chain: { chainId: c.ARC_CHAIN_ID, explorerUrl: c.ARC_EXPLORER_URL.replace(/\/+$/, ""), usdc: c.USDC_ADDRESS.toLowerCase() },
    signer,
    graded,
    observed: { wallets: observedSet.size, candidatesNow, nodesNow },
    volume,
    tierChanges,
    reasons,
    bridged,
    clients: { ...clients, distinctClientIds: clientIds.size, outsidePayers: outsidePayers.size },
    tailer,
    side,
    caveats: [
      "Sample = what the CompliR tailer observed in its block windows and what clients asked us to screen; it is not all of Arc.",
      "Volume is the USDC moved on Transfer edges the tailer persisted that day (graded nodes and their counterparties); flagged = HIGH tier or a blocklist reason code at the time of computation.",
      "Tailer ticks count distinct tick timestamps that wrote rows; quiet ticks (no USDC activity in the window) are not counted.",
      ...(bridged.available ? [] : ["No CCTP inbound table on this deployment; bridged figures are zero and marked unavailable."]),
      ...(nowSec < to ? ["Computed before the UTC day ended; the row is recomputed and re-signed until it is final."] : []),
    ],
  };
}

// ─── signing + storage ───────────────────────────────────────────────────────
export function statsHash(stats: DailyStats): `0x${string}` { return hashCanonical(canonicalize(stats)); }
export async function signStats(stats: DailyStats): Promise<{ hash: `0x${string}`; signature: `0x${string}`; signer: Address }> {
  const account = privateKeyToAccount(attesterPrivateKey());
  const hash = statsHash(stats);
  const signature = await account.signMessage({ message: hash });
  return { hash, signature, signer: account.address.toLowerCase() as Address };
}
function rowToStored(r: Row): StoredStats {
  return { date: String(r.date), stats: JSON.parse(String(r.json)) as DailyStats, hash: String(r.hash) as `0x${string}`, signature: String(r.signature) as `0x${string}`, signer: String(r.signer) as Address, createdAt: num(r.created_at) };
}
export async function getDailyStats(date: string): Promise<StoredStats | null> {
  await migrateStats();
  const r = await db().execute({ sql: `SELECT * FROM stats_daily WHERE date = ?`, args: [date] });
  return r.rows[0] ? rowToStored(r.rows[0] as Row) : null;
}
export async function latestDailyStats(): Promise<StoredStats | null> {
  await migrateStats();
  const r = await db().execute(`SELECT * FROM stats_daily ORDER BY date DESC LIMIT 1`);
  return r.rows[0] ? rowToStored(r.rows[0] as Row) : null;
}
/** Newest first. */
export async function listDailyStats(limit = 30, opts: { from?: string; to?: string } = {}): Promise<StoredStats[]> {
  await migrateStats();
  const where: string[] = []; const args: (string | number)[] = [];
  if (opts.from) { where.push("date >= ?"); args.push(opts.from); }
  if (opts.to) { where.push("date <= ?"); args.push(opts.to); }
  args.push(Math.min(Math.max(limit, 1), 3650));
  const r = await db().execute({ sql: `SELECT * FROM stats_daily ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY date DESC LIMIT ?`, args });
  return r.rows.map((x) => rowToStored(x as Row));
}

let publishing: Promise<unknown> = Promise.resolve();
/**
 * Compute + sign + upsert. A final day (period ended) is kept as stored unless `force`; a partial day is always
 * recomputed, so the cron can call this for today and yesterday every run.
 */
export function publishDailyStats(date: string, opts: { force?: boolean; now?: number } = {}): Promise<StoredStats & { created: boolean }> {
  const run = async () => {
    const existing = await getDailyStats(date);
    if (existing && existing.stats.period.final && !opts.force) return { ...existing, created: false };
    const stats = await computeDailyStats(date, { now: opts.now });
    const { hash, signature, signer } = await signStats(stats);
    const createdAt = Math.floor(Date.now() / 1000);
    await db().execute({
      sql: `INSERT INTO stats_daily (date, json, hash, signature, signer, created_at) VALUES (?,?,?,?,?,?)
            ON CONFLICT(date) DO UPDATE SET json = excluded.json, hash = excluded.hash, signature = excluded.signature, signer = excluded.signer, created_at = excluded.created_at`,
      args: [date, JSON.stringify(stats), hash, signature, signer, createdAt],
    });
    console.log(`[complir/stats] ${existing ? "recomputed" : "published"} ${date}: ${stats.graded.addresses} graded, ${stats.observed.wallets} observed, ${stats.volume.usdc} USDC (${(stats.volume.flaggedShare * 100).toFixed(1)}% flagged) · ${hash}`);
    return { date, stats, hash, signature, signer, createdAt, created: true };
  };
  const p = publishing.then(run, run);
  publishing = p.catch(() => undefined);
  return p;
}

// ─── CSV (flat, one row per day, newest first) ───────────────────────────────
export const CSV_COLUMNS = [
  "date", "final", "graded_addresses", "screenings", "tier_low", "tier_medium", "tier_high", "share_low", "share_medium", "share_high",
  "observed_wallets", "candidates_now", "nodes_now", "volume_usdc", "volume_edges", "flagged_usdc", "flagged_share", "flagged_edges", "flagged_wallets_now",
  "tier_changes", "tier_changes_map", "tier_changes_watch", "tier_up", "tier_down", "top_reasons",
  "bridged_available", "bridged_transfers", "bridged_usdc", "bridged_flagged_usdc", "bridged_flagged_share",
  "clients_outside", "clients_internal", "clients_unknown", "distinct_client_ids", "outside_payers",
  "tailer_ticks", "tailer_last_tick_at", "cursor_block", "tips", "tips_verified", "payouts", "payouts_held", "paid_calls", "usdc_paid",
  "hash", "signature", "signer",
] as const;
const csvCell = (v: unknown): string => {
  const s = v == null ? "" : typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
};
export function statsCsvRow(s: StoredStats): string {
  const x = s.stats;
  const vals: unknown[] = [
    x.date, x.period.final, x.graded.addresses, x.graded.screenings, x.graded.byTier.LOW, x.graded.byTier.MEDIUM, x.graded.byTier.HIGH, x.graded.share.LOW, x.graded.share.MEDIUM, x.graded.share.HIGH,
    x.observed.wallets, x.observed.candidatesNow, x.observed.nodesNow, x.volume.usdc, x.volume.edges, x.volume.flaggedUsdc, x.volume.flaggedShare, x.volume.flaggedEdges, x.volume.flaggedWalletsNow,
    x.tierChanges.total, x.tierChanges.map, x.tierChanges.watch, x.tierChanges.up, x.tierChanges.down, x.reasons.map((r) => `${r.code}:${r.count}`).join(";"),
    x.bridged.available, x.bridged.transfers, x.bridged.usdc, x.bridged.flaggedUsdc, x.bridged.flaggedShare,
    x.clients.outside, x.clients.internal, x.clients.unknown, x.clients.distinctClientIds, x.clients.outsidePayers,
    x.tailer.ticks, x.tailer.lastTickAt, x.tailer.cursorBlock, x.side.tips, x.side.tipsVerified, x.side.payouts, x.side.payoutsHeld, x.side.paidCalls, x.side.usdcPaid,
    s.hash, s.signature, s.signer,
  ];
  return vals.map(csvCell).join(",");
}
export function statsCsv(rows: StoredStats[]): string {
  return [CSV_COLUMNS.join(","), ...rows.map(statsCsvRow)].join("\r\n") + "\r\n";
}

/** One-line headline for the page / API ("0.0% of observed USDC volume touched a flagged wallet today"). */
export function headline(s: DailyStats): string {
  const pct = (s.volume.flaggedShare * 100).toFixed(1);
  const when = s.period.final ? `on ${s.date}` : "today";
  if (s.volume.edges === 0) return `No USDC transfers observed ${when} yet; ${s.graded.addresses} address${s.graded.addresses === 1 ? "" : "es"} graded.`;
  return `${pct}% of observed USDC volume touched a flagged wallet ${when} (${s.volume.flaggedUsdc.toLocaleString("en-US", { maximumFractionDigits: 2 })} of ${s.volume.usdc.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC across ${s.volume.edges} transfers).`;
}
