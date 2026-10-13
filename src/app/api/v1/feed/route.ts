/**
 * GET /api/v1/feed?limit=25 - anonymised recent screenings for the live feed (traction proof). Free.
 */
import { recentScreenings, countScreenings } from "@/lib/store";
import { handle, ok } from "../../_lib/respond";
import { parseLimit, parsePage } from "../../_lib/parse";
import type { FeedResponse } from "../../_lib/public-types";

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const limit = parseLimit(url, { def: 20, max: 100 });
  const page = parsePage(url);
  const [items, total] = await Promise.all([recentScreenings(limit, (page - 1) * limit), countScreenings()]);
  const body: FeedResponse = { items, limit, page, total, pages: Math.max(1, Math.ceil(total / limit)), source: "store" };
  return ok(body);
});
