/**
 * GET /api/v1/ledger?limit=50 — most recent decision-log entries. Free.
 */
import { listDecisions } from "@/lib/ledger";
import { handle, ok } from "../../_lib/respond";
import { parseLimit } from "../../_lib/parse";
import type { LedgerListResponse } from "../../_lib/public-types";

export const GET = handle(async (req: Request) => {
  const limit = parseLimit(new URL(req.url), { def: 50, max: 200 });
  const entries = await listDecisions({ limit });
  const body: LedgerListResponse = { entries, limit };
  return ok(body);
});
