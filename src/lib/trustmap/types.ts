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

/** A USDC recipient (or a counterparty of a graded node) the tailer has seen but not graded yet. Faint on the map. */
export interface MapCandidate {
  address: Address;
  /** rolling 24 h bucket: reset when the bucket is older than a day, else summed per tick */
  usdcIn24h: number;
  usdcOut24h: number;
  txCount: number;
  firstSeenBlock: number;
  lastSeenBlock: number;
  /** null = eth_getCode not asked yet (the tailer only asks for addresses it is about to grade) */
  isContract: boolean | null;
  lastSeenAt: number;
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
  /** candidate rows persisted after this tick (observed, ungraded) */
  observed?: number;
}

export interface MapStats {
  graded: number;
  high: number;
  medium: number;
  low: number;
  /** observed-but-ungraded candidates on file */
  observed: number;
  tierChanges24h: number;
  cursorBlock: number | null;
  lastTickAt: string | null;
  lastTick: TickSummary | null;
}

export interface MapSnapshot {
  nodes: MapNode[];
  /** observed, ungraded - drawn faint on the outermost ring */
  candidates: MapCandidate[];
  /** transfers among nodes ∪ candidates (graded↔graded, graded↔candidate) */
  edges: MapEdge[];
  stats: MapStats;
  generatedAt: string;
}

export interface NodeHistory {
  /** null when the address is only a candidate */
  node: (MapNode & { rationale: string | null; decisionId: string | null }) | null;
  /** set when the address is observed but not graded */
  candidate: MapCandidate | null;
  changes: TierChange[];
  edges: MapEdge[];
}
