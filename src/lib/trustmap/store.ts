/**
 * Trust Map persistence. Own tables (CREATE TABLE IF NOT EXISTS, idempotent) on the shared libsql db().
 *   trustmap_meta          key/value: cursor block, last tick summary
 *   trustmap_nodes         one row per graded counterparty
 *   trustmap_edges         USDC Transfer edges among graded nodes
 *   trustmap_tier_changes  regrade produced a different tier
 *   trustmap_inflow        per-tick USDC received per address (rolling 24 h sum → usdc_in_24h)
 *   trustmap_code_cache    eth_getCode results (contract or not), so a tick never re-asks
 *   trustmap_candidates    observed-but-ungraded addresses (every USDC recipient of a tick + counterparties of graded
 *                          nodes); rolling 24 h in/out buckets; bounded retention (CANDIDATE_BLOCKS / CANDIDATE_ROWS)
 */
import { db, migrate } from "../store/db";
import type { Address, ReasonCode, Tier } from "../types";
import type { MapCandidate, MapEdge, MapNode, NodeSource, TickSummary, TierChange } from "./types";

/** candidate retention: rows last seen more than this many blocks behind the cursor are dropped … */
export const CANDIDATE_BLOCKS = 2_000;
/** … and the table is trimmed to this many rows (biggest inflow first) */
export const CANDIDATE_ROWS = 500;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trustmap_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS trustmap_nodes (
     address TEXT PRIMARY KEY, tier TEXT NOT NULL, score INTEGER NOT NULL, last_seen_block INTEGER NOT NULL,
     usdc_in_24h REAL NOT NULL DEFAULT 0, first_graded_at INTEGER NOT NULL, last_graded_at INTEGER NOT NULL,
     prev_tier TEXT, changed_at INTEGER, reason_codes TEXT NOT NULL DEFAULT '[]', rationale TEXT, decision_id TEXT,
     source TEXT NOT NULL DEFAULT 'chain')`,
  `CREATE INDEX IF NOT EXISTS trustmap_nodes_usdc ON trustmap_nodes(usdc_in_24h DESC, last_graded_at DESC)`,
  `CREATE TABLE IF NOT EXISTS trustmap_edges (
     id INTEGER PRIMARY KEY AUTOINCREMENT, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, usdc REAL NOT NULL,
     tx_hash TEXT NOT NULL, block INTEGER NOT NULL, created_at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'chain',
     UNIQUE(tx_hash, from_addr, to_addr))`,
  `CREATE INDEX IF NOT EXISTS trustmap_edges_from ON trustmap_edges(from_addr)`,
  `CREATE INDEX IF NOT EXISTS trustmap_edges_to ON trustmap_edges(to_addr)`,
  `CREATE TABLE IF NOT EXISTS trustmap_tier_changes (
     id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, from_tier TEXT, to_tier TEXT NOT NULL, score INTEGER NOT NULL,
     block INTEGER, decision_id TEXT, at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'chain')`,
  `CREATE INDEX IF NOT EXISTS trustmap_tier_changes_at ON trustmap_tier_changes(at DESC)`,
  `CREATE TABLE IF NOT EXISTS trustmap_inflow (
     id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, block INTEGER NOT NULL, usdc REAL NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS trustmap_inflow_addr ON trustmap_inflow(address, at)`,
  `CREATE TABLE IF NOT EXISTS trustmap_code_cache (address TEXT PRIMARY KEY, is_contract INTEGER NOT NULL, checked_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS trustmap_candidates (
     address TEXT PRIMARY KEY, usdc_in_24h REAL NOT NULL DEFAULT 0, usdc_out_24h REAL NOT NULL DEFAULT 0, tx_count INTEGER NOT NULL DEFAULT 0,
     first_seen_block INTEGER NOT NULL, last_seen_block INTEGER NOT NULL, is_contract INTEGER, bucket_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
     source TEXT NOT NULL DEFAULT 'chain')`,
  `CREATE INDEX IF NOT EXISTS trustmap_candidates_usdc ON trustmap_candidates(usdc_in_24h DESC, last_seen_block DESC)`,
  `CREATE INDEX IF NOT EXISTS trustmap_candidates_block ON trustmap_candidates(last_seen_block)`,
];

let migrated: Promise<void> | null = null;
export function migrateTrustmap(): Promise<void> {
  if (!migrated) {
    migrated = (async () => {
      await migrate();
      for (const s of SCHEMA) await db().execute(s);
    })().catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}
/** test helper */
export function __resetTrustmapMigration() {
  migrated = null;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const str = (v: unknown) => (v == null ? null : String(v));
const nowSec = () => Math.floor(Date.now() / 1000);

// ── meta ─────────────────────────────────────────────────────────────────────
export async function getMeta(key: string): Promise<string | null> {
  await migrateTrustmap();
  const r = await db().execute({ sql: `SELECT value FROM trustmap_meta WHERE key = ?`, args: [key] });
  return r.rows[0] ? String((r.rows[0] as Row).value) : null;
}
export async function setMeta(key: string, value: string): Promise<void> {
  await migrateTrustmap();
  await db().execute({ sql: `INSERT INTO trustmap_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [key, value] });
}
export async function getCursor(): Promise<number | null> {
  const v = await getMeta("cursor_block");
  return v == null ? null : Number(v);
}
export async function setCursor(block: number): Promise<void> {
  await setMeta("cursor_block", String(block));
}
export async function getLastTick(): Promise<TickSummary | null> {
  const v = await getMeta("last_tick");
  if (!v) return null;
  try {
    return JSON.parse(v) as TickSummary;
  } catch {
    return null;
  }
}
export async function setLastTick(t: TickSummary): Promise<void> {
  await setMeta("last_tick", JSON.stringify(t));
}

// ── nodes ────────────────────────────────────────────────────────────────────
export interface NodeRecord extends MapNode {
  rationale: string | null;
  decisionId: string | null;
}
function rowToNode(r: Row): NodeRecord {
  let codes: ReasonCode[] = [];
  try {
    codes = JSON.parse(String(r.reason_codes ?? "[]")) as ReasonCode[];
  } catch {
    codes = [];
  }
  return {
    address: String(r.address) as Address,
    tier: r.tier as Tier,
    score: num(r.score),
    usdcIn24h: num(r.usdc_in_24h),
    lastSeenBlock: num(r.last_seen_block),
    changedAt: numOrNull(r.changed_at),
    prevTier: (str(r.prev_tier) as Tier | null) ?? null,
    firstGradedAt: num(r.first_graded_at),
    lastGradedAt: num(r.last_graded_at),
    reasonCodes: codes,
    source: (str(r.source) as NodeSource) ?? "chain",
    rationale: str(r.rationale),
    decisionId: str(r.decision_id),
  };
}

export async function getNode(address: string): Promise<NodeRecord | null> {
  await migrateTrustmap();
  const r = await db().execute({ sql: `SELECT * FROM trustmap_nodes WHERE address = ?`, args: [address.toLowerCase()] });
  return r.rows[0] ? rowToNode(r.rows[0] as Row) : null;
}
export async function getNodes(addresses: string[]): Promise<Map<Address, NodeRecord>> {
  await migrateTrustmap();
  const out = new Map<Address, NodeRecord>();
  for (let i = 0; i < addresses.length; i += 200) {
    const chunk = addresses.slice(i, i + 200).map((a) => a.toLowerCase());
    if (!chunk.length) continue;
    const r = await db().execute({ sql: `SELECT * FROM trustmap_nodes WHERE address IN (${chunk.map(() => "?").join(",")})`, args: chunk });
    for (const row of r.rows) {
      const n = rowToNode(row as Row);
      out.set(n.address, n);
    }
  }
  return out;
}
export async function allNodeAddresses(): Promise<Set<Address>> {
  await migrateTrustmap();
  const r = await db().execute(`SELECT address FROM trustmap_nodes`);
  return new Set(r.rows.map((x) => String((x as Row).address) as Address));
}
export async function listNodes(limit: number): Promise<NodeRecord[]> {
  await migrateTrustmap();
  const r = await db().execute({ sql: `SELECT * FROM trustmap_nodes ORDER BY usdc_in_24h DESC, last_graded_at DESC, address ASC LIMIT ?`, args: [limit] });
  return r.rows.map((x) => rowToNode(x as Row));
}
export async function countNodes(): Promise<{ graded: number; high: number; medium: number; low: number }> {
  await migrateTrustmap();
  const r = await db().execute(`SELECT tier, COUNT(*) AS n FROM trustmap_nodes GROUP BY tier`);
  const out = { graded: 0, high: 0, medium: 0, low: 0 };
  for (const row of r.rows) {
    const t = String((row as Row).tier);
    const n = num((row as Row).n);
    out.graded += n;
    if (t === "HIGH") out.high = n;
    else if (t === "MEDIUM") out.medium = n;
    else if (t === "LOW") out.low = n;
  }
  return out;
}

export interface UpsertNodeInput {
  address: Address;
  tier: Tier;
  score: number;
  lastSeenBlock: number;
  usdcIn24h: number;
  reasonCodes: ReasonCode[];
  rationale: string | null;
  decisionId: string | null;
  source?: NodeSource;
  at?: number;
}
/** Insert or regrade. Returns the previous row (null on first grade) and whether the tier changed. */
export async function upsertNode(input: UpsertNodeInput): Promise<{ prev: NodeRecord | null; changed: boolean }> {
  await migrateTrustmap();
  const at = input.at ?? nowSec();
  const prev = await getNode(input.address);
  const changed = prev !== null && prev.tier !== input.tier;
  const codes = JSON.stringify(input.reasonCodes);
  if (!prev) {
    await db().execute({
      sql: `INSERT INTO trustmap_nodes (address, tier, score, last_seen_block, usdc_in_24h, first_graded_at, last_graded_at, prev_tier, changed_at, reason_codes, rationale, decision_id, source)
            VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,?,?)`,
      args: [input.address, input.tier, input.score, input.lastSeenBlock, input.usdcIn24h, at, at, codes, input.rationale, input.decisionId, input.source ?? "chain"],
    });
  } else {
    await db().execute({
      sql: `UPDATE trustmap_nodes SET tier = ?, score = ?, last_seen_block = MAX(last_seen_block, ?), usdc_in_24h = ?, last_graded_at = ?,
              prev_tier = CASE WHEN ? THEN ? ELSE prev_tier END, changed_at = CASE WHEN ? THEN ? ELSE changed_at END,
              reason_codes = ?, rationale = ?, decision_id = ?, source = ?
            WHERE address = ?`,
      args: [
        input.tier, input.score, input.lastSeenBlock, input.usdcIn24h, at,
        changed ? 1 : 0, prev.tier, changed ? 1 : 0, at,
        codes, input.rationale, input.decisionId, input.source ?? "chain", input.address,
      ],
    });
  }
  return { prev, changed };
}
/** Bump last_seen_block + rolling 24 h inflow for nodes that received USDC this tick without being regraded. */
export async function touchNode(address: Address, lastSeenBlock: number, usdcIn24h: number): Promise<void> {
  await db().execute({
    sql: `UPDATE trustmap_nodes SET last_seen_block = MAX(last_seen_block, ?), usdc_in_24h = ? WHERE address = ?`,
    args: [lastSeenBlock, usdcIn24h, address],
  });
}

// ── inflow (rolling 24 h) ────────────────────────────────────────────────────
export async function addInflow(address: Address, block: number, usdc: number, at = nowSec()): Promise<void> {
  await migrateTrustmap();
  await db().execute({ sql: `INSERT INTO trustmap_inflow (address, block, usdc, at) VALUES (?,?,?,?)`, args: [address, block, usdc, at] });
}
export async function inflow24h(address: Address, now = nowSec()): Promise<number> {
  await migrateTrustmap();
  const r = await db().execute({ sql: `SELECT COALESCE(SUM(usdc), 0) AS s FROM trustmap_inflow WHERE address = ? AND at >= ?`, args: [address, now - 86_400] });
  return num((r.rows[0] as Row | undefined)?.s);
}
export async function pruneInflow(now = nowSec()): Promise<void> {
  await db().execute({ sql: `DELETE FROM trustmap_inflow WHERE at < ?`, args: [now - 2 * 86_400] });
}

// ── edges ────────────────────────────────────────────────────────────────────
function rowToEdge(r: Row): MapEdge {
  return {
    from: String(r.from_addr) as Address,
    to: String(r.to_addr) as Address,
    usdc: num(r.usdc),
    txHash: String(r.tx_hash) as `0x${string}`,
    block: num(r.block),
    source: (str(r.source) as NodeSource) ?? "chain",
  };
}
export interface EdgeInput {
  from: Address;
  to: Address;
  usdc: number;
  txHash: `0x${string}`;
  block: number;
  source?: NodeSource;
}
/** Insert edges, ignoring duplicates (tx_hash, from, to). Returns how many were new. */
export async function insertEdges(edges: EdgeInput[], at = nowSec()): Promise<number> {
  await migrateTrustmap();
  let added = 0;
  for (const e of edges) {
    const r = await db().execute({
      sql: `INSERT OR IGNORE INTO trustmap_edges (from_addr, to_addr, usdc, tx_hash, block, created_at, source) VALUES (?,?,?,?,?,?,?)`,
      args: [e.from, e.to, e.usdc, e.txHash, e.block, at, e.source ?? "chain"],
    });
    added += Number(r.rowsAffected ?? 0);
  }
  return added;
}
/** Edges whose both ends are in `addresses` (newest first). */
export async function edgesAmong(addresses: Address[], limit = 500): Promise<MapEdge[]> {
  await migrateTrustmap();
  if (addresses.length === 0) return [];
  // libsql parameter limit is generous, but keep the IN list bounded; snapshot limit ≤ 400 nodes.
  const list = addresses.slice(0, 900);
  const q = list.map(() => "?").join(",");
  const r = await db().execute({
    sql: `SELECT * FROM trustmap_edges WHERE from_addr IN (${q}) AND to_addr IN (${q}) ORDER BY block DESC, id DESC LIMIT ?`,
    args: [...list, ...list, limit],
  });
  return r.rows.map((x) => rowToEdge(x as Row));
}
export async function edgesOf(address: Address, limit = 50): Promise<MapEdge[]> {
  await migrateTrustmap();
  const r = await db().execute({
    sql: `SELECT * FROM trustmap_edges WHERE from_addr = ? OR to_addr = ? ORDER BY block DESC, id DESC LIMIT ?`,
    args: [address, address, limit],
  });
  return r.rows.map((x) => rowToEdge(x as Row));
}

// ── tier changes ─────────────────────────────────────────────────────────────
function rowToChange(r: Row): TierChange {
  return {
    id: num(r.id),
    address: String(r.address) as Address,
    from: (str(r.from_tier) as Tier | null) ?? null,
    to: r.to_tier as Tier,
    score: num(r.score),
    block: numOrNull(r.block),
    at: num(r.at),
    source: (str(r.source) as NodeSource) ?? "chain",
  };
}
export async function insertTierChange(c: { address: Address; from: Tier | null; to: Tier; score: number; block: number | null; decisionId: string | null; at?: number; source?: NodeSource }): Promise<void> {
  await migrateTrustmap();
  await db().execute({
    sql: `INSERT INTO trustmap_tier_changes (address, from_tier, to_tier, score, block, decision_id, at, source) VALUES (?,?,?,?,?,?,?,?)`,
    args: [c.address, c.from, c.to, c.score, c.block, c.decisionId, c.at ?? nowSec(), c.source ?? "chain"],
  });
}
export async function listTierChanges(limit: number): Promise<TierChange[]> {
  await migrateTrustmap();
  const r = await db().execute({ sql: `SELECT * FROM trustmap_tier_changes ORDER BY at DESC, id DESC LIMIT ?`, args: [limit] });
  return r.rows.map((x) => rowToChange(x as Row));
}
export async function tierChangesOf(address: Address, limit = 50): Promise<TierChange[]> {
  await migrateTrustmap();
  const r = await db().execute({ sql: `SELECT * FROM trustmap_tier_changes WHERE address = ? ORDER BY at DESC, id DESC LIMIT ?`, args: [address, limit] });
  return r.rows.map((x) => rowToChange(x as Row));
}
export async function countTierChangesSince(since: number): Promise<number> {
  await migrateTrustmap();
  const r = await db().execute({ sql: `SELECT COUNT(*) AS n FROM trustmap_tier_changes WHERE at >= ?`, args: [since] });
  return num((r.rows[0] as Row | undefined)?.n);
}

/** Drop edges older than `minBlock` unless both ends are graded nodes (graded↔graded history is kept). */
export async function pruneCandidateEdges(minBlock: number): Promise<number> {
  await migrateTrustmap();
  const r = await db().execute({
    sql: `DELETE FROM trustmap_edges WHERE block < ? AND (from_addr NOT IN (SELECT address FROM trustmap_nodes) OR to_addr NOT IN (SELECT address FROM trustmap_nodes))`,
    args: [minBlock],
  });
  return Number(r.rowsAffected ?? 0);
}

// ── candidates (observed, ungraded) ──────────────────────────────────────────
function rowToCandidate(r: Row): MapCandidate {
  return {
    address: String(r.address) as Address,
    usdcIn24h: num(r.usdc_in_24h),
    usdcOut24h: num(r.usdc_out_24h),
    txCount: num(r.tx_count),
    firstSeenBlock: num(r.first_seen_block),
    lastSeenBlock: num(r.last_seen_block),
    isContract: r.is_contract == null ? null : num(r.is_contract) === 1,
    lastSeenAt: num(r.last_seen_at),
    source: (str(r.source) as NodeSource) ?? "chain",
  };
}
export interface CandidateInput {
  address: Address;
  /** USDC received in this tick's window */
  usdcIn: number;
  /** USDC sent (to graded nodes) in this tick's window */
  usdcOut: number;
  txCount: number;
  firstSeenBlock: number;
  lastSeenBlock: number;
  isContract?: boolean | null;
  source?: NodeSource;
}
/**
 * Upsert observed addresses. The 24 h figures are rolling buckets: when a row's bucket is older than a day it restarts
 * with this tick's amounts, otherwise the amounts are added. One libsql batch per call (no per-row round trips).
 */
export async function upsertCandidates(list: CandidateInput[], at = nowSec()): Promise<number> {
  await migrateTrustmap();
  if (!list.length) return 0;
  const stmts = list.map((c) => ({
    sql: `INSERT INTO trustmap_candidates (address, usdc_in_24h, usdc_out_24h, tx_count, first_seen_block, last_seen_block, is_contract, bucket_at, last_seen_at, source)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(address) DO UPDATE SET
            usdc_in_24h = CASE WHEN excluded.bucket_at - bucket_at >= 86400 THEN excluded.usdc_in_24h ELSE usdc_in_24h + excluded.usdc_in_24h END,
            usdc_out_24h = CASE WHEN excluded.bucket_at - bucket_at >= 86400 THEN excluded.usdc_out_24h ELSE usdc_out_24h + excluded.usdc_out_24h END,
            tx_count = CASE WHEN excluded.bucket_at - bucket_at >= 86400 THEN excluded.tx_count ELSE tx_count + excluded.tx_count END,
            bucket_at = CASE WHEN excluded.bucket_at - bucket_at >= 86400 THEN excluded.bucket_at ELSE bucket_at END,
            first_seen_block = MIN(first_seen_block, excluded.first_seen_block),
            last_seen_block = MAX(last_seen_block, excluded.last_seen_block),
            is_contract = COALESCE(excluded.is_contract, is_contract),
            last_seen_at = excluded.last_seen_at,
            source = excluded.source`,
    args: [c.address, c.usdcIn, c.usdcOut, c.txCount, c.firstSeenBlock, c.lastSeenBlock, c.isContract == null ? null : c.isContract ? 1 : 0, at, at, c.source ?? "chain"],
  }));
  for (let i = 0; i < stmts.length; i += 100) await db().batch(stmts.slice(i, i + 100), "write");
  return list.length;
}
export async function deleteCandidates(addresses: Address[]): Promise<void> {
  await migrateTrustmap();
  for (let i = 0; i < addresses.length; i += 200) {
    const chunk = addresses.slice(i, i + 200);
    if (!chunk.length) continue;
    await db().execute({ sql: `DELETE FROM trustmap_candidates WHERE address IN (${chunk.map(() => "?").join(",")})`, args: chunk });
  }
}
/** Retention: drop rows last seen more than CANDIDATE_BLOCKS behind `cursorBlock`, then trim to CANDIDATE_ROWS rows. */
export async function pruneCandidates(cursorBlock: number, rows = CANDIDATE_ROWS, blocks = CANDIDATE_BLOCKS): Promise<void> {
  await migrateTrustmap();
  await db().execute({ sql: `DELETE FROM trustmap_candidates WHERE last_seen_block < ?`, args: [cursorBlock - blocks] });
  await db().execute(`DELETE FROM trustmap_candidates WHERE address IN (SELECT address FROM trustmap_nodes)`); // overlapping ticks: graded wins
  await db().execute({
    sql: `DELETE FROM trustmap_candidates WHERE address IN (SELECT address FROM trustmap_candidates ORDER BY usdc_in_24h DESC, last_seen_block DESC, address ASC LIMIT -1 OFFSET ?)`,
    args: [rows],
  });
}
export async function listCandidates(limit: number): Promise<MapCandidate[]> {
  await migrateTrustmap();
  const r = await db().execute({ sql: `SELECT * FROM trustmap_candidates ORDER BY usdc_in_24h DESC, last_seen_block DESC, address ASC LIMIT ?`, args: [limit] });
  return r.rows.map((x) => rowToCandidate(x as Row));
}
export async function getCandidate(address: string): Promise<MapCandidate | null> {
  await migrateTrustmap();
  const r = await db().execute({ sql: `SELECT * FROM trustmap_candidates WHERE address = ?`, args: [address.toLowerCase()] });
  return r.rows[0] ? rowToCandidate(r.rows[0] as Row) : null;
}
export async function allCandidateAddresses(): Promise<Set<Address>> {
  await migrateTrustmap();
  const r = await db().execute(`SELECT address FROM trustmap_candidates`);
  return new Set(r.rows.map((x) => String((x as Row).address) as Address));
}
export async function countCandidates(): Promise<number> {
  await migrateTrustmap();
  const r = await db().execute(`SELECT COUNT(*) AS n FROM trustmap_candidates`);
  return num((r.rows[0] as Row | undefined)?.n);
}

// ── eth_getCode cache ────────────────────────────────────────────────────────
export async function cachedIsContract(address: Address): Promise<boolean | null> {
  await migrateTrustmap();
  const r = await db().execute({ sql: `SELECT is_contract FROM trustmap_code_cache WHERE address = ?`, args: [address] });
  const row = r.rows[0] as Row | undefined;
  return row ? num(row.is_contract) === 1 : null;
}
/** Batched read of the code cache (one query per 200 addresses); addresses never asked are absent from the map. */
export async function cachedIsContractMany(addresses: Address[]): Promise<Map<Address, boolean>> {
  await migrateTrustmap();
  const out = new Map<Address, boolean>();
  for (let i = 0; i < addresses.length; i += 200) {
    const chunk = addresses.slice(i, i + 200);
    if (!chunk.length) continue;
    const r = await db().execute({ sql: `SELECT address, is_contract FROM trustmap_code_cache WHERE address IN (${chunk.map(() => "?").join(",")})`, args: chunk });
    for (const row of r.rows) out.set(String((row as Row).address) as Address, num((row as Row).is_contract) === 1);
  }
  return out;
}
export async function rememberIsContract(address: Address, isContract: boolean, at = nowSec()): Promise<void> {
  await db().execute({
    sql: `INSERT INTO trustmap_code_cache (address, is_contract, checked_at) VALUES (?,?,?) ON CONFLICT(address) DO UPDATE SET is_contract = excluded.is_contract, checked_at = excluded.checked_at`,
    args: [address, isContract ? 1 : 0, at],
  });
}
