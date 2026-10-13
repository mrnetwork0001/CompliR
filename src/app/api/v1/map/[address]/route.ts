/**
 * GET  /api/v1/map/:address - one Trust Map node (graded: tier history + edges; observed candidate: the row + edges). 404 otherwise. Free.
 * POST /api/v1/map/:address - promote an observed candidate onto the map after a same-origin screen: body `{ decisionId }`
 *      must reference a decision for this address made with clientId "trustmap" (the /map "screen now" button POSTs
 *      /api/v1/screen first, then this). Nothing from the client body is trusted beyond the id: tier / score / reasons
 *      are re-read from the decision log. Same-origin browsers only.
 */
import { z } from "zod";
import { getDecisionRow } from "@/lib/store/repo";
import { isSameOriginBrowser } from "@/lib/payments";
import { invalidateSnapshotCache, nodeHistory } from "@/lib/trustmap/query";
import { deleteCandidates, getCandidate, insertTierChange, upsertNode } from "@/lib/trustmap/store";
import type { ReasonCode, Tier } from "@/lib/types";
import { ApiError, handle, ok } from "../../../_lib/respond";
import { parseAddress, parseJson } from "../../../_lib/parse";

type Ctx = { params: Promise<{ address: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { address: raw } = await params;
  const address = parseAddress(raw, "path.address");
  const h = await nodeHistory(address);
  if (!h) throw new ApiError("NOT_FOUND", "address is not on the Trust Map (neither graded nor observed by the tailer yet)");
  return ok(h);
});

const PromoteSchema = z.object({ decisionId: z.string().min(4).max(64) });
const TIERS = new Set<Tier>(["LOW", "MEDIUM", "HIGH"]);

export const POST = handle<Ctx>(async (req, { params }) => {
  if (!isSameOriginBrowser(req)) throw new ApiError("VALIDATION_ERROR", "promotion is only available to the hosted /map page (same-origin)", undefined, 403);
  const { address: raw } = await params;
  const address = parseAddress(raw, "path.address");
  const { decisionId } = await parseJson(req, PromoteSchema);
  const row = await getDecisionRow(decisionId);
  if (!row || row.subject !== address) throw new ApiError("NOT_FOUND", "no decision with that id for this address");
  if (row.clientId !== "trustmap") throw new ApiError("VALIDATION_ERROR", "decision was not made for the Trust Map (clientId must be \"trustmap\")");
  const p = row.payload as { tier?: Tier; score?: number; reasons?: { code: ReasonCode }[]; rationale?: string } | null;
  if (!p || !p.tier || !TIERS.has(p.tier) || typeof p.score !== "number") throw new ApiError("VALIDATION_ERROR", "decision payload is not a verdict");
  const cand = await getCandidate(address);
  const now = Math.floor(Date.now() / 1000);
  const { prev, changed } = await upsertNode({
    address, tier: p.tier, score: p.score, lastSeenBlock: cand?.lastSeenBlock ?? 0, usdcIn24h: cand?.usdcIn24h ?? 0,
    reasonCodes: (p.reasons ?? []).map((r) => r.code), rationale: p.rationale ?? null, decisionId, source: "chain", at: now,
  });
  if (changed && prev) await insertTierChange({ address, from: prev.tier, to: p.tier, score: p.score, block: cand?.lastSeenBlock ?? null, decisionId, at: now });
  await deleteCandidates([address]);
  invalidateSnapshotCache();
  const h = await nodeHistory(address);
  return ok({ promoted: true, changed, ...h });
});
