/**
 * POST /api/internal/trustmap - one Trust Map tailer tick (Vercel Cron / external scheduler / the /map "run one
 * tick" dev button). Protected by `Authorization: Bearer $CRON_SECRET`, same pattern as /api/internal/watcher.
 * Returns the TailResult (blocks scanned, recipients, graded nodes, rpc calls, partial/rateLimited flags).
 */
import { tailOnce } from "@/lib/trustmap/tailer";
import { config } from "@/lib/config";

export const maxDuration = 120;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  if (config().COMPLIR_PAUSED) return Response.json({ error: { code: "SERVICE_PAUSED", message: "paused" } }, { status: 503 });
  try {
    return Response.json(await tailOnce());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[trustmap] tick failed:", e);
    return Response.json({ error: { code: "INTERNAL_ERROR", message } }, { status: 500 });
  }
}
export const GET = POST; // Vercel Cron uses GET
