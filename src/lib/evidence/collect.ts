/**
 * collectEvidence: ScreenRequest → EvidenceBundle. Spec §2.4.
 *
 * Sources run concurrently, each behind a per-source timeout (default 4 s, EVIDENCE_SOURCE_TIMEOUT_MS); a source
 * that fails or times out contributes its neutral value (false / [] / null) - the bundle is always produced.
 * Phase 1: subject facts (activity, USDC blocklist, protocol blocklist, yente by address+name) ‖ funder trace.
 * Phase 2: enrich funders (USDC blocklist, protocol blocklist, yente by address - one batched call) ‖ network signal
 *          (src/lib/network: held-elsewhere / shared-funder / concentration counts from the shared store).
 * Overrides (.data/overrides.json / OVERRIDES_JSON) are merged over live facts for the subject and every funder;
 * a subject override with `funders` replaces the chain trace entirely.
 */
import type { PublicClient } from "viem";
import type { Address, AddressFacts, AgentSignal, EvidenceBundle, InboundSignal, NetworkSignal, PayeeBookEntry, ScreenRequest, Tier } from "../types";
import { networkSignals, recordFunders, type NetworkSignalsFn } from "../network";
import { fetchActivity, type AddressActivity } from "./addressFacts";
import { emptyFacts, traceFunders, type FunderEntry, type GraphClient, type TraceResult } from "./arcGraph";
import { evidenceEnv } from "./env";
import { detectPayeeChange, findLookalikes } from "./lookalike";
import { applyFactsOverride, fundersFromOverride, loadOverrides, type Overrides } from "./overrides";
import { protocolBlocklistMany, isProtocolBlocklisted } from "./protocolBlocklist";
import { arcClient } from "./rpc";
import { isUsdcBlacklisted, usdcBlacklistMany } from "./usdcBlacklist";
import { lower, withTimeout } from "./util";
import { screenAddresses, screenSanctions } from "./yente";
import { agentFacts as erc8004AgentFacts, type AgentFactsOptions } from "../erc8004/read";
import { inboundEvidenceFor } from "../cctp/store";

export type EvidenceClient = GraphClient & Pick<PublicClient, "readContract" | "getTransactionCount">;

export interface CollectOptions {
  depth: 1 | 2;
  previousBook?: PayeeBookEntry[];
  priorTier?: { tier: Tier; at: number } | null;
  /** per-source timeout in ms (default EVIDENCE_SOURCE_TIMEOUT_MS or 4000) */
  timeoutMs?: number;
  /** injected for tests; default arcClient() */
  client?: EvidenceClient;
  fetchImpl?: typeof fetch;
  /** injected for tests; default loadOverrides() */
  overrides?: Overrides;
  /** funder trace tunables */
  maxPerHop?: number;
  lookbackBlocks?: number;
  /** unix seconds; default now */
  now?: number;
  /** cross-client network signal (src/lib/network); injected for tests, `null` disables the source. default networkSignals */
  network?: NetworkSignalsFn | null;
  /** ERC-8004 agent facts (src/lib/erc8004); injected for tests, `null` disables the source. default agentFacts */
  agent?: ((address: Address, opts: AgentFactsOptions) => Promise<AgentSignal | null>) | null;
  /** CCTP inbound signal (src/lib/cctp); injected for tests, `null` disables the source. default inboundEvidenceFor */
  inbound?: ((address: Address, opts: { now: number }) => Promise<InboundSignal | null>) | null;
}

export type SourceStatus = "ok" | "timeout_or_error" | "override" | "skipped";

export interface CollectResult {
  bundle: EvidenceBundle;
  /** per-source outcome, for logs / the decision record */
  sources: Record<"activity" | "usdcBlacklist" | "protocolBlocklist" | "sanctions" | "trace" | "funderEnrichment" | "network" | "agent" | "inbound", SourceStatus>;
  trace: Pick<TraceResult, "fromBlock" | "toBlock" | "requests" | "partial"> | null;
}

import { tipEvidenceFor } from "../tips/model";

const SENTINEL = Symbol("fail");
type Fail = typeof SENTINEL;

export async function collectEvidenceDetailed(req: ScreenRequest, opts: CollectOptions): Promise<CollectResult> {
  const env = evidenceEnv();
  const subject = lower(req.address);
  const timeoutMs = opts.timeoutMs ?? env.sourceTimeoutMs;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const overrides = opts.overrides ?? loadOverrides();
  const subjOverride = overrides[subject];
  const overrideFunders = fundersFromOverride(subjOverride);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const yenteOpts = { timeoutMs, fetchImpl };

  let client: EvidenceClient | null = opts.client ?? null;
  if (!client) {
    try {
      client = arcClient() as EvidenceClient;
    } catch {
      client = null; // no RPC config → chain sources are skipped, not fatal
    }
  }

  const guard = <T>(label: string, p: Promise<T> | null): Promise<T | Fail> =>
    p ? withTimeout<T | Fail>(label, p, timeoutMs, SENTINEL) : Promise.resolve(SENTINEL);

  // ── Phase 1: subject + trace, concurrently ────────────────────────────────
  const agentFn = opts.agent === null ? null : (opts.agent ?? erc8004AgentFacts);
  const inboundFn = opts.inbound === null ? null : (opts.inbound ?? inboundEvidenceFor);
  const [activity, usdcFlag, protoFlag, sanctions, trace, communityTips, agentRes, inboundRes] = await Promise.all([
    guard<AddressActivity>("activity", fetchActivity(subject, { client, fetchImpl, timeoutMs })),
    guard<boolean>("usdcBlacklist", client ? isUsdcBlacklisted(subject, { client }) : null),
    guard<boolean>("protocolBlocklist", client ? isProtocolBlocklisted(subject, { client }) : null),
    guard("sanctions", screenSanctions({ address: subject, name: req.name }, yenteOpts)),
    guard<TraceResult>(
      "trace",
      overrideFunders || !client
        ? null
        : traceFunders(subject, {
            depth: opts.depth,
            client,
            maxPerHop: opts.maxPerHop,
            lookbackBlocks: opts.lookbackBlocks,
            // soft deadline: hand back hop 1 (+ partial hop 2) before the hard per-source timeout discards everything
            deadline: Date.now() + Math.max(500, timeoutMs - 400),
          }),
    ),
    guard("communityTips", tipEvidenceFor(subject, { now })),
    // ERC-8004 agent identity + reputation/validation (src/lib/erc8004) - read-only registry calls on the same client
    guard<AgentSignal | null>("agent", agentFn && client ? agentFn(subject, { client, now }) : null),
    // CCTP inbound mints from flagged source-chain senders (src/lib/cctp) - store lookup only
    guard<InboundSignal | null>("inbound", inboundFn ? inboundFn(subject, { now }) : null),
  ]);

  const traceOk = trace !== SENTINEL;
  const traceRes = traceOk ? trace : null;

  let subjectFacts: AddressFacts = {
    ...emptyFacts(subject),
    firstSeen: minDefined(activity === SENTINEL ? null : activity.firstSeen, traceRes?.subjectFirstIncoming ?? null),
    txCount: activity === SENTINEL ? 0 : activity.txCount,
    usdcBlacklisted: usdcFlag === SENTINEL ? false : usdcFlag,
    protocolBlocklisted: protoFlag === SENTINEL ? false : protoFlag,
    sanctions: sanctions === SENTINEL ? [] : sanctions,
  };
  // RPC fallback knows only the outgoing nonce; if the trace saw inbound transfers, count them in.
  if (activity !== SENTINEL && activity.source !== "blockscout" && traceRes) {
    subjectFacts.txCount = Math.max(subjectFacts.txCount, activity.txCount + traceRes.subjectIncomingCount);
  }
  subjectFacts = applyFactsOverride(subjectFacts, subjOverride);

  // ── Phase 2: funders ─────────────────────────────────────────────────────
  let funders: FunderEntry[] = overrideFunders ?? traceRes?.funders ?? [];
  let depth: 0 | 1 | 2 = overrideFunders ? maxHop(overrideFunders) : (traceRes?.depth ?? 0);
  let enrichment: SourceStatus = "skipped";

  // Cross-client network signal (counts only) - needs the hop-1 funders, so it starts here and runs alongside enrichment.
  const networkFn = opts.network === null ? null : (opts.network ?? networkSignals);
  const hop1 = [...new Set(funders.filter((f) => f.hop === 1).map((f) => f.facts.address))];
  const networkP = guard<NetworkSignal>("network", networkFn ? networkFn(subject, req.clientId ?? null, { funders: hop1, now }) : null);

  if (!overrideFunders && funders.length > 0 && client) {
    const addrs = funders.map((f) => f.facts.address);
    const [bl, pl, sa] = await Promise.all([
      guard("funders.usdcBlacklist", usdcBlacklistMany(addrs, { client })),
      guard("funders.protocolBlocklist", protocolBlocklistMany(addrs, { client })),
      guard("funders.sanctions", screenAddresses(addrs, yenteOpts)),
    ]);
    enrichment = bl === SENTINEL && pl === SENTINEL && sa === SENTINEL ? "timeout_or_error" : "ok";
    funders = funders.map((f) => ({
      ...f,
      facts: {
        ...f.facts,
        usdcBlacklisted: bl === SENTINEL ? false : (bl.get(f.facts.address) ?? false),
        protocolBlocklisted: pl === SENTINEL ? false : (pl.get(f.facts.address) ?? false),
        sanctions: sa === SENTINEL ? [] : (sa.get(f.facts.address) ?? []),
      },
    }));
  } else if (overrideFunders) {
    enrichment = "override";
  }
  // Overrides apply to funders too (so a demo "bad" wallet reads as bad wherever it appears in a graph).
  funders = funders.map((f) => (overrides[f.facts.address] ? { ...f, facts: applyFactsOverride(f.facts, overrides[f.facts.address]) } : f));
  if (opts.depth === 1) {
    funders = funders.filter((f) => f.hop === 1);
    if (depth > 1) depth = 1;
  }

  const networkRes = await networkP;
  const network = networkRes === SENTINEL ? null : networkRes;
  // Remember this client's (payee → hop-1 funders) so the shared-funder signal exists for its next payee (after the
  // lookup, so a subject never counts itself). Fire-and-forget: the store is never on the request's critical path.
  if (networkFn && req.clientId) void recordFunders(req.clientId, subject, { funders }, now);

  const bundle: EvidenceBundle = {
    subject: subjectFacts,
    funders,
    lookalikes: findLookalikes(subject, req.payeeBook),
    payeeChanged: detectPayeeChange(subject, req.payeeBook, opts.previousBook),
    // Tamias signal, from the shared store (payee_funders across clients + Trust Map edges) - counts only.
    concentration: network?.concentrationHint ? { sharedFunder: network.concentrationHint.funder, otherPayees: network.concentrationHint.otherPayees } : null,
    priorTier: opts.priorTier ?? null,
    communityTips: communityTips === SENTINEL ? [] : communityTips.map((t) => ({ tipId: t.tipId, category: t.category, strength: t.strength, verifiedAt: t.verifiedAt })),
    collectedAt: now,
    depth,
    network,
    agent: agentRes === SENTINEL ? null : agentRes,
    inbound: inboundRes === SENTINEL ? null : inboundRes,
  };

  const status = (v: unknown, p: boolean): SourceStatus => (!p ? "skipped" : v === SENTINEL ? "timeout_or_error" : "ok");
  return {
    bundle,
    sources: {
      activity: status(activity, true),
      usdcBlacklist: subjOverride?.usdcBlacklisted !== undefined ? "override" : status(usdcFlag, !!client),
      protocolBlocklist: subjOverride?.protocolBlocklisted !== undefined ? "override" : status(protoFlag, !!client),
      sanctions: subjOverride?.sanctions !== undefined ? "override" : status(sanctions, true),
      trace: overrideFunders ? "override" : status(trace, !!client),
      funderEnrichment: enrichment,
      network: status(networkRes, !!networkFn),
      agent: status(agentRes, !!agentFn && !!client),
      inbound: status(inboundRes, !!inboundFn),
    },
    trace: traceRes ? { fromBlock: traceRes.fromBlock, toBlock: traceRes.toBlock, requests: traceRes.requests, partial: traceRes.partial } : null,
  };
}

export async function collectEvidence(req: ScreenRequest, opts: CollectOptions): Promise<EvidenceBundle> {
  return (await collectEvidenceDetailed(req, opts)).bundle;
}

function minDefined(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function maxHop(funders: FunderEntry[]): 0 | 1 | 2 {
  return funders.reduce<0 | 1 | 2>((m, f) => (f.hop > m ? f.hop : m), 0);
}

export type { Address };
