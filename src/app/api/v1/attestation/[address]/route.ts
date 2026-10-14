/**
 * GET /api/v1/attestation/:address - the free verdict for an address. Spec §2.1.
 * Always answers: never-seen addresses are screened on demand, concurrent requests share one screen, and expired
 * verdicts are returned at once while a background re-screen refreshes them (src/lib/freeVerdict).
 *
 * Waiting on a first-sight screen (~20-60 s):
 *   default        wait up to 25 s, then 503 SCREENING_IN_PROGRESS + Retry-After (an error, so a client that does not
 *                  know this API never mistakes it for a verdict); the screen keeps running, the retry gets it.
 *   ?wait=<1-120>  wait up to that long, then 202 {status:"screening", retryAfterSeconds} + Retry-After.
 * Rate limit: only NEW first-sight screens count, 30 per minute per IP (stored reads are unlimited). Every response
 * carries RateLimit-Policy; first-sight responses add RateLimit-Limit/Remaining/Reset; over the limit → 429 + Retry-After.
 */
import { after } from "next/server";
import { TokenBucket, clientIp } from "@/lib/check/ratelimit";
import { freeVerdict } from "@/lib/freeVerdict";
import { ApiError, handle, ok } from "../../../_lib/respond";
import { parseAddress } from "../../../_lib/parse";
import type { AttestationResponse } from "../../../_lib/public-types";

type Ctx = { params: Promise<{ address: string }> };

export const maxDuration = 180;

const FIRST_SIGHT_LIMIT = 30;
const FIRST_SIGHT_WINDOW_S = 60;
const DEFAULT_WAIT_S = 25;
const POLICY = `${FIRST_SIGHT_LIMIT};w=${FIRST_SIGHT_WINDOW_S};comment="new first-sight screens per IP; stored reads unlimited"`;
const firstSight = new TokenBucket(FIRST_SIGHT_LIMIT, FIRST_SIGHT_WINDOW_S * 1000);

export const GET = handle<Ctx>(async (req, { params }) => {
  const { address: raw } = await params;
  const address = parseAddress(raw, "path.address");
  const waitRaw = new URL(req.url).searchParams.get("wait");
  let explicitWait = false;
  let maxWaitMs = DEFAULT_WAIT_S * 1000;
  if (waitRaw !== null) {
    const w = Number(waitRaw);
    if (!Number.isFinite(w) || w < 1 || w > 120) throw new ApiError("VALIDATION_ERROR", "wait must be a number of seconds between 1 and 120", { issues: [{ path: "query.wait", message: "1-120" }] });
    maxWaitMs = Math.round(w * 1000);
    explicitWait = true;
  }

  const headers: Record<string, string> = { "RateLimit-Policy": POLICY };
  const admitFirstSight = () => {
    const t = firstSight.take(clientIp(req));
    headers["RateLimit-Limit"] = String(FIRST_SIGHT_LIMIT);
    headers["RateLimit-Remaining"] = String(t.remaining);
    headers["RateLimit-Reset"] = String(Math.ceil(t.retryAfterMs / 1000));
    if (!t.ok) {
      const retry = String(Math.max(1, Math.ceil(t.retryAfterMs / 1000)));
      throw new ApiError("RATE_LIMITED", `Rate limit: ${FIRST_SIGHT_LIMIT} new first-sight screens per minute per IP. Stored verdicts are not limited.`, { retryAfterMs: t.retryAfterMs }, 429, { ...headers, "Retry-After": retry });
    }
  };

  const out = await freeVerdict(address, { background: (fn) => after(fn), admitFirstSight, maxWaitMs });
  if ("status" in out) {
    const retryHeaders = { ...headers, "Retry-After": String(out.retryAfterSeconds) };
    if (explicitWait) return ok(out, { status: 202, headers: retryHeaders });
    throw new ApiError("SCREENING_IN_PROGRESS", `${out.message} (Waited ${DEFAULT_WAIT_S} s; pass ?wait=<seconds> for a 202 instead.)`, { address: out.address, retryAfterSeconds: out.retryAfterSeconds }, 503, retryHeaders);
  }
  return ok(out satisfies AttestationResponse, { headers });
});
