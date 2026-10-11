/**
 * GET /api/v1/edd/:id — public view of an EDD request: questions + status (+ re-screen outcome once answered).
 * Never returns the answers or the contact.
 */
import { getEddRequest, toPublicView } from "@/lib/edd";
import { ApiError, handle, ok } from "../../../_lib/respond";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  if (!/^edd_[0-9a-f]{8,64}$/.test(id)) throw new ApiError("VALIDATION_ERROR", "Invalid EDD id", { issues: [{ path: "path.id", message: "expected edd_<hex>" }] });
  const r = await getEddRequest(id);
  if (!r) throw new ApiError("NOT_FOUND", `No EDD request ${id}`);
  return ok(toPublicView(r));
});
