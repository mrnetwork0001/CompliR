/**
 * POST|GET /api/internal/usyc - one revenue-yield tick (Vercel Cron / external scheduler). Path kept for existing
 * cron configs; it now dispatches to Circle Earn (Morpho USDC vaults on Arc) unless YIELD_BACKEND=usyc.
 * Protected by `Authorization: Bearer $CRON_SECRET`. Dry-run unless YIELD_MODE=live; see docs/YIELD.md.
 */
import { runRevenueYieldOnce } from "@/lib/earn";
import { config } from "@/lib/config";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  if (config().COMPLIR_PAUSED) return Response.json({ error: { code: "SERVICE_PAUSED", message: "paused" } }, { status: 503 });
  return Response.json(await runRevenueYieldOnce());
}
export const GET = POST; // Vercel Cron uses GET
