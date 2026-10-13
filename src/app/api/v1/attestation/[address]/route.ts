/**
 * GET /api/v1/attestation/:address - latest public attestation for an address. Free. Spec §2.1.
 * Served from the store; if the address was never screened we run the pipeline once (source: "fresh").
 */
import { latestAttestation } from "@/lib/store";
import { screen } from "@/lib/pipeline";
import { handle, ok } from "../../../_lib/respond";
import { parseAddress } from "../../../_lib/parse";
import type { AttestationResponse } from "../../../_lib/public-types";

type Ctx = { params: Promise<{ address: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { address: raw } = await params;
  const address = parseAddress(raw, "path.address");

  const stored = await latestAttestation(address);
  if (stored) {
    const body: AttestationResponse = { ...stored, source: "store" };
    return ok(body);
  }

  const v = await screen({ address });
  const body: AttestationResponse = {
    address: v.address,
    score: v.score,
    tier: v.tier,
    attestation: v.attestation,
    decisionId: v.decisionId,
    screenedAt: v.screenedAt,
    source: "fresh",
  };
  return ok(body);
});
