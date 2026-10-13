/**
 * POST|GET /api/internal/cctp - one CCTP inbound-screening tick (src/lib/cctp/tailer.ts) + an incremental ERC-8004
 * agent-index sync (src/lib/erc8004/indexer.ts), for Vercel Cron / an external scheduler.
 * Protected by `Authorization: Bearer $CRON_SECRET`.
 */
import { config } from "@/lib/config";
import { tailCctpOnce } from "@/lib/cctp/tailer";
import { syncAgentIndex } from "@/lib/erc8004/indexer";

export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  if (config().COMPLIR_PAUSED) return Response.json({ error: { code: "SERVICE_PAUSED", message: "paused" } }, { status: 503 });
  try {
    const [cctp, erc8004] = await Promise.all([
      tailCctpOnce(),
      syncAgentIndex().catch((e) => ({ error: (e as Error)?.message ?? String(e) })),
    ]);
    return Response.json({ cctp, erc8004 });
  } catch (e) {
    console.error("[cctp] tick failed:", e);
    return Response.json({ error: { code: "INTERNAL_ERROR", message: (e as Error)?.message ?? String(e) } }, { status: 500 });
  }
}
export const GET = POST; // Vercel Cron uses GET
