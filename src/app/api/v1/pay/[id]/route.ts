/**
 * GET /api/v1/pay/:id - public view of a payment link (status, payer tier, payment URI when payable).
 * GET /api/v1/pay/:id?key=<merchantKey> - merchant view (adds payer score + merchantUrl).
 */
import { getPayLink, toMerchant, toPublic } from "@/lib/paylinks";
import { ApiError, handle, ok } from "../../../_lib/respond";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const l = await getPayLink(id);
  if (!l) throw new ApiError("NOT_FOUND", `No payment link ${id}`);
  const key = new URL(req.url).searchParams.get("key");
  if (key) {
    if (key !== l.merchantKey) throw new ApiError("FORBIDDEN", "Merchant key does not match.");
    return ok(toMerchant(l));
  }
  return ok(toPublic(l));
});
