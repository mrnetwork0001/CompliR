/** GET /api/v1/map/changes?limit=25 — most recent tier changes seen by the Trust Map tailer. Free. */
import { recentTierChanges } from "@/lib/trustmap/query";
import { handle, ok } from "../../../_lib/respond";
import { parseLimit } from "../../../_lib/parse";

export const GET = handle(async (req: Request) => {
  const limit = parseLimit(new URL(req.url), { def: 25, max: 200 });
  const items = await recentTierChanges(limit);
  return ok({ items, limit }, { headers: { "Cache-Control": "public, max-age=10" } });
});
