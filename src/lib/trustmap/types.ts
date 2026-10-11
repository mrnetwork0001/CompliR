/** Public shapes served by /api/v1/map* and consumed by the /map page. */
import type { Address, ReasonCode, Tier } from "../types";

export type NodeSource = "chain" | "demo";

export interface MapNode {
  address: Address;
  tier: Tier;
  score: number;
  usdcIn24h: number;
  lastSeenBlock: number;
  /** unix seconds of the last tier change, null if never changed */
  changedAt: number | null;
  prevTier: Tier | null;
  firstGradedAt: number;
  lastGradedAt: number;
  reasonCodes: ReasonCode[];
  source: NodeSource;
}

export interface MapEdge {
  from: Address;
  to: Address;
  usdc: number;
  txHash: `0x${string}`;
  block: number;
  source: NodeSource;
}

export interface TierChange {
  id: number;
  address: Address;
  from: Tier | null;
  to: Tier;
  score: number;
  block: number | null;
  at: number;
  source: NodeSource;
}

export interface TickSummary {
  at: number;
  fromBlock: number | null;
  toBlock: number | null;
  blocksScanned: number;
  logs: number;
  recipients: number;
  candidates: number;
  graded: number;
  failed: number;
  rpcCalls: number;
  partial: boolean;
  rateLimited: boolean;
}

export interface MapStats {
  graded: number;
  high: number;
  medium: number;
  low: number;
  tierChanges24h: number;
  cursorBlock: number | null;
  lastTickAt: string | null;
  lastTick: TickSummary | null;
}

export interface MapSnapshot {
  nodes: MapNode[];
  edges: MapEdge[];
  stats: MapStats;
  generatedAt: string;
}

export interface NodeHistory {
  node: MapNode & { rationale: string | null; decisionId: string | null };
  changes: TierChange[];
  edges: MapEdge[];
}
