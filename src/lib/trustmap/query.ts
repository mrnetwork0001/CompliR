/** Read side of the Trust Map: snapshot for the page, recent tier changes for the ticker, per-node history. */
import type { Address } from "../types";
import { countCandidates, countNodes, countTierChangesSince, edgesAmong, edgesOf, getCandidate, getCursor, getLastTick, getNode, listCandidates, listNodes, listTierChanges, tierChangesOf } from "./store";
import type { MapNode, MapSnapshot, NodeHistory, TierChange } from "./types";

const toMapNode = (n: MapNode & { rationale?: string | null; decisionId?: string | null }): MapNode => ({
  address: n.address, tier: n.tier, score: n.score, usdcIn24h: n.usdcIn24h, lastSeenBlock: n.lastSeenBlock, changedAt: n.changedAt,
  prevTier: n.prevTier, firstGradedAt: n.firstGradedAt, lastGradedAt: n.lastGradedAt, reasonCodes: n.reasonCodes, source: n.source,
});

export async function mapSnapshot({ limit = 150, candidates: candLimit = 200, now = Math.floor(Date.now() / 1000) }: { limit?: number; candidates?: number; now?: number } = {}): Promise<MapSnapshot> {
  const lim = Math.min(Math.max(1, limit), 400);
  const clim = Math.min(Math.max(0, candLimit), 500);
  const [rows, cands, counts, observed, changes24h, cursor, lastTick] = await Promise.all([
    listNodes(lim), listCandidates(clim), countNodes(), countCandidates(), countTierChangesSince(now - 86_400), getCursor(), getLastTick(),
  ]);
  const nodes = rows.map(toMapNode);
  // candidates that are also graded (race between a tick and a promote) never show twice
  const graded = new Set(nodes.map((n) => n.address));
  const candidates = cands.filter((c) => !graded.has(c.address));
  const edges = await edgesAmong([...nodes.map((n) => n.address), ...candidates.map((c) => c.address)], 600);
  return {
    nodes,
    candidates,
    edges,
    stats: {
      graded: counts.graded, high: counts.high, medium: counts.medium, low: counts.low, observed, tierChanges24h: changes24h,
      cursorBlock: cursor, lastTickAt: lastTick ? new Date(lastTick.at * 1000).toISOString() : null, lastTick,
    },
    generatedAt: new Date(now * 1000).toISOString(),
  };
}

/** 10 s in-process cache for the public snapshot (the page auto-refreshes; judges curl it). Promotions invalidate it. */
const SNAP_TTL_MS = 10_000;
const snapCache = new Map<string, { at: number; body: MapSnapshot }>();
export async function cachedSnapshot(opts: { limit: number; candidates: number }): Promise<MapSnapshot> {
  const key = `${opts.limit}:${opts.candidates}`;
  const hit = snapCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < SNAP_TTL_MS) return hit.body;
  const body = await mapSnapshot(opts);
  snapCache.set(key, { at: now, body });
  return body;
}
export function invalidateSnapshotCache(): void {
  snapCache.clear();
}

export async function recentTierChanges(limit = 25): Promise<TierChange[]> {
  return listTierChanges(Math.min(Math.max(1, limit), 200));
}

/** Graded node → full history; observed candidate → the candidate row + its edges; neither → null. */
export async function nodeHistory(address: Address): Promise<NodeHistory | null> {
  const node = await getNode(address);
  if (node) {
    const [changes, edges] = await Promise.all([tierChangesOf(node.address, 50), edgesOf(node.address, 50)]);
    return { node, candidate: null, changes, edges };
  }
  const candidate = await getCandidate(address);
  if (!candidate) return null;
  return { node: null, candidate, changes: [], edges: await edgesOf(candidate.address, 50) };
}
