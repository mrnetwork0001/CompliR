import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";

let client: Client | null = null;
let migrated: Promise<void> | null = null;

export function db(): Client {
  if (client) return client;
  const url = config().DATABASE_URL;
  if (url.startsWith("file:") && !url.includes(":memory:")) {
    try { mkdirSync(dirname(url.slice(5)), { recursive: true }); } catch { /* exists */ }
  }
  client = createClient({ url, authToken: config().DATABASE_AUTH_TOKEN });
  return client;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS decisions (
     id TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, kind TEXT NOT NULL, subject TEXT, client_id TEXT,
     payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL, anchor_tx TEXT)`,
  `CREATE INDEX IF NOT EXISTS decisions_subject ON decisions(subject, created_at)`,
  `CREATE TABLE IF NOT EXISTS attestations (
     id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, tier TEXT NOT NULL, score INTEGER NOT NULL,
     decision_id TEXT NOT NULL, valid_until INTEGER NOT NULL, signature TEXT NOT NULL, typed_data TEXT NOT NULL,
     attester TEXT NOT NULL, registry_tx TEXT, issued_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS attestations_subject ON attestations(subject, issued_at)`,
  `CREATE TABLE IF NOT EXISTS screenings (
     id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, client_id TEXT, score INTEGER NOT NULL, tier TEXT NOT NULL,
     reason_codes TEXT NOT NULL, decision_id TEXT NOT NULL, payer TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS watches (
     id TEXT PRIMARY KEY, address TEXT NOT NULL, webhook_url TEXT NOT NULL, client_id TEXT, payee_book TEXT,
     last_tier TEXT, next_rescreen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS watches_addr_client ON watches(address, client_id)`,
  `CREATE TABLE IF NOT EXISTS payments (
     id INTEGER PRIMARY KEY AUTOINCREMENT, tx_hash TEXT, payer TEXT NOT NULL, amount_usdc REAL NOT NULL,
     endpoint TEXT NOT NULL, refunded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS edd_requests (
     id TEXT PRIMARY KEY, subject TEXT NOT NULL, decision_id TEXT NOT NULL, questions TEXT NOT NULL,
     response TEXT, status TEXT NOT NULL DEFAULT 'OPEN', created_at INTEGER NOT NULL, answered_at INTEGER)`,
];

export function migrate(): Promise<void> {
  if (!migrated) migrated = (async () => { for (const s of SCHEMA) await db().execute(s); })();
  return migrated;
}

/** test helper */
export function __resetDb() { client = null; migrated = null; }
