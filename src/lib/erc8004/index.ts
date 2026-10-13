/**
 * ERC-8004 agent-to-agent trust (docs/ERC8004.md).
 *   agentFacts(address, {client})      → EvidenceBundle.agent (read-only; evidence/collect.ts)
 *   publishAgentVerdict(verdict)       → validationResponse / giveFeedback on Arc (ERC8004_PUBLISH=1), ledger NOOP entry
 *   syncAgentIndex()                   → address → agentId index from IdentityRegistry logs
 */
export * from "./abi";
export * from "./env";
export * from "./store";
export * from "./indexer";
export * from "./read";
export * from "./publish";
