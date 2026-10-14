/**
 * GET /api/v1/attestation/:address - the free verdict for an address. Spec §2.1.
 * Always answers: never-seen addresses are screened on demand (first sight ~20-60 s), concurrent requests share one
 * screen, and expired verdicts are returned at once while a background re-screen refreshes them (src/lib/freeVerdict).
 */
import { after } from "next/server";
import { freeVerdict } from "@/lib/freeVerdict";
import { ApiError } from "../../../_lib/respond";
import { handle, ok } from "../../../_lib/respond";
import { parseAddress } from "../../../_lib/parse";
import type { AttestationResponse } from "../../../_lib/public-types";

type Ctx = { params: Promise<{ address: string }> };

export const maxDuration = 180;

/**
 * ?wait=<seconds> (1-120): on first sight, return 202 {status:"screening", retryAfterSeconds} with Retry-After
 * instead of holding the connection longer than that. Without it the request waits for the screen (~20-60 s).
 */
export const GET = handle<Ctx>(async (req, { params }) => {
  const { address: raw } = await params;
  const address = parseAddress(raw, "path.address");
  const waitRaw = new URL(req.url).searchParams.get("wait");
  let maxWaitMs: number | undefined;
  if (waitRaw !== null) {
    const w = Number(waitRaw);
    if (!Number.isFinite(w) || w < 1 || w > 120) throw new ApiError("VALIDATION_ERROR", "wait must be a number of seconds between 1 and 120", { issues: [{ path: "query.wait", message: "1-120" }] });
    maxWaitMs = Math.round(w * 1000);
  }
  const background = (fn: () => Promise<unknown>) => after(fn);
  if (maxWaitMs === undefined) {
    const body: AttestationResponse = await freeVerdict(address, { background });
    return ok(body);
  }
  const out = await freeVerdict(address, { background, maxWaitMs });
  if ("status" in out) return ok(out, { status: 202, headers: { "Retry-After": String(out.retryAfterSeconds), "Cache-Control": "no-store" } });
  return ok(out satisfies AttestationResponse);
});
