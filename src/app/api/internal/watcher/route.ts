/**
 * POST /api/internal/watcher - one watcher tick (for Vercel Cron / external scheduler).
 * Protected by `Authorization: Bearer $CRON_SECRET`. Returns {checked, changed, failed}.
 */
import { runWatcherOnce } from "@/lib/watcher";
import { config } from "@/lib/config";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  if (config().COMPLIR_PAUSED) return Response.json({ error: { code: "SERVICE_PAUSED", message: "paused" } }, { status: 503 });
  return Response.json(await runWatcherOnce());
}
export const GET = POST; // Vercel Cron uses GET
