/** ERC-8004 tunables, straight from process.env (config.ts carries only the shared network keys). */
import type { Address } from "../types";
import { ERC8004_ADDRESSES } from "./abi";

const addr = (v: string | undefined): Address | undefined => (/^0x[0-9a-fA-F]{40}$/.test(v ?? "") ? (v as Address) : undefined);
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

export function erc8004Env() {
  const e = process.env;
  const chainId = Number(e.ARC_CHAIN_ID ?? 5042);
  const d = ERC8004_ADDRESSES[chainId] ?? ERC8004_ADDRESSES[5042];
  return {
    chainId,
    identity: addr(e.ERC8004_IDENTITY_REGISTRY) ?? d.identity,
    reputation: addr(e.ERC8004_REPUTATION_REGISTRY) ?? d.reputation,
    validation: addr(e.ERC8004_VALIDATION_REGISTRY) ?? d.validation,
    /** CompliR's own agentId (set by scripts/erc8004/register.ts); null until registered */
    ownAgentId: /^\d+$/.test(e.ERC8004_AGENT_ID ?? "") ? BigInt(e.ERC8004_AGENT_ID as string) : null,
    /** ERC8004_PUBLISH=1 → write validations / feedback back on-chain after a screen */
    publish: /^(1|true|yes|on)$/i.test((e.ERC8004_PUBLISH ?? "").trim()),
    /** do not publish about the same agent more often than this */
    publishMinHours: num(e.ERC8004_PUBLISH_MIN_HOURS, 24),
    /** first block of the Registered-event backfill (IdentityRegistry deployment); 0 = scan from genesis */
    fromBlock: num(e.ERC8004_FROM_BLOCK, 0),
    /** getLogs chunks per sync call (× 9_999 blocks) */
    indexChunks: num(e.ERC8004_INDEX_CHUNKS, 40),
    /** re-sync lazily from agentFacts() when the index cursor is older than this many blocks */
    indexStaleBlocks: num(e.ERC8004_INDEX_STALE_BLOCKS, 2_000),
    /** at most this many validation request hashes / feedback clients are read per agent (4 s budget) */
    maxReads: num(e.ERC8004_MAX_READS, 20),
  };
}
