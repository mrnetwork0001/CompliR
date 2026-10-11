/** Read side of the Trust Map: snapshot for the page, recent tier changes for the ticker, per-node history. */
import type { Address } from "../types";
import { countNodes, countTierChangesSince, edgesAmong, edgesOf, getCursor, getLastTick, getNode, listNodes, listTierChanges, tierChangesOf } from "./store";
import type { MapNode, MapSnapshot, NodeHistory, TierChange } from "./types";

const toMapNode = (n: MapNode & { rationale?: string | null; decisionId?: string | null }): MapNode => ({
  address: n.address, tier: n.tier, score: n.score, usdcIn24h: n.usdcIn24h, lastSeenBlock: n.lastSeenBlock, changedAt: n.changedAt,
  prevTier: n.prevTier, firstGradedAt: n.firstGradedAt, lastGradedAt: n.lastGradedAt, reasonCodes: n.reasonCodes, source: n.source,
});

export async function mapSnapshot({ limit = 150, now = Math.floor(Date.now() / 1000) }: { limit?: number; now?: number } = {}): Promise<MapSnapshot> {
  const lim = Math.min(Math.max(1, limit), 400);
  const [rows, counts, changes24h, cursor, lastTick] = await Promise.all([
    listNodes(lim), countNodes(), countTierChangesSince(now - 86_400), getCursor(), getLastTick(),
  ]);
  const nodes = rows.map(toMapNode);
  const edges = await edgesAmong(nodes.map((n) => n.address), 500);
  return {
    nodes,
    edges,
    stats: {
      graded: counts.graded, high: counts.high, medium: counts.medium, low: counts.low, tierChanges24h: changes24h,
      cursorBlock: cursor, lastTickAt: lastTick ? new Date(lastTick.at * 1000).toISOString() : null, lastTick,
    },
    generatedAt: new Date(now * 1000).toISOString(),
  };
}

export async function recentTierChanges(limit = 25): Promise<TierChange[]> {
  return listTierChanges(Math.min(Math.max(1, limit), 200));
}

export async function nodeHistory(address: Address): Promise<NodeHistory | null> {
  const node = await getNode(address);
  if (!node) return null;
  const [changes, edges] = await Promise.all([tierChangesOf(node.address, 50), edgesOf(node.address, 50)]);
  return { node, changes, edges };
}
