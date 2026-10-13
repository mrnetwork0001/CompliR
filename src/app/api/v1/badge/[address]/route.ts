/**
 * GET /api/v1/badge/:address.svg - "Screened by CompliR · TIER · valid until <date>" badge. Free.
 * Read-only against the store (`latestAttestation`); never runs the pipeline. Grey "unknown" when unseen.
 * Cache-Control: max-age=60 so receipts/READMEs can hot-link it.
 */
import { latestAttestation } from "@/lib/store";
import { renderBadge, type BadgeInput } from "../badge";

type Ctx = { params: Promise<{ address: string }> };

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEADERS = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Cache-Control": "public, max-age=60, s-maxage=60",
  "X-CompliR-Version": "v1",
};

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  const { address: raw } = await params;
  const address = decodeURIComponent(raw).replace(/\.svg$/i, "").trim().toLowerCase();
  if (!ADDR.test(address)) {
    return new Response(renderBadge({ status: "UNKNOWN" }), { status: 400, headers: { ...HEADERS, "Cache-Control": "no-store" } });
  }
  let input: BadgeInput = { status: "UNKNOWN" };
  try {
    const a = await latestAttestation(address);
    if (a) {
      const now = Math.floor(Date.now() / 1000);
      input = a.attestation.validUntil > now ? { status: a.tier, validUntil: a.attestation.validUntil, score: a.score } : { status: "EXPIRED", validUntil: a.attestation.validUntil, score: a.score };
    }
  } catch (e) {
    console.error("[complir/badge] store read failed:", e);
  }
  return new Response(renderBadge(input), { status: 200, headers: HEADERS });
}
