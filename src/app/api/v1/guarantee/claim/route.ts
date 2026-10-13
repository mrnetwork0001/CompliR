/**
 * POST /api/v1/guarantee/claim { decisionId, payerAddress } - claim the bond on a LOW verdict.
 * Valid iff the guarantee is ACTIVE and unexpired, the claimant is the payer of the original screen (or a same-origin
 * browser, for the demo) and a fresh re-screen grades the subject HIGH. Queues a refund of bondUsdc to payerAddress.
 * Free (the claimant already paid for the screen).
 */
import { z } from "zod";
import { claimGuarantee, GuaranteeError } from "@/lib/guarantee";
import { isSameOriginBrowser } from "@/lib/payments";
import { AddressSchema } from "@/lib/types";
import { ApiError, handle, ok } from "../../../_lib/respond";
import { parseJson } from "../../../_lib/parse";

const ClaimSchema = z.object({ decisionId: z.string().regex(/^dec_[0-9A-Za-z]{6,64}$/, "expected dec_<id>"), payerAddress: AddressSchema });

export const POST = handle(async (req: Request) => {
  const body = await parseJson(req, ClaimSchema);
  try {
    const r = await claimGuarantee({ decisionId: body.decisionId, payerAddress: body.payerAddress, sameOrigin: isSameOriginBrowser(req) });
    return ok(r);
  } catch (e) {
    if (e instanceof GuaranteeError) {
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "CLAIMANT_MISMATCH" ? 403 : e.code === "NOT_HIGH" || e.code === "EXPIRED" || e.code === "NOT_ACTIVE" ? 409 : 400;
      throw new ApiError(e.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_ERROR", e.message, { code: e.code, ...(e.details ? { details: e.details } : {}) }, status);
    }
    throw e;
  }
});
