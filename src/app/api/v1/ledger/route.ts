/**
 * GET /api/v1/ledger?limit=50 — most recent decision-log entries. Free.
 */
import { listDecisions } from "@/lib/ledger";
import { countDecisions } from "@/lib/store";
import { handle, ok } from "../../_lib/respond";
import { parseLimit, parsePage } from "../../_lib/parse";
import type { LedgerListResponse } from "../../_lib/public-types";

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const limit = parseLimit(url, { def: 20, max: 200 });
  const page = parsePage(url);
  const [entries, total] = await Promise.all([listDecisions({ limit, offset: (page - 1) * limit }), countDecisions()]);
  const body: LedgerListResponse = { entries, limit, page, total, pages: Math.max(1, Math.ceil(total / limit)) };
  return ok(body);
});
