/** Public shapes for /api/v1/inbound. Sender masked; counts and chain names only for the sanctions side. */
import type { InboundRow } from "@/lib/cctp/store";
import type { Tier } from "@/lib/types";

export interface PublicInbound {
  txHash: `0x${string}`;
  block: number;
  at: string | null; // ISO block time (or when we recorded it)
  sourceDomain: number;
  sourceChain: string;
  /** masked source-chain sender, e.g. 0x1234…abcd */
  senderMasked: string;
  recipient: `0x${string}`;
  amountUsdc: string;
  sender: {
    sanctioned: boolean;
    /** OpenSanctions dataset ids behind the hit (no entity names) */
    datasets: string[];
    blacklisted: boolean;
    checks: InboundRow["senderChecks"];
  };
  recipient_screen: { decisionId: string | null; tier: Tier | null; score: number | null };
  flagged: boolean;
}
export interface InboundResponse {
  items: PublicInbound[];
  limit: number;
  total: number;
  flagged: number;
  cursorBlock: number | null;
  lastTickAt: string | null;
  source: "store";
}
export interface InboundHistoryResponse {
  address: `0x${string}`;
  items: PublicInbound[];
  total: number;
  flagged: number;
  source: "store";
}

export function toPublicInbound(r: InboundRow, mask: (a: string) => string): PublicInbound {
  const at = r.blockTime ?? r.createdAt;
  return {
    txHash: r.txHash,
    block: r.block,
    at: at ? new Date(at * 1000).toISOString() : null,
    sourceDomain: r.sourceDomain,
    sourceChain: r.sourceChain,
    senderMasked: mask(r.sourceSender),
    recipient: r.recipient,
    amountUsdc: r.amountUsdc,
    sender: {
      sanctioned: r.senderSanctions.length > 0,
      datasets: [...new Set(r.senderSanctions.flatMap((h) => h.datasets))].sort(),
      blacklisted: r.senderBlacklisted,
      checks: r.senderChecks,
    },
    recipient_screen: { decisionId: r.recipientDecisionId, tier: r.recipientTier, score: r.recipientScore },
    flagged: r.flagged,
  };
}
