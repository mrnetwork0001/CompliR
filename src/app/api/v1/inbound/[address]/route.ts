/** GET /api/v1/inbound/{address} - inbound CCTP mints to this Arc address that CompliR screened (public, free; sender masked). */
import { inboundFor } from "@/lib/cctp/store";
import { maskAddress } from "@/lib/store";
import { AddressSchema } from "@/lib/types";
import { ApiError, handle, ok } from "../../../_lib/respond";
import { toPublicInbound, type InboundHistoryResponse } from "../public";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ address: string }> }) => {
  const { address } = await ctx.params;
  const parsed = AddressSchema.safeParse(address);
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", "invalid EVM address");
  const rows = await inboundFor(parsed.data, 100);
  const body: InboundHistoryResponse = {
    address: parsed.data,
    items: rows.map((r) => toPublicInbound(r, maskAddress)),
    total: rows.length,
    flagged: rows.filter((r) => r.flagged).length,
    source: "store",
  };
  return ok(body);
});
