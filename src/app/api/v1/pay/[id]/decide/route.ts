/**
 * POST /api/v1/pay/:id/decide - merchant accepts or declines a SCREENED link.
 * Body: { key: merchantKey, action: "accept" | "decline" } → merchant view.
 */
import { DecideSchema, decidePayLink, toMerchant } from "@/lib/paylinks";
import { handle, ok } from "../../../../_lib/respond";
import { parseJson } from "../../../../_lib/parse";
import { assertNotCrossSite, rethrow } from "../../_lib";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle<Ctx>(async (req, { params }) => {
  assertNotCrossSite(req);
  const { id } = await params;
  const body = await parseJson(req, DecideSchema);
  const l = await decidePayLink(id, body.key, body.action).catch(rethrow);
  return ok(toMerchant(l));
});
