/**
 * CCTP inbound persistence - own tables on the shared libsql client (src/lib/store/db.ts):
 *   cctp_meta      key/value: cursor_block, last_tick
 *   cctp_inbound   one row per inbound mint ≥ CCTP_MIN_USDC (sender checks + recipient verdict + flagged)
 */
import { db, migrate } from "../store/db";
import type { Address, InboundSignal, SanctionsHit, Tier } from "../types";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cctp_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cctp_inbound (
     id INTEGER PRIMARY KEY AUTOINCREMENT, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block INTEGER NOT NULL, block_time INTEGER,
     source_domain INTEGER NOT NULL, source_chain TEXT NOT NULL, source_sender TEXT NOT NULL, recipient TEXT NOT NULL,
     amount_usdc TEXT NOT NULL, burn_token TEXT, sender_sanctions TEXT NOT NULL DEFAULT '[]', sender_blacklisted INTEGER NOT NULL DEFAULT 0,
     sender_checks TEXT, recipient_decision_id TEXT, recipient_tier TEXT, recipient_score INTEGER, flagged INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cctp_inbound_tx ON cctp_inbound(tx_hash, log_index)`,
  `CREATE INDEX IF NOT EXISTS cctp_inbound_recipient ON cctp_inbound(recipient, created_at)`,
  `CREATE INDEX IF NOT EXISTS cctp_inbound_at ON cctp_inbound(created_at DESC)`,
];

let migrated: Promise<void> | null = null;
export function migrateCctp(): Promise<void> {
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
export function __resetCctpMigration() {
  migrated = null;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));
const json = <T>(v: unknown, d: T): T => {
  try {
    return v == null ? d : (JSON.parse(String(v)) as T);
  } catch {
    return d;
  }
};

export interface SenderChecks {
  sanctions: "ok" | "timeout_or_error" | "skipped";
  blacklist: "ok" | "timeout_or_error" | "skipped";
}

export interface InboundRow {
  id: number;
  txHash: `0x${string}`;
  logIndex: number;
  block: number;
  blockTime: number | null;
  sourceDomain: number;
  sourceChain: string;
  sourceSender: Address;
  recipient: Address;
  amountUsdc: string;
  burnToken: Address | null;
  senderSanctions: SanctionsHit[];
  senderBlacklisted: boolean;
  senderChecks: SenderChecks | null;
  recipientDecisionId: string | null;
  recipientTier: Tier | null;
  recipientScore: number | null;
  flagged: boolean;
  createdAt: number;
}

const toRow = (r: Row): InboundRow => ({
  id: Number(r.id), txHash: String(r.tx_hash) as `0x${string}`, logIndex: Number(r.log_index), block: Number(r.block),
  blockTime: r.block_time == null ? null : Number(r.block_time), sourceDomain: Number(r.source_domain), sourceChain: String(r.source_chain),
  sourceSender: String(r.source_sender) as Address, recipient: String(r.recipient) as Address, amountUsdc: String(r.amount_usdc),
  burnToken: str(r.burn_token) as Address | null, senderSanctions: json<SanctionsHit[]>(r.sender_sanctions, []), senderBlacklisted: Number(r.sender_blacklisted) === 1,
  senderChecks: json<SenderChecks | null>(r.sender_checks, null), recipientDecisionId: str(r.recipient_decision_id), recipientTier: str(r.recipient_tier) as Tier | null,
  recipientScore: r.recipient_score == null ? null : Number(r.recipient_score), flagged: Number(r.flagged) === 1, createdAt: Number(r.created_at),
});

export async function insertInbound(row: Omit<InboundRow, "id">): Promise<boolean> {
  await migrateCctp();
  const r = await db().execute({
    sql: `INSERT OR IGNORE INTO cctp_inbound (tx_hash, log_index, block, block_time, source_domain, source_chain, source_sender, recipient, amount_usdc, burn_token,
            sender_sanctions, sender_blacklisted, sender_checks, recipient_decision_id, recipient_tier, recipient_score, flagged, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [row.txHash, row.logIndex, row.block, row.blockTime, row.sourceDomain, row.sourceChain, row.sourceSender, row.recipient, row.amountUsdc, row.burnToken,
      JSON.stringify(row.senderSanctions), row.senderBlacklisted ? 1 : 0, row.senderChecks ? JSON.stringify(row.senderChecks) : null,
      row.recipientDecisionId, row.recipientTier, row.recipientScore, row.flagged ? 1 : 0, row.createdAt],
  });
  return Number(r.rowsAffected) > 0;
}

export async function hasInbound(txHash: string, logIndex: number): Promise<boolean> {
  await migrateCctp();
  const r = await db().execute({ sql: `SELECT 1 FROM cctp_inbound WHERE tx_hash = ? AND log_index = ?`, args: [txHash.toLowerCase(), logIndex] });
  return r.rows.length > 0;
}

export async function recentInbound(limit = 50, offset = 0): Promise<InboundRow[]> {
  await migrateCctp();
  const r = await db().execute({ sql: `SELECT * FROM cctp_inbound ORDER BY block DESC, log_index DESC LIMIT ? OFFSET ?`, args: [limit, offset] });
  return r.rows.map((x) => toRow(x as Row));
}

export async function inboundFor(recipient: string, limit = 50): Promise<InboundRow[]> {
  await migrateCctp();
  const r = await db().execute({ sql: `SELECT * FROM cctp_inbound WHERE recipient = ? ORDER BY block DESC, log_index DESC LIMIT ?`, args: [recipient.toLowerCase(), limit] });
  return r.rows.map((x) => toRow(x as Row));
}

/** Latest row for a recipient that carries a verdict (for verdict reuse inside CCTP_RESCREEN_HOURS). */
export async function lastVerdictFor(recipient: string): Promise<InboundRow | null> {
  await migrateCctp();
  const r = await db().execute({ sql: `SELECT * FROM cctp_inbound WHERE recipient = ? AND recipient_decision_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, args: [recipient.toLowerCase()] });
  return r.rows[0] ? toRow(r.rows[0] as Row) : null;
}

export async function countInbound(): Promise<{ total: number; flagged: number }> {
  await migrateCctp();
  const r = await db().execute(`SELECT COUNT(*) AS n, COALESCE(SUM(flagged), 0) AS f FROM cctp_inbound`);
  const row = r.rows[0] as Row | undefined;
  return { total: Number(row?.n ?? 0), flagged: Number(row?.f ?? 0) };
}

/** EvidenceBundle.inbound for a subject: flagged inbound mints in the window. null when the subject has no rows at all. */
export async function inboundEvidenceFor(address: string, opts: { now?: number; windowDays?: number } = {}): Promise<InboundSignal | null> {
  await migrateCctp();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const days = opts.windowDays ?? 30;
  const since = now - days * 86_400;
  const r = await db().execute({
    sql: `SELECT flagged, source_chain, COALESCE(block_time, created_at) AS at FROM cctp_inbound WHERE recipient = ? AND COALESCE(block_time, created_at) >= ?`,
    args: [address.toLowerCase(), since],
  });
  if (r.rows.length === 0) return null;
  const flagged = r.rows.filter((x) => Number((x as Row).flagged) === 1);
  return {
    flaggedCount: flagged.length,
    lastAt: flagged.length ? Math.max(...flagged.map((x) => Number((x as Row).at))) : null,
    sources: [...new Set(flagged.map((x) => String((x as Row).source_chain)))].sort(),
    windowDays: days,
    seen: r.rows.length,
  };
}

// ── meta ─────────────────────────────────────────────────────────────────────
export async function getMeta(key: string): Promise<string | null> {
  await migrateCctp();
  const r = await db().execute({ sql: `SELECT value FROM cctp_meta WHERE key = ?`, args: [key] });
  return r.rows[0] ? String((r.rows[0] as Row).value) : null;
}
export async function setMeta(key: string, value: string): Promise<void> {
  await migrateCctp();
  await db().execute({ sql: `INSERT INTO cctp_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [key, value] });
}
export async function getCursor(): Promise<number | null> {
  const v = await getMeta("cursor_block");
  return v == null ? null : Number(v);
}
export async function setCursor(block: number): Promise<void> {
  await setMeta("cursor_block", String(block));
}
