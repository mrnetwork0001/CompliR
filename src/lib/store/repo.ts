import { db, migrate } from "./db";
import { config } from "../config";
import type { Address, Attestation, DecisionLogEntry, PayeeBookEntry, ReasonCode, Tier, Verdict, Watch } from "../types";

const now = () => Math.floor(Date.now() / 1000);
const iso = (unix: number) => new Date(unix * 1000).toISOString();
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => Number(v ?? 0);

export function maskAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Our own wallets, excluded from traction counts. Comma-separated env OWN_WALLETS. */
export function ownWallets(): Set<string> {
  return new Set((process.env.OWN_WALLETS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}
export type PayerKind = "own" | "outside" | "unknown";
/** Internal callers (our own UI, workers, demos) are never counted as outside usage. */
export const INTERNAL_CLIENT_IDS = new Set(["web-explorer", "trustmap", "treasury-agent", "edd", "watcher", "smoke", "shadow", "events", "tips", "operator", "report"]);
export function classifyPayer(payer: string | null | undefined): PayerKind {
  if (!payer) return "unknown";
  const p = payer.toLowerCase();
  if (INTERNAL_CLIENT_IDS.has(p) || ownWallets().has(p)) return "own";
  return "outside";
}

// ── decisions ────────────────────────────────────────────────────────────────
export async function insertDecision(e: DecisionLogEntry): Promise<void> {
  await migrate();
  await db().execute({
    sql: `INSERT INTO decisions (id, seq, kind, subject, client_id, payload, prev_hash, hash, created_at, anchor_tx)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [e.id, e.seq, e.kind, e.subject, e.clientId, JSON.stringify(e.payload), e.prevHash, e.hash, e.createdAt, e.anchorTx],
  });
}
function rowToDecision(r: Record<string, unknown>): DecisionLogEntry {
  return {
    id: String(r.id), seq: num(r.seq), kind: r.kind as DecisionLogEntry["kind"],
    subject: (str(r.subject) as Address | null), clientId: str(r.client_id),
    payload: JSON.parse(String(r.payload)), prevHash: String(r.prev_hash) as `0x${string}`,
    hash: String(r.hash) as `0x${string}`, createdAt: num(r.created_at), anchorTx: str(r.anchor_tx) as `0x${string}` | null,
  };
}
export async function lastDecision(): Promise<DecisionLogEntry | null> {
  await migrate();
  const r = await db().execute(`SELECT * FROM decisions ORDER BY seq DESC LIMIT 1`);
  return r.rows[0] ? rowToDecision(r.rows[0] as Record<string, unknown>) : null;
}
export async function getDecisionRow(id: string): Promise<DecisionLogEntry | null> {
  await migrate();
  const r = await db().execute({ sql: `SELECT * FROM decisions WHERE id = ?`, args: [id] });
  return r.rows[0] ? rowToDecision(r.rows[0] as Record<string, unknown>) : null;
}
export async function listDecisionRows(opts: { limit?: number; before?: number; subject?: string; offset?: number } = {}): Promise<DecisionLogEntry[]> {
  await migrate();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where: string[] = []; const args: (string | number)[] = [];
  if (opts.before != null) { where.push("seq < ?"); args.push(opts.before); }
  if (opts.subject) { where.push("subject = ?"); args.push(opts.subject.toLowerCase()); }
  const sql = `SELECT * FROM decisions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ? OFFSET ?`;
  const r = await db().execute({ sql, args: [...args, limit, offset] });
  return r.rows.map((x) => rowToDecision(x as Record<string, unknown>));
}
export async function countDecisions(subject?: string): Promise<number> {
  await migrate();
  const r = subject
    ? await db().execute({ sql: `SELECT COUNT(*) AS n FROM decisions WHERE subject = ?`, args: [subject.toLowerCase()] })
    : await db().execute(`SELECT COUNT(*) AS n FROM decisions`);
  return num((r.rows[0] as Record<string, unknown>).n);
}
export async function decisionsInRange(fromSeq: number, toSeq: number): Promise<DecisionLogEntry[]> {
  await migrate();
  const r = await db().execute({ sql: `SELECT * FROM decisions WHERE seq >= ? AND seq <= ? ORDER BY seq ASC`, args: [fromSeq, toSeq] });
  return r.rows.map((x) => rowToDecision(x as Record<string, unknown>));
}
export async function unanchoredDecisions(): Promise<DecisionLogEntry[]> {
  await migrate();
  const r = await db().execute(`SELECT * FROM decisions WHERE anchor_tx IS NULL AND kind != 'ANCHOR' ORDER BY seq ASC`);
  return r.rows.map((x) => rowToDecision(x as Record<string, unknown>));
}
export async function markAnchored(fromSeq: number, toSeq: number, tx: string): Promise<void> {
  await db().execute({ sql: `UPDATE decisions SET anchor_tx = ? WHERE seq >= ? AND seq <= ? AND anchor_tx IS NULL`, args: [tx, fromSeq, toSeq] });
}

// ── attestations ─────────────────────────────────────────────────────────────
export async function insertAttestation(v: Verdict): Promise<void> {
  await migrate();
  const a = v.attestation;
  await db().execute({
    sql: `INSERT INTO attestations (subject, tier, score, decision_id, valid_until, signature, typed_data, attester, registry_tx, issued_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [v.address, v.tier, v.score, v.decisionId, a.validUntil, a.signature, JSON.stringify(a.typedData), a.attester, a.registryTx, a.typedData.message.issuedAt],
  });
}
/** registry tx hashes keyed by decision id (the ledger payload is immutable; the mirror lands later). */
export async function registryTxForDecisions(ids: string[]): Promise<Record<string, string>> {
  await migrate();
  if (ids.length === 0) return {};
  const r = await db().execute({ sql: `SELECT decision_id, registry_tx FROM attestations WHERE registry_tx IS NOT NULL AND decision_id IN (${ids.map(() => "?").join(",")})`, args: ids });
  const out: Record<string, string> = {};
  for (const x of r.rows as unknown as Record<string, unknown>[]) out[String(x.decision_id)] = String(x.registry_tx);
  return out;
}
export async function setRegistryTx(decisionId: string, tx: string): Promise<void> {
  await db().execute({ sql: `UPDATE attestations SET registry_tx = ? WHERE decision_id = ?`, args: [tx, decisionId] });
}
export interface AttestationView { address: Address; score: number; tier: Tier; attestation: Attestation; decisionId: string; screenedAt: string }
export async function latestAttestation(address: string): Promise<AttestationView | null> {
  await migrate();
  const r = await db().execute({ sql: `SELECT * FROM attestations WHERE subject = ? ORDER BY issued_at DESC LIMIT 1`, args: [address.toLowerCase()] });
  const x = r.rows[0] as Record<string, unknown> | undefined;
  if (!x) return null;
  return {
    address: String(x.subject) as Address, score: num(x.score), tier: x.tier as Tier, decisionId: String(x.decision_id),
    screenedAt: iso(num(x.issued_at)),
    attestation: {
      typedData: JSON.parse(String(x.typed_data)), signature: String(x.signature) as `0x${string}`,
      attester: String(x.attester) as Address, validUntil: num(x.valid_until), registryTx: str(x.registry_tx) as `0x${string}` | null,
    },
  };
}
export async function priorTier(address: string, withinSeconds: number): Promise<{ tier: Tier; at: number } | null> {
  await migrate();
  const r = await db().execute({
    sql: `SELECT tier, issued_at FROM attestations WHERE subject = ? AND issued_at >= ? ORDER BY issued_at DESC LIMIT 1`,
    args: [address.toLowerCase(), now() - withinSeconds],
  });
  const x = r.rows[0] as Record<string, unknown> | undefined;
  return x ? { tier: x.tier as Tier, at: num(x.issued_at) } : null;
}

// ── screenings (public feed) ─────────────────────────────────────────────────
export async function recordScreening(v: Verdict, clientId: string | null, payer: PayerKind): Promise<void> {
  await migrate();
  await db().execute({
    sql: `INSERT INTO screenings (subject, client_id, score, tier, reason_codes, decision_id, payer, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    args: [v.address, clientId, v.score, v.tier, JSON.stringify(v.reasons.map((r) => r.code)), v.decisionId, payer, now()],
  });
}
export interface FeedItem { decisionId: string; addressMasked: string; tier: Tier; score: number; reasonCodes: ReasonCode[]; screenedAt: string; payer: PayerKind }
export async function countScreenings(): Promise<number> {
  await migrate();
  const r = await db().execute(`SELECT COUNT(*) AS n FROM screenings`);
  return num((r.rows[0] as Record<string, unknown>).n);
}
export async function recentScreenings(limit = 25, offset = 0): Promise<FeedItem[]> {
  await migrate();
  const r = await db().execute({ sql: `SELECT * FROM screenings ORDER BY id DESC LIMIT ? OFFSET ?`, args: [Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)] });
  return r.rows.map((x0) => { const x = x0 as Record<string, unknown>; return {
    decisionId: String(x.decision_id), addressMasked: maskAddress(String(x.subject)), tier: x.tier as Tier, score: num(x.score),
    reasonCodes: JSON.parse(String(x.reason_codes)), screenedAt: iso(num(x.created_at)), payer: x.payer as PayerKind,
  }; });
}

// ── watches ──────────────────────────────────────────────────────────────────
function rowToWatch(x: Record<string, unknown>): Watch {
  return { id: String(x.id), address: String(x.address) as Address, webhookUrl: String(x.webhook_url), clientId: str(x.client_id),
    lastTier: (str(x.last_tier) as Tier | null), nextRescreenAt: num(x.next_rescreen_at), expiresAt: num(x.expires_at), createdAt: num(x.created_at) };
}
export async function upsertWatch(input: { address: string; webhookUrl: string; clientId: string | null; payeeBook?: PayeeBookEntry[]; days?: number }): Promise<Watch> {
  await migrate();
  const t = now(); const id = `wat_${t.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const addr = input.address.toLowerCase();
  await db().execute({
    sql: `INSERT INTO watches (id, address, webhook_url, client_id, payee_book, last_tier, next_rescreen_at, expires_at, created_at)
          VALUES (?,?,?,?,?,NULL,?,?,?)
          ON CONFLICT(address, client_id) DO UPDATE SET webhook_url = excluded.webhook_url, payee_book = excluded.payee_book,
            expires_at = excluded.expires_at, next_rescreen_at = MIN(watches.next_rescreen_at, excluded.next_rescreen_at)`,
    args: [id, addr, input.webhookUrl, input.clientId, input.payeeBook ? JSON.stringify(input.payeeBook) : null, t, t + (input.days ?? 30) * 86400, t],
  });
  const r = await db().execute({ sql: `SELECT * FROM watches WHERE address = ? AND client_id IS ?`, args: [addr, input.clientId] });
  return rowToWatch(r.rows[0] as Record<string, unknown>);
}
export async function dueWatches(at = now()): Promise<(Watch & { payeeBook: PayeeBookEntry[] | null })[]> {
  await migrate();
  const r = await db().execute({ sql: `SELECT * FROM watches WHERE next_rescreen_at <= ? AND expires_at > ? ORDER BY next_rescreen_at ASC LIMIT 100`, args: [at, at] });
  return r.rows.map((x0) => { const x = x0 as Record<string, unknown>; return { ...rowToWatch(x), payeeBook: x.payee_book ? JSON.parse(String(x.payee_book)) : null }; });
}
export async function updateWatchAfterRescreen(id: string, tier: Tier, nextRescreenAt: number): Promise<void> {
  await db().execute({ sql: `UPDATE watches SET last_tier = ?, next_rescreen_at = ? WHERE id = ?`, args: [tier, nextRescreenAt, id] });
}

// ── payments & stats ─────────────────────────────────────────────────────────
export async function recordPayment(p: { txHash: string | null; payer: string; amountUsdc: number; endpoint: string }): Promise<void> {
  await migrate();
  await db().execute({ sql: `INSERT INTO payments (tx_hash, payer, amount_usdc, endpoint, created_at) VALUES (?,?,?,?,?)`,
    args: [p.txHash, p.payer.toLowerCase(), p.amountUsdc, p.endpoint, now()] });
}
export interface PublicStats { screenings: number; distinctClients: number; outsidePayers: number; totalPaidUsdc: number; refunds: number; watchesActive: number; since: string; ownWalletsExcluded: true }
export async function publicStats(): Promise<PublicStats> {
  await migrate();
  const own = [...ownWallets()];
  const notOwn = own.length ? `AND payer NOT IN (${own.map(() => "?").join(",")})` : "";
  const d = db();
  const [s, c, p, w, first] = await Promise.all([
    d.execute(`SELECT COUNT(*) AS n FROM screenings WHERE payer != 'own'`),
    d.execute(`SELECT COUNT(DISTINCT client_id) AS n FROM screenings WHERE client_id IS NOT NULL AND payer != 'own'`),
    d.execute({ sql: `SELECT COUNT(DISTINCT payer) AS payers, COALESCE(SUM(CASE WHEN refunded=0 THEN amount_usdc ELSE 0 END),0) AS paid,
                      COALESCE(SUM(refunded),0) AS refunds FROM payments WHERE 1=1 ${notOwn}`, args: own }),
    d.execute({ sql: `SELECT COUNT(*) AS n FROM watches WHERE expires_at > ?`, args: [now()] }),
    d.execute(`SELECT MIN(created_at) AS t FROM screenings`),
  ]);
  const pr = p.rows[0] as Record<string, unknown>;
  const t = (first.rows[0] as Record<string, unknown>).t;
  return {
    screenings: num((s.rows[0] as Record<string, unknown>).n), distinctClients: num((c.rows[0] as Record<string, unknown>).n),
    outsidePayers: num(pr.payers), totalPaidUsdc: Number(num(pr.paid).toFixed(6)), refunds: num(pr.refunds),
    watchesActive: num((w.rows[0] as Record<string, unknown>).n), since: t ? iso(num(t)) : iso(now()), ownWalletsExcluded: true,
  };
}
// keep config import used (DATABASE_URL already read in db.ts); re-export for convenience
export const storeConfig = () => ({ databaseUrl: config().DATABASE_URL });
