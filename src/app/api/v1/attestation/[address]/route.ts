/**
 * GET /api/v1/attestation/:address - the free verdict for an address. Spec §2.1.
 * Always answers: never-seen addresses are screened on demand (first sight ~20-60 s), concurrent requests share one
 * screen, and expired verdicts are returned at once while a background re-screen refreshes them (src/lib/freeVerdict).
 */
import { after } from "next/server";
import { freeVerdict } from "@/lib/freeVerdict";
import { handle, ok } from "../../../_lib/respond";
import { parseAddress } from "../../../_lib/parse";
import type { AttestationResponse } from "../../../_lib/public-types";

type Ctx = { params: Promise<{ address: string }> };

export const maxDuration = 180;

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { address: raw } = await params;
  const address = parseAddress(raw, "path.address");
  const body: AttestationResponse = await freeVerdict(address, { background: (fn) => after(fn) });
  return ok(body);
});
