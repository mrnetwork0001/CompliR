/**
 * GET /api/v1/map?limit=150&candidates=200 - Trust Map snapshot: graded nodes, observed-but-ungraded candidates, edges
 * among them, header stats. Free. Served from the store with a 10 s in-process cache (+ Cache-Control max-age=10) so
 * the auto-refreshing page and curious judges never hammer sqlite.
 */
import { cachedSnapshot } from "@/lib/trustmap/query";
import { handle, ok } from "../../_lib/respond";
import { parseLimit } from "../../_lib/parse";

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const limit = parseLimit(url, { def: 150, max: 400 });
  const raw = url.searchParams.get("candidates");
  const candidates = raw === null ? 200 : Math.min(500, Math.max(0, Number.parseInt(raw, 10) || 0));
  const body = await cachedSnapshot({ limit, candidates });
  return ok(body, { headers: { "Cache-Control": "public, max-age=10, s-maxage=10, stale-while-revalidate=20" } });
});
