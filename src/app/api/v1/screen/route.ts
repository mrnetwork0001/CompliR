/**
 * POST /api/v1/screen — full grade of one address. Spec §2.1 (0.01 USDC via x402).
 * Body: ScreenRequest (src/lib/types). Response: Verdict (200) + `X-CompliR-Decision-Id` header.
 */
import { ScreenRequestSchema } from "@/lib/types";
import { screen } from "@/lib/pipeline";
import { config } from "@/lib/config";
import { ApiError, handle, ok } from "../../_lib/respond";
import { parseJson } from "../../_lib/parse";
import { withX402 } from "@/lib/pay";
import { ensurePaymentSink, isSameOriginBrowser } from "@/lib/payments";
import { currentPrice } from "@/lib/operator/pricing";

async function screenHandler(req: Request): Promise<Response> {
  if (config().COMPLIR_PAUSED) {
    throw new ApiError("SERVICE_PAUSED", "CompliR is paused for maintenance. No charge was made.");
  }
  const body = await parseJson(req, ScreenRequestSchema);
  const verdict = await screen(body);
  return ok(verdict, { headers: { "X-CompliR-Decision-Id": verdict.decisionId } });
}

ensurePaymentSink();
const free = handle(screenHandler);
const paidOpts = { description: "CompliR screen: one address", resource: "/api/v1/screen" };
/** Hosted Explorer (same-origin browser) is free; API clients pay the operator-set price (default PRICE_SCREEN_USDC) via x402, read per request. */
export const POST = async (req: Request, ctx: unknown) => (isSameOriginBrowser(req) ? free : withX402(free, { ...paidOpts, priceUsdc: await currentPrice("screen") }))(req, ctx);
