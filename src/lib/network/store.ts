/**
 * Network-signal persistence. Own table (CREATE TABLE IF NOT EXISTS, idempotent) on the shared libsql db():
 *   payee_funders   (client_id, payee, funder) — hop-1 funders seen for each client's payees, written on every screen
 *
 * Reads also touch the lead's `screenings` (held-elsewhere) and the Trust Map's `trustmap_edges` (concentration) —
 * read-only, and only ever reduced to counts before leaving this module.
 */
import { db, migrate } from "../store/db";
import { INTERNAL_CLIENT_IDS } from "../store/repo";
import { migrateTrustmap } from "../trustmap/store";
import type { Address } from "../types";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS payee_funders (
     client_id TEXT NOT NULL, payee TEXT NOT NULL, funder TEXT NOT NULL, hop INTEGER NOT NULL DEFAULT 1,
     first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
     PRIMARY KEY (client_id, payee, funder))`,
  `CREATE INDEX IF NOT EXISTS payee_funders_funder ON payee_funders(funder)`,
  `CREATE INDEX IF NOT EXISTS payee_funders_payee ON payee_funders(payee)`,
  // lead's table; this index only serves the held-elsewhere lookup (subject + window). Idempotent.
  `CREATE INDEX IF NOT EXISTS screenings_subject_at ON screenings(subject, created_at)`,
];

let migrated: Promise<void> | null = null;
export function migrateNetwork(): Promise<void> {
  if (!migrated) {
    migrated = (async () => {
      await migrate();
      await migrateTrustmap();
      for (const s of SCHEMA) await db().execute(s);
    })().catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}
/** test helper */
export function __resetNetworkMigration() {
  migrated = null;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);
const nowSec = () => Math.floor(Date.now() / 1000);
const lower = (a: string) => a.toLowerCase() as Address;

/** Remember (client, payee, funder) for every hop-1 funder of a screened payee. Upsert; bumps last_seen_at. */
export async function upsertPayeeFunders(clientId: string, payee: Address, funders: Address[], at = nowSec()): Promise<number> {
  await migrateNetwork();
  const p = lower(payee);
  const uniq = [...new Set(funders.map(lower))].filter((f) => f !== p);
  for (const f of uniq) {
    await db().execute({
      sql: `INSERT INTO payee_funders (client_id, payee, funder, hop, first_seen_at, last_seen_at) VALUES (?,?,?,1,?,?)
            ON CONFLICT(client_id, payee, funder) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      args: [clientId, p, f, at, at],
    });
  }
  return uniq.length;
}

/**
 * Distinct OTHER clients whose screen rated `subject` HIGH since `since`. Internal ids (our UI/workers/demos) and
 * `clientId` itself never count. Returns a count + the latest such screen — no client id leaves the store.
 */
export async function heldElsewhere(subject: Address, clientId: string | null, since: number): Promise<{ clients: number; lastAt: number | null }> {
  await migrateNetwork();
  const internal = [...INTERNAL_CLIENT_IDS];
  const args: (string | number)[] = [lower(subject), since, ...internal];
  let sql = `SELECT COUNT(DISTINCT client_id) AS n, MAX(created_at) AS t FROM screenings
             WHERE subject = ? AND tier = 'HIGH' AND created_at >= ? AND client_id IS NOT NULL
               AND LOWER(client_id) NOT IN (${internal.map(() => "?").join(",")})`;
  if (clientId) {
    sql += ` AND LOWER(client_id) != ?`;
    args.push(clientId.toLowerCase());
  }
  const r = await db().execute({ sql, args });
  const row = r.rows[0] as Row | undefined;
  const clients = num(row?.n);
  return { clients, lastAt: clients > 0 && row?.t != null ? num(row.t) : null };
}

/** Among THIS client's other payees, how many share one of `funders`? Picks the funder with the most matches. */
export async function sharedFunderForClient(clientId: string, subject: Address, funders: Address[]): Promise<{ count: number; funder: Address | null }> {
  await migrateNetwork();
  const uniq = [...new Set(funders.map(lower))];
  if (uniq.length === 0) return { count: 0, funder: null };
  const r = await db().execute({
    sql: `SELECT funder, COUNT(DISTINCT payee) AS n FROM payee_funders
          WHERE client_id = ? AND payee != ? AND funder IN (${uniq.map(() => "?").join(",")})
          GROUP BY funder ORDER BY n DESC, funder ASC LIMIT 1`,
    args: [clientId, lower(subject), ...uniq],
  });
  const row = r.rows[0] as Row | undefined;
  return row ? { count: num(row.n), funder: String(row.funder) as Address } : { count: 0, funder: null };
}

/**
 * Network-wide: how many OTHER payees (any client's payee book) or Trust Map recipients were funded by one of
 * `funders`? Picks the funder with the most. Count only — the funder is the subject's own hop-1 funder.
 */
export async function concentrationAcrossNetwork(subject: Address, funders: Address[]): Promise<{ funder: Address; otherPayees: number } | null> {
  await migrateNetwork();
  const uniq = [...new Set(funders.map(lower))];
  if (uniq.length === 0) return null;
  const q = uniq.map(() => "?").join(",");
  const s = lower(subject);
  const r = await db().execute({
    sql: `SELECT funder, COUNT(DISTINCT payee) AS n FROM (
            SELECT funder, payee FROM payee_funders WHERE funder IN (${q}) AND payee != ?
            UNION
            SELECT from_addr AS funder, to_addr AS payee FROM trustmap_edges WHERE from_addr IN (${q}) AND to_addr != ?
          ) GROUP BY funder ORDER BY n DESC, funder ASC LIMIT 1`,
    args: [...uniq, s, ...uniq, s],
  });
  const row = r.rows[0] as Row | undefined;
  if (!row || num(row.n) === 0) return null;
  return { funder: String(row.funder) as Address, otherPayees: num(row.n) };
}

/** Hop-1 funders we have already seen for `subject` (any client's screen, or the Trust Map). For callers without a fresh trace. */
export async function knownFundersOf(subject: Address, limit = 50): Promise<Address[]> {
  await migrateNetwork();
  const s = lower(subject);
  const r = await db().execute({
    sql: `SELECT funder FROM (
            SELECT funder, MAX(last_seen_at) AS t FROM payee_funders WHERE payee = ? GROUP BY funder
            UNION ALL
            SELECT from_addr AS funder, MAX(created_at) AS t FROM trustmap_edges WHERE to_addr = ? GROUP BY from_addr
          ) ORDER BY t DESC LIMIT ?`,
    args: [s, s, limit],
  });
  return [...new Set(r.rows.map((x) => String((x as Row).funder) as Address))];
}
