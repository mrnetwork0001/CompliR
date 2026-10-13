/**
 * Event reactor persistence. Own tables (CREATE TABLE IF NOT EXISTS, idempotent) on the shared libsql db():
 *   events_meta   key/value: cursor_block, last_tick
 *   events_log    one row per blocklist event seen (handled or ignored) + every simulated drill
 *
 * Read-only lookups into the lead's `watches` / `screenings` tables decide whether an event is relevant.
 */
import { db, migrate } from "../store/db";
import type { Address, Tier, Watch } from "../types";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, event_name TEXT NOT NULL, address TEXT NOT NULL,
     block INTEGER, tx_hash TEXT, log_index INTEGER, simulated INTEGER NOT NULL DEFAULT 0,
     matched TEXT NOT NULL DEFAULT '[]', rescreened INTEGER NOT NULL DEFAULT 0, tier_from TEXT, tier_to TEXT, score INTEGER,
     decision_id TEXT, webhooks INTEGER NOT NULL DEFAULT 0, watches INTEGER NOT NULL DEFAULT 0, error TEXT,
     latency_ms INTEGER, handled_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS events_log_tx ON events_log(tx_hash, log_index)`,
  `CREATE INDEX IF NOT EXISTS events_log_addr ON events_log(address, handled_at)`,
  `CREATE INDEX IF NOT EXISTS events_log_at ON events_log(handled_at DESC)`,
];

let migrated: Promise<void> | null = null;
export function migrateEvents(): Promise<void> {
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
export function __resetEventsMigration() {
  migrated = null;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const str = (v: unknown) => (v == null ? null : String(v));
const nowSec = () => Math.floor(Date.now() / 1000);

// ── meta ─────────────────────────────────────────────────────────────────────
export async function getEventsMeta(key: string): Promise<string | null> {
  await migrateEvents();
  const r = await db().execute({ sql: `SELECT value FROM events_meta WHERE key = ?`, args: [key] });
  return r.rows[0] ? String((r.rows[0] as Row).value) : null;
}
export async function setEventsMeta(key: string, value: string): Promise<void> {
  await migrateEvents();
  await db().execute({ sql: `INSERT INTO events_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [key, value] });
}
export async function getEventsCursor(): Promise<number | null> {
  const v = await getEventsMeta("cursor_block");
  return v == null ? null : Number(v);
}
export async function setEventsCursor(block: number): Promise<void> {
  await setEventsMeta("cursor_block", String(block));
}

// ── log ──────────────────────────────────────────────────────────────────────
export type BlocklistEventKind = "BLOCKLISTED" | "UNBLOCKLISTED";
export type EventMatch = "watched" | "trustmap" | "screened";

export interface EventLogEntry {
  id: number;
  kind: BlocklistEventKind;
  /** on-chain event name as emitted (Blacklisted / UnBlacklisted / Blocklisted / UnBlocklisted) or "Simulated" */
  eventName: string;
  address: Address;
  block: number | null;
  txHash: `0x${string}` | null;
  logIndex: number | null;
  simulated: boolean;
  /** why we acted (empty = ignored: nobody watches / graded / screened this address) */
  matched: EventMatch[];
  rescreened: boolean;
  tierFrom: Tier | null;
  tierTo: Tier | null;
  score: number | null;
  decisionId: string | null;
  /** webhooks delivered (HTTP 2xx) / watches on the address */
  webhooks: number;
  watches: number;
  error: string | null;
  latencyMs: number | null;
  handledAt: number;
}

function rowToEntry(r: Row): EventLogEntry {
  let matched: EventMatch[] = [];
  try { matched = JSON.parse(String(r.matched ?? "[]")) as EventMatch[]; } catch { matched = []; }
  return {
    id: num(r.id), kind: r.kind as BlocklistEventKind, eventName: String(r.event_name), address: String(r.address) as Address,
    block: numOrNull(r.block), txHash: str(r.tx_hash) as `0x${string}` | null, logIndex: numOrNull(r.log_index),
    simulated: num(r.simulated) === 1, matched, rescreened: num(r.rescreened) === 1,
    tierFrom: str(r.tier_from) as Tier | null, tierTo: str(r.tier_to) as Tier | null, score: numOrNull(r.score),
    decisionId: str(r.decision_id), webhooks: num(r.webhooks), watches: num(r.watches), error: str(r.error),
    latencyMs: numOrNull(r.latency_ms), handledAt: num(r.handled_at),
  };
}

export type EventLogInput = Omit<EventLogEntry, "id" | "handledAt"> & { handledAt?: number };

export async function insertEventLog(e: EventLogInput): Promise<number> {
  await migrateEvents();
  const r = await db().execute({
    sql: `INSERT INTO events_log (kind, event_name, address, block, tx_hash, log_index, simulated, matched, rescreened, tier_from, tier_to, score,
            decision_id, webhooks, watches, error, latency_ms, handled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      e.kind, e.eventName, e.address, e.block, e.txHash, e.logIndex, e.simulated ? 1 : 0, JSON.stringify(e.matched), e.rescreened ? 1 : 0,
      e.tierFrom, e.tierTo, e.score, e.decisionId, e.webhooks, e.watches, e.error, e.latencyMs, e.handledAt ?? nowSec(),
    ],
  });
  return Number(r.lastInsertRowid ?? 0);
}
/** Already in the log? (re-org-safe idempotency key: tx hash + log index) */
export async function hasHandledLog(txHash: string, logIndex: number): Promise<boolean> {
  await migrateEvents();
  const r = await db().execute({ sql: `SELECT 1 FROM events_log WHERE tx_hash = ? AND log_index = ? LIMIT 1`, args: [txHash, logIndex] });
  return r.rows.length > 0;
}
export async function listEventLogs(limit = 50): Promise<EventLogEntry[]> {
  await migrateEvents();
  const r = await db().execute({ sql: `SELECT * FROM events_log ORDER BY handled_at DESC, id DESC LIMIT ?`, args: [Math.min(Math.max(limit, 1), 200)] });
  return r.rows.map((x) => rowToEntry(x as Row));
}
export async function eventLogsOf(address: Address, limit = 10): Promise<EventLogEntry[]> {
  await migrateEvents();
  const r = await db().execute({ sql: `SELECT * FROM events_log WHERE address = ? ORDER BY handled_at DESC, id DESC LIMIT ?`, args: [address.toLowerCase(), limit] });
  return r.rows.map((x) => rowToEntry(x as Row));
}

// ── relevance lookups (lead's tables, read-only) ─────────────────────────────
function rowToWatch(x: Row): Watch {
  return {
    id: String(x.id), address: String(x.address) as Address, webhookUrl: String(x.webhook_url), clientId: str(x.client_id),
    lastTier: str(x.last_tier) as Tier | null, nextRescreenAt: num(x.next_rescreen_at), expiresAt: num(x.expires_at), createdAt: num(x.created_at),
  };
}
/** Every unexpired watch on `address` (any client). */
export async function activeWatchesFor(address: Address, at = nowSec()): Promise<Watch[]> {
  await migrate();
  const r = await db().execute({ sql: `SELECT * FROM watches WHERE address = ? AND expires_at > ? ORDER BY created_at ASC`, args: [address.toLowerCase(), at] });
  return r.rows.map((x) => rowToWatch(x as Row));
}
/** Was `address` screened (by anyone) since `since`? */
export async function screenedSince(address: Address, since: number): Promise<boolean> {
  await migrate();
  const r = await db().execute({ sql: `SELECT 1 FROM screenings WHERE subject = ? AND created_at >= ? LIMIT 1`, args: [address.toLowerCase(), since] });
  return r.rows.length > 0;
}
