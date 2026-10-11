/**
 * POST /api/v1/shadow — "what we would have held that you paid". Free during the event. Spec §2.1.
 * Body: { payeeBook: PayeeBookEntry[], recentPayments?: { to, amountUsdc, txHash? }[] }.
 * Screens every unique address (max 50, 4 in flight, depth 1) and joins with recentPayments.
 */
import { screen } from "@/lib/pipeline";
import { config } from "@/lib/config";
import { ApiError, handle, ok } from "../../_lib/respond";
import { parseJson } from "../../_lib/parse";
import { ShadowRequestSchema, runShadow } from "../../_lib/shadow";

export const POST = handle(async (req) => {
  if (config().COMPLIR_PAUSED) {
    throw new ApiError("SERVICE_PAUSED", "CompliR is paused for maintenance.");
  }
  const body = await parseJson(req, ShadowRequestSchema);
  const result = await runShadow(body, screen);
  return ok(result);
});
