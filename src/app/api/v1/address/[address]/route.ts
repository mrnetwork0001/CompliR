/**
 * GET /api/v1/address/:address - public history of every verdict CompliR issued for one address. Free, anonymised:
 * requesters appear as a class (own / outside / unknown), never as a client id. Never runs the pipeline.
 */
import type { Address } from "@/lib/types";
import { addressHistory } from "@/lib/check/history";
import { handle, ok } from "../../../_lib/respond";
import { parseAddress, parseLimit } from "../../../_lib/parse";

type Ctx = { params: Promise<{ address: string }> };

export const GET = handle<Ctx>(async (req, { params }) => {
  const { address: raw } = await params;
  const address = parseAddress(raw, "path.address") as Address;
  const limit = parseLimit(new URL(req.url), { def: 200, max: 1000 });
  return ok(await addressHistory(address, { limit }), { headers: { "Cache-Control": "public, max-age=15" } });
});
