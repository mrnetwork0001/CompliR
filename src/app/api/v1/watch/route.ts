/**
 * POST /api/v1/watch — register address + webhook for adaptive re-screening. Spec §2.1 (0.05 USDC / 30 days).
 * Body: WatchRequest (src/lib/types). Response: Watch (200). Re-registering the same address+client upserts.
 */
import { WatchRequestSchema } from "@/lib/types";
import { upsertWatch } from "@/lib/store";
import { config } from "@/lib/config";
import { ApiError, handle, ok } from "../../_lib/respond";
import { parseJson } from "../../_lib/parse";
import { withX402 } from "@/lib/pay";
import { ensurePaymentSink, isSameOriginBrowser } from "@/lib/payments";
import { currentPrice } from "@/lib/operator/pricing";

async function watchHandler(req: Request): Promise<Response> {
  if (config().COMPLIR_PAUSED) {
    throw new ApiError("SERVICE_PAUSED", "CompliR is paused for maintenance. No charge was made.");
  }
  const body = await parseJson(req, WatchRequestSchema);
  const watch = await upsertWatch({
    address: body.address,
    webhookUrl: body.webhookUrl,
    clientId: body.clientId ?? null,
    payeeBook: body.payeeBook,
  });
  return ok(watch, { headers: { "X-CompliR-Watch-Id": watch.id } });
}

ensurePaymentSink();
const free = handle(watchHandler);
const paidOpts = { description: "CompliR watch: 30 days of re-screening", resource: "/api/v1/watch" };
/** Price is operator-set (default PRICE_WATCH_USDC), read per request. */
export const POST = async (req: Request, ctx: unknown) => (isSameOriginBrowser(req) ? free : withX402(free, { ...paidOpts, priceUsdc: await currentPrice("watch") }))(req, ctx);
