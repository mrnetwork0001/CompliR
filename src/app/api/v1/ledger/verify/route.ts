/**
 * GET /api/v1/ledger/verify — re-walk the hash chain and report the first broken seq (if any). Free.
 */
import { verifyChain } from "@/lib/ledger";
import { handle, ok } from "../../../_lib/respond";
import type { LedgerVerifyResponse } from "../../../_lib/public-types";

export const GET = handle(async () => {
  const r = await verifyChain();
  const body: LedgerVerifyResponse = { ...r, checkedAt: new Date().toISOString() };
  return ok(body);
});
