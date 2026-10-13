/**
 * POST /api/internal/treasury - one treasury-agent tick (Vercel Cron / external scheduler / the "Run agent now" button).
 * Protected by `Authorization: Bearer $CRON_SECRET`. Returns the TickResult {mode, processed, paid, limited, held, failed, results}.
 */
import { runTreasuryOnce } from "@/lib/treasury";
import { config } from "@/lib/config";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  if (config().COMPLIR_PAUSED) return Response.json({ error: { code: "SERVICE_PAUSED", message: "paused" } }, { status: 503 });
  try {
    return Response.json(await runTreasuryOnce());
  } catch (e) {
    console.error("[treasury] tick failed:", e);
    return Response.json({ error: { code: "INTERNAL_ERROR", message: (e as Error)?.message ?? String(e) } }, { status: 500 });
  }
}
export const GET = POST; // Vercel Cron uses GET
