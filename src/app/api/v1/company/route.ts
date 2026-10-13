/**
 * GET /api/v1/company - the agent-run company in one read: snapshot + last 10 operator decisions. Free, public,
 * cached 30 s (in-process memo + Cache-Control) because the snapshot touches Arc RPC and Circle.
 */
import { companySnapshot, recentOperatorDecisions, type CompanySnapshot } from "@/lib/operator";
import type { DecisionLogEntry } from "@/lib/types";
import { handle, ok } from "../../_lib/respond";

export interface CompanyResponse {
  snapshot: CompanySnapshot;
  decisions: DecisionLogEntry[];
  time: string;
}

const TTL_MS = 30_000;
let memo: { at: number; body: CompanyResponse } | null = null;
let inflight: Promise<CompanyResponse> | null = null;

async function build(): Promise<CompanyResponse> {
  const [snapshot, decisions] = await Promise.all([companySnapshot(), recentOperatorDecisions(10)]);
  return { snapshot, decisions, time: new Date().toISOString() };
}

export const GET = handle(async () => {
  const now = Date.now();
  if (!memo || now - memo.at >= TTL_MS) {
    inflight ??= build().then((body) => { memo = { at: Date.now(), body }; inflight = null; return body; }, (e) => { inflight = null; throw e; });
    await inflight;
  }
  const age = Math.floor((Date.now() - memo!.at) / 1000);
  return ok(memo!.body, { headers: { "Cache-Control": `public, max-age=${Math.max(0, 30 - age)}, s-maxage=30, stale-while-revalidate=60`, Age: String(age) } });
});
