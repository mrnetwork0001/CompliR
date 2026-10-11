/**
 * GET /api/v1/feed?limit=25 — anonymised recent screenings for the live feed (traction proof). Free.
 */
import { recentScreenings } from "@/lib/store";
import { handle, ok } from "../../_lib/respond";
import { parseLimit } from "../../_lib/parse";
import type { FeedResponse } from "../../_lib/public-types";

export const GET = handle(async (req: Request) => {
  const limit = parseLimit(new URL(req.url), { def: 25, max: 100 });
  const items = await recentScreenings(limit);
  const body: FeedResponse = { items, limit, source: "store" };
  return ok(body);
});
