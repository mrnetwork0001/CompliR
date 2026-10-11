/**
 * Evidence Collector — public surface. Spec §2.4.
 *
 *   collectEvidence(req, { depth, previousBook?, priorTier? }) → EvidenceBundle   (what the pipeline calls)
 *   collectEvidenceDetailed(...)                                 → { bundle, sources, trace }
 */
export { collectEvidence, collectEvidenceDetailed } from "./collect";
export type { CollectOptions, CollectResult, EvidenceClient, SourceStatus } from "./collect";

export { traceFunders, incomingTransfers, groupFunders, emptyFacts, TRANSFER_EVENT, ZERO_ADDRESS } from "./arcGraph";
export type { TraceOptions, TraceResult, FunderEntry, GraphClient } from "./arcGraph";

export { fetchActivity, normalizeBlockscoutBase } from "./addressFacts";
export type { AddressActivity, ActivityOptions } from "./addressFacts";

export { isUsdcBlacklisted, usdcBlacklistMany, FIAT_TOKEN_ABI } from "./usdcBlacklist";
export { isProtocolBlocklisted, protocolBlocklistMany, protocolBlocklistAddress, PROTOCOL_BLOCKLIST_ABI } from "./protocolBlocklist";

export { screenSanctions, screenAddresses, yenteMatch, toSanctionsHit, NAME_SCHEMAS } from "./yente";
export type { YenteOptions, YenteSubject } from "./yente";

export { findLookalikes, detectPayeeChange, levenshtein, levenshteinSimilarity, sharesAffixes } from "./lookalike";
export type { Lookalike, LookalikeOptions } from "./lookalike";

export { loadOverrides, parseOverrides, applyFactsOverride, fundersFromOverride, __resetOverridesCache } from "./overrides";
export type { Overrides, Override, FactsOverride } from "./overrides";

export { arcClient, chainFor, __resetArcClient, GETLOGS_MAX_RANGE, GETLOGS_MAX_RESULTS } from "./rpc";
export { evidenceEnv, ARC_SYSTEM_EMITTER, ARC_USDC_ERC20 } from "./env";
export { withTimeout, pMap, toUsdc6, TimeoutError, Limiter, rpcGate, rpcRetry, isRateLimited, isRangeError } from "./util";
