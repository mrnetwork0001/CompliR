/**
 * POST /api/v1/pay/:id/screen - the payer declares the wallet they will send from; CompliR screens it (clientId "pay").
 * Body: { from } → public link view. HIGH → DECLINED immediately; LOW → payment URI; MEDIUM → merchant review.
 */
import { ScreenPayerSchema, screenPayer, toPublic } from "@/lib/paylinks";
import { config } from "@/lib/config";
import { ApiError, handle, ok } from "../../../../_lib/respond";
import { parseJson } from "../../../../_lib/parse";
import { assertNotCrossSite, rethrow } from "../../_lib";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle<Ctx>(async (req, { params }) => {
  assertNotCrossSite(req);
  if (config().COMPLIR_PAUSED) throw new ApiError("SERVICE_PAUSED", "CompliR is paused for maintenance.");
  const { id } = await params;
  const body = await parseJson(req, ScreenPayerSchema);
  const l = await screenPayer(id, body.from).catch(rethrow);
  return ok(toPublic(l), { headers: { "X-CompliR-Decision-Id": l.payerDecisionId ?? "" } });
});
