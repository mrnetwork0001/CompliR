/**
 * POST /api/internal/operator - one operator tick (Vercel Cron / external scheduler / worker/operator.ts fallback).
 * Protected by `Authorization: Bearer $CRON_SECRET`. Returns {entryId, seq, chosen, rationale, nextCheckAt, meta}.
 */
import { runOperatorOnce } from "@/lib/operator";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  try {
    const t = await runOperatorOnce();
    return Response.json({
      entryId: t.entry.id, seq: t.entry.seq, hash: t.entry.hash,
      chosen: t.results.map((r) => ({ type: r.action.type, params: r.action.params, ok: r.ok, error: r.error ?? null })),
      candidates: t.plan.candidates.map((c) => c.type), rejected: t.plan.rejected,
      rationale: t.plan.rationale, nextCheckAt: new Date(t.nextCheckAt * 1000).toISOString(), meta: t.plan.meta, errors: t.snapshot.errors,
    });
  } catch (e) {
    console.error("[operator] tick failed:", e);
    return Response.json({ error: { code: "INTERNAL_ERROR", message: (e as Error)?.message ?? String(e) } }, { status: 500 });
  }
}
export const GET = POST; // Vercel Cron uses GET
