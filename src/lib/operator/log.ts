/**
 * Read side of the operator's ledger entries (kind = "OPERATOR"). The generic ledger listing has no kind filter,
 * so this reads the `decisions` table directly with the same row shape.
 */
import { db, migrate } from "../store/db";
import type { Address, DecisionLogEntry } from "../types";

function rowToDecision(r: Record<string, unknown>): DecisionLogEntry {
  const str = (v: unknown) => (v == null ? null : String(v));
  return {
    id: String(r.id), seq: Number(r.seq), kind: r.kind as DecisionLogEntry["kind"], subject: str(r.subject) as Address | null, clientId: str(r.client_id),
    payload: JSON.parse(String(r.payload)), prevHash: String(r.prev_hash) as `0x${string}`, hash: String(r.hash) as `0x${string}`,
    createdAt: Number(r.created_at), anchorTx: str(r.anchor_tx) as `0x${string}` | null,
  };
}

/** Most recent OPERATOR entries, newest first. Never throws (DB failure → []). */
export async function recentOperatorDecisions(limit = 10): Promise<DecisionLogEntry[]> {
  try {
    await migrate();
    const r = await db().execute({ sql: `SELECT * FROM decisions WHERE kind = 'OPERATOR' ORDER BY seq DESC LIMIT ?`, args: [Math.min(Math.max(limit, 1), 100)] });
    return r.rows.map((x) => rowToDecision(x as Record<string, unknown>));
  } catch (e) {
    console.warn("[operator/log] read failed:", (e as Error)?.message ?? e);
    return [];
  }
}
