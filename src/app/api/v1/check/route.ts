/**
 * POST /api/v1/check - the consumer face of the oracle. Free. Same-origin browsers are unmetered; other callers get
 * 20 requests/min per IP (in-memory token bucket). Runs the full pipeline (client id "check") and returns a plain-language verdict:
 *   { address, tier, score, headline, advice, limits, decisionId, attestation, shareUrl, reasons, source }
 * Body: { address, name?, amountUsdc?, source: "address" | "link" | "invoice", full?: boolean }  (full → also `verdict`)
 */
import { z } from "zod";
import { AddressSchema } from "@/lib/types";
import { screen } from "@/lib/pipeline";
import { config } from "@/lib/config";
import { isSameOriginBrowser } from "@/lib/payments";
import { toCheckResponse } from "@/lib/check/plain";
import { TokenBucket, clientIp } from "@/lib/check/ratelimit";
import { ApiError, handle, ok } from "../../_lib/respond";
import { parseJson } from "../../_lib/parse";

const CheckRequestSchema = z.object({
  address: AddressSchema,
  name: z.string().min(2).max(200).optional(),
  amountUsdc: z.number().nonnegative().optional(),
  source: z.enum(["address", "link", "invoice"]).default("address"),
  /** include the full Verdict (evidence, rationale) - used by the developer view on /a/[address] */
  full: z.boolean().optional(),
});

const bucket = new TokenBucket(20, 60_000);

/** Public base for share links: PUBLIC_BASE_URL unless it is still the localhost default and the request came from elsewhere. */
function shareBase(req: Request): string {
  const cfg = config().PUBLIC_BASE_URL.replace(/\/$/, "");
  const origin = (() => {
    try {
      return new URL(req.url).origin;
    } catch {
      return null;
    }
  })();
  return /localhost|127\.0\.0\.1/.test(cfg) && origin && !/localhost|127\.0\.0\.1/.test(origin) ? origin : cfg;
}

export const POST = handle(async (req: Request) => {
  if (config().COMPLIR_PAUSED) throw new ApiError("SERVICE_PAUSED", "CompliR is paused for maintenance.");
  if (!isSameOriginBrowser(req)) {
    const t = bucket.take(clientIp(req));
    if (!t.ok) {
      throw new ApiError("VALIDATION_ERROR", "Rate limit: 20 checks per minute per IP.", { retryAfterMs: t.retryAfterMs }, 429);
    }
  }
  const body = await parseJson(req, CheckRequestSchema);
  const verdict = await screen({ address: body.address, name: body.name, amountUsdc: body.amountUsdc, clientId: "check" });
  const res = toCheckResponse(verdict, `${shareBase(req)}/a/${verdict.address}`, body.source, { full: body.full });
  return ok(res, { headers: { "X-CompliR-Decision-Id": verdict.decisionId } });
});
