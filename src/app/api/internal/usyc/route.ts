/**
 * POST|GET /api/internal/usyc — one USYC sweep tick (Vercel Cron / external scheduler).
 * Protected by `Authorization: Bearer $CRON_SECRET`. Dry-run by default; see docs/USYC.md.
 */
import { runSweepOnce } from "@/lib/usyc";
import { config } from "@/lib/config";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  if (config().COMPLIR_PAUSED) return Response.json({ error: { code: "SERVICE_PAUSED", message: "paused" } }, { status: 503 });
  return Response.json(await runSweepOnce());
}
export const GET = POST; // Vercel Cron uses GET
