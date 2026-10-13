/** GET /api/v1/map/:address - one Trust Map node with its tier-change history and edges. 404 if not graded. Free. */
import { nodeHistory } from "@/lib/trustmap/query";
import { ApiError, handle, ok } from "../../../_lib/respond";
import { parseAddress } from "../../../_lib/parse";

type Ctx = { params: Promise<{ address: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { address: raw } = await params;
  const address = parseAddress(raw, "path.address");
  const h = await nodeHistory(address);
  if (!h) throw new ApiError("NOT_FOUND", "address is not on the Trust Map (not graded by the tailer yet)");
  return ok(h);
});
