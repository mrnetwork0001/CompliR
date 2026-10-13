/**
 * POST|GET /api/internal/tips — one Tip Market tick (verify SUBMITTED tips, pay VERIFIED ones) for Vercel Cron / an
 * external scheduler / the "Run verifier now" button. Protected by `Authorization: Bearer $CRON_SECRET`.
 *
 * Human review override: POST with JSON `{ "review": "tip_…", "decision": "VERIFIED" | "REJECTED", "note"?: "…" }`
 * settles a NEEDS_REVIEW (or any undecided) tip by hand; VERIFIED pays immediately (daily cap permitting).
 */
import { config } from "@/lib/config";
import { ReviewSchema, reviewTip, runTipsOnce } from "@/lib/tips";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  if (config().COMPLIR_PAUSED) return Response.json({ error: { code: "SERVICE_PAUSED", message: "paused" } }, { status: 503 });
  try {
    let body: unknown = null;
    if (req.method === "POST") {
      try { const text = await req.text(); body = text.trim() ? JSON.parse(text) : null; } catch { body = null; }
    }
    if (body && typeof body === "object" && "review" in (body as Record<string, unknown>)) {
      const parsed = ReviewSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: { code: "VALIDATION_ERROR", message: "expected { review: tip_id, decision: VERIFIED|REJECTED, note? }", details: parsed.error.issues } }, { status: 400 });
      const out = await reviewTip(parsed.data.review, parsed.data.decision, parsed.data.note);
      if (!out) return Response.json({ error: { code: "NOT_FOUND", message: `No tip ${parsed.data.review}` } }, { status: 404 });
      return Response.json({ review: out });
    }
    return Response.json(await runTipsOnce());
  } catch (e) {
    console.error("[tips] tick failed:", e);
    return Response.json({ error: { code: "INTERNAL_ERROR", message: (e as Error)?.message ?? String(e) } }, { status: 500 });
  }
}
export const GET = POST; // Vercel Cron uses GET
