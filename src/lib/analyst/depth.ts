import type { EvidenceBundle, ScreenRequest } from "../types";

/** Cheap heuristics decide whether a second funder hop is worth the RPC cost. No model call needed. */
export function decideDepth(req: ScreenRequest, hop1: EvidenceBundle): 1 | 2 {
  if (req.depth) return req.depth;
  const s = hop1.subject;
  const hop1Hit = hop1.funders.some((f) => f.hop === 1 && (f.facts.sanctions.length > 0 || f.facts.usdcBlacklisted || f.facts.protocolBlocklisted));
  const fresh = s.firstSeen == null || s.txCount < 5 || Date.now() / 1000 - (s.firstSeen ?? 0) < 7 * 86400;
  const bigAmount = (req.amountUsdc ?? 0) >= 1000;
  if (s.sanctions.length > 0 || s.usdcBlacklisted) return 1; // already HIGH; hop 2 adds nothing
  if (hop1Hit || fresh || bigAmount || hop1.lookalikes.length > 0) return 2;
  return 1;
}
