/**
 * GET /api/v1/guarantee/:decisionId - the bond attached to a LOW verdict: amount, expiry, status, claim (if any). Free.
 */
import { getGuarantee, toPublicGuarantee } from "@/lib/guarantee";
import { ApiError, handle, ok } from "../../../_lib/respond";

type Ctx = { params: Promise<{ decisionId: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { decisionId } = await params;
  if (!/^dec_[0-9A-Za-z]{6,64}$/.test(decisionId)) throw new ApiError("VALIDATION_ERROR", "Invalid decision id", { issues: [{ path: "path.decisionId", message: "expected dec_<id>" }] });
  const g = await getGuarantee(decisionId);
  if (!g) throw new ApiError("NOT_FOUND", `No guarantee for decision ${decisionId}`);
  return ok(toPublicGuarantee(g));
});
