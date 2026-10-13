/**
 * POST /api/v1/pay - create a payment link. Free, same-origin (or non-browser) only.
 * Body: { merchant, to, amountUsdc, memo?, expiresInHours=72 }
 * Response: { id, url, merchantKey, merchantUrl, link } - the merchantKey is shown once; keep it.
 */
import { CreatePayLinkSchema, createPayLink, toMerchant } from "@/lib/paylinks";
import { handle, ok } from "../../_lib/respond";
import { parseJson } from "../../_lib/parse";
import { assertNotCrossSite } from "./_lib";

export const POST = handle(async (req) => {
  assertNotCrossSite(req);
  const body = await parseJson(req, CreatePayLinkSchema);
  const l = await createPayLink(body);
  const view = toMerchant(l);
  return ok({ id: l.id, url: view.url, merchantKey: l.merchantKey, merchantUrl: view.merchantUrl, link: view }, { status: 201 });
});
