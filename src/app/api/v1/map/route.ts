/**
 * GET /api/v1/map?limit=150 - Trust Map snapshot (nodes, edges among them, header stats). Free.
 * Served from the store with a 10 s in-process cache (+ Cache-Control max-age=10) so the auto-refreshing
 * page and curious judges never hammer sqlite.
 */
import { mapSnapshot } from "@/lib/trustmap/query";
import type { MapSnapshot } from "@/lib/trustmap/types";
import { handle, ok } from "../../_lib/respond";
import { parseLimit } from "../../_lib/parse";

const TTL_MS = 10_000;
const cache = new Map<number, { at: number; body: MapSnapshot }>();

export const GET = handle(async (req: Request) => {
  const limit = parseLimit(new URL(req.url), { def: 150, max: 400 });
  const hit = cache.get(limit);
  const now = Date.now();
  let body: MapSnapshot;
  if (hit && now - hit.at < TTL_MS) body = hit.body;
  else {
    body = await mapSnapshot({ limit });
    cache.set(limit, { at: now, body });
  }
  return ok(body, { headers: { "Cache-Control": "public, max-age=10, s-maxage=10, stale-while-revalidate=20" } });
});
