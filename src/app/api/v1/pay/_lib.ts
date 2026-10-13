import { PayLinkError } from "@/lib/paylinks";
import { ApiError } from "../../_lib/respond";

/** Map PayLinkError → ApiError so `handle()` renders the JSON error shape. */
export function rethrow(e: unknown): never {
  if (e instanceof PayLinkError) {
    throw new ApiError(e.code === "BAD_STATE" ? "CONFLICT" : e.code, e.message);
  }
  throw e;
}

/** Browser calls must be same-origin (blocks cross-site form posts); non-browser clients (no Sec-Fetch-Site) are allowed. */
export function assertNotCrossSite(req: Request): void {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new ApiError("FORBIDDEN", "Payment links are created from the CompliR origin only.");
}
