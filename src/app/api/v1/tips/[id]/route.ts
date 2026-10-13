/**
 * GET /api/v1/tips/:id - one tip, public projection (anonymised submitter, verdict tier/score/decision, payout). Free.
 */
import { getTip, toPublicTip } from "@/lib/tips";
import { ApiError, handle, ok } from "../../../_lib/respond";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  if (!/^tip_[a-z0-9]{1,40}$/.test(id)) {
    throw new ApiError("VALIDATION_ERROR", "Invalid tip id", { issues: [{ path: "path.id", message: "expected tip_<id>" }] });
  }
  const tip = await getTip(id);
  if (!tip) throw new ApiError("NOT_FOUND", `No tip ${id}`);
  return ok({ tip: toPublicTip(tip) });
});
