/**
 * ERC-8004 persistence - own tables on the shared libsql client (src/lib/store/db.ts):
 *   erc8004_agents        address → agentId index (owner + agentWallet), built from Registered/Transfer/MetadataSet logs
 *   erc8004_meta          key/value: cursor_block, last_sync
 *   erc8004_publications  one row per on-chain feedback / validation CompliR published (dedupe + audit)
 * The IdentityRegistry is a plain ERC-721 (no enumeration), so "which agent does this address own?" needs this index.
 */
import { db, migrate } from "../store/db";
import type { Address } from "../types";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS erc8004_agents (
     agent_id TEXT PRIMARY KEY, owner TEXT NOT NULL, wallet TEXT, agent_uri TEXT, registered_block INTEGER, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS erc8004_agents_owner ON erc8004_agents(owner)`,
  `CREATE INDEX IF NOT EXISTS erc8004_agents_wallet ON erc8004_agents(wallet)`,
  `CREATE TABLE IF NOT EXISTS erc8004_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS erc8004_publications (
     id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, subject TEXT NOT NULL, decision_id TEXT NOT NULL, mode TEXT NOT NULL,
     request_hash TEXT, response INTEGER NOT NULL, tier TEXT NOT NULL, tx_hash TEXT, ledger_id TEXT, error TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS erc8004_publications_agent ON erc8004_publications(agent_id, created_at)`,
];

let migrated: Promise<void> | null = null;
export function migrateErc8004(): Promise<void> {
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
export function __resetErc8004Migration() {
  migrated = null;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));

export interface AgentRow {
  agentId: string;
  owner: Address;
  wallet: Address | null;
  agentUri: string | null;
  registeredBlock: number | null;
  updatedAt: number;
}
const toRow = (r: Row): AgentRow => ({
  agentId: String(r.agent_id),
  owner: String(r.owner) as Address,
  wallet: str(r.wallet) as Address | null,
  agentUri: str(r.agent_uri),
  registeredBlock: r.registered_block == null ? null : Number(r.registered_block),
  updatedAt: Number(r.updated_at),
});

export async function upsertAgent(a: { agentId: bigint | string; owner: string; wallet?: string | null; agentUri?: string | null; registeredBlock?: number | null; now?: number }): Promise<void> {
  await migrateErc8004();
  await db().execute({
    sql: `INSERT INTO erc8004_agents (agent_id, owner, wallet, agent_uri, registered_block, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent_id) DO UPDATE SET owner = excluded.owner,
            wallet = COALESCE(excluded.wallet, erc8004_agents.wallet),
            agent_uri = COALESCE(excluded.agent_uri, erc8004_agents.agent_uri),
            registered_block = COALESCE(erc8004_agents.registered_block, excluded.registered_block),
            updated_at = excluded.updated_at`,
    args: [String(a.agentId), a.owner.toLowerCase(), a.wallet?.toLowerCase() ?? null, a.agentUri ?? null, a.registeredBlock ?? null, a.now ?? Math.floor(Date.now() / 1000)],
  });
}

/** Agents the address owns or is the agentWallet of (lowest agentId first). */
export async function agentsFor(address: string): Promise<AgentRow[]> {
  await migrateErc8004();
  const a = address.toLowerCase();
  const r = await db().execute({ sql: `SELECT * FROM erc8004_agents WHERE owner = ? OR wallet = ? ORDER BY CAST(agent_id AS INTEGER) ASC LIMIT 10`, args: [a, a] });
  return r.rows.map((x) => toRow(x as Row));
}

export async function getAgent(agentId: bigint | string): Promise<AgentRow | null> {
  await migrateErc8004();
  const r = await db().execute({ sql: `SELECT * FROM erc8004_agents WHERE agent_id = ?`, args: [String(agentId)] });
  return r.rows[0] ? toRow(r.rows[0] as Row) : null;
}

export async function countAgents(): Promise<number> {
  await migrateErc8004();
  const r = await db().execute(`SELECT COUNT(*) AS n FROM erc8004_agents`);
  return Number((r.rows[0] as Row | undefined)?.n ?? 0);
}

// ── meta ─────────────────────────────────────────────────────────────────────
export async function getMeta(key: string): Promise<string | null> {
  await migrateErc8004();
  const r = await db().execute({ sql: `SELECT value FROM erc8004_meta WHERE key = ?`, args: [key] });
  return r.rows[0] ? String((r.rows[0] as Row).value) : null;
}
export async function setMeta(key: string, value: string): Promise<void> {
  await migrateErc8004();
  await db().execute({ sql: `INSERT INTO erc8004_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [key, value] });
}
export async function getCursor(): Promise<number | null> {
  const v = await getMeta("cursor_block");
  return v == null ? null : Number(v);
}
export async function setCursor(block: number): Promise<void> {
  await setMeta("cursor_block", String(block));
}

// ── publications ─────────────────────────────────────────────────────────────
export interface PublicationRow {
  id: number;
  agentId: string;
  subject: Address;
  decisionId: string;
  mode: "validationResponse" | "giveFeedback";
  requestHash: string | null;
  response: number;
  tier: string;
  txHash: string | null;
  ledgerId: string | null;
  error: string | null;
  createdAt: number;
}
const toPub = (r: Row): PublicationRow => ({
  id: Number(r.id), agentId: String(r.agent_id), subject: String(r.subject) as Address, decisionId: String(r.decision_id),
  mode: String(r.mode) as PublicationRow["mode"], requestHash: str(r.request_hash), response: Number(r.response), tier: String(r.tier),
  txHash: str(r.tx_hash), ledgerId: str(r.ledger_id), error: str(r.error), createdAt: Number(r.created_at),
});

export async function insertPublication(p: Omit<PublicationRow, "id">): Promise<number> {
  await migrateErc8004();
  const r = await db().execute({
    sql: `INSERT INTO erc8004_publications (agent_id, subject, decision_id, mode, request_hash, response, tier, tx_hash, ledger_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [p.agentId, p.subject, p.decisionId, p.mode, p.requestHash, p.response, p.tier, p.txHash, p.ledgerId, p.error, p.createdAt],
  });
  return Number(r.lastInsertRowid ?? 0);
}

/** Latest successful publication about an agent (for the min-interval gate). */
export async function lastPublication(agentId: bigint | string): Promise<PublicationRow | null> {
  await migrateErc8004();
  const r = await db().execute({ sql: `SELECT * FROM erc8004_publications WHERE agent_id = ? AND tx_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1`, args: [String(agentId)] });
  return r.rows[0] ? toPub(r.rows[0] as Row) : null;
}

export async function recentPublications(limit = 20): Promise<PublicationRow[]> {
  await migrateErc8004();
  const r = await db().execute({ sql: `SELECT * FROM erc8004_publications ORDER BY created_at DESC LIMIT ?`, args: [limit] });
  return r.rows.map((x) => toPub(x as Row));
}
