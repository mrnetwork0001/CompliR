/**
 * GET /api/v1/decision/:id - one hash-chained decision-log entry (replayable). Free. Spec §2.7.
 */
import { getDecision } from "@/lib/ledger";
import { registryTxForDecisions } from "@/lib/store";
import { ApiError, handle, ok } from "../../../_lib/respond";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    throw new ApiError("VALIDATION_ERROR", "Invalid decision id", { issues: [{ path: "path.id", message: "expected dec_<ulid>" }] });
  }
  const entry = await getDecision(id);
  if (!entry) throw new ApiError("NOT_FOUND", `No decision ${id}`);
  const tx = (await registryTxForDecisions([entry.id]))[entry.id] ?? null;
  return ok({ ...entry, registryTx: tx }); // attached, not part of the hashed payload
});
