/**
 * Deterministic scoring rules. Pure: same EvidenceBundle in → same {score, reasons} out.
 * The LLM analyst never touches this. Spec §2.3: "Deterministic rules produce the score and tier."
 *
 * Determinism notes:
 *  - "now" is bundle.collectedAt, never Date.now().
 *  - Funders are de-duplicated by (hop, address) and sorted before scoring so input order is irrelevant.
 *  - Reasons are sorted (weight desc, code asc) so the output is byte-stable for hashing.
 */
import type { Address, AddressFacts, EvidenceBundle, FunderHop, Reason, ReasonCode, SanctionsHit } from "../types";

/** Points per signal. Exported so the UI / docs can render the rulebook. */
export const WEIGHTS: Record<ReasonCode, number> = {
  SANCTIONS_DIRECT: 100,
  USDC_BLACKLISTED: 100,
  PROTOCOL_BLOCKLISTED: 100,
  FUNDER_1HOP_SANCTIONED: 30,
  FUNDER_2HOP_SANCTIONED: 15,
  FUNDER_1HOP_BLACKLISTED: 30,
  FUNDER_2HOP_BLACKLISTED: 15,
  FRESH_WALLET: 8,
  NO_HISTORY: 10,
  LOOKALIKE_OF_KNOWN_PAYEE: 25,
  PAYEE_ADDRESS_CHANGED: 15,
  HIGH_CONCENTRATION: 10,
  PRIOR_HIGH_TIER: 20,
  COMMUNITY_TIP_VERIFIED: 15, // a staked, agent-verified community tip (src/lib/tips)
  NETWORK_HELD_ELSEWHERE: 20, // ≥2 distinct other clients rated HIGH in 7 d; a single one scores NETWORK_HELD_ELSEWHERE_SINGLE_WEIGHT
  NETWORK_SHARED_FUNDER: 8, // shares a hop-1 funder with ≥ NETWORK_SHARED_FUNDER_MIN_PAYEES of the client's own payees
  AGENT_REGISTERED: -5, // positive: subject owns / is the wallet of an ERC-8004 agent on Arc (src/lib/erc8004); total is clamped ≥ 0
  AGENT_VALIDATED: -5, // positive: ≥1 answered validation from a non-self validator in the ValidationRegistry
  AGENT_DISPUTED: 15, // negative feedback / failed validation / dispute tag on the agent
  INBOUND_FLAGGED: 20, // received bridged USDC (CCTP) from a sanctioned / blacklisted source-chain sender in the last INBOUND_FLAGGED_LOOKBACK_DAYS
  CLEAN: 0,
};

/** INBOUND_FLAGGED lookback (EvidenceBundle.inbound is already windowed by src/lib/cctp; this is the rule's own cap). */
export const INBOUND_FLAGGED_LOOKBACK_DAYS = 30;

/** NETWORK_HELD_ELSEWHERE: exactly one other client → 10; two or more → WEIGHTS.NETWORK_HELD_ELSEWHERE (20). */
export const NETWORK_HELD_ELSEWHERE_SINGLE_WEIGHT = 10;
/** NETWORK_SHARED_FUNDER fires at this many of the client's own payees sharing a funder with the subject. */
export const NETWORK_SHARED_FUNDER_MIN_PAYEES = 3;

/** Any of these forces the score to at least HARD_HIT_FLOOR (bottom of the HIGH band). */
export const HARD_HIT_CODES: readonly ReasonCode[] = ["SANCTIONS_DIRECT", "USDC_BLACKLISTED", "PROTOCOL_BLOCKLISTED"];
export const HARD_HIT_FLOOR = 61;

/** Diminishing returns for repeated funder hits at the same hop: 1st 100%, 2nd 50%, 3rd 25%, ... */
export const FUNDER_STACK_DECAY = 0.5;

/** FRESH_WALLET thresholds (types.ts: "first seen < 7 days or < 5 txs"). */
export const FRESH_WALLET_MAX_AGE_SECONDS = 7 * 86_400;
export const FRESH_WALLET_MAX_TX_COUNT = 5;

/** PRIOR_HIGH_TIER lookback (types.ts: "was HIGH within last 30 days"). */
export const PRIOR_HIGH_TIER_LOOKBACK_SECONDS = 30 * 86_400;

/**
 * Sanctions hits matched on *name* need this matcher confidence to count; address matches always count.
 * (A low-confidence fuzzy name match must not produce a 100-point hit.)
 */
export const SANCTIONS_NAME_MIN_CONFIDENCE = 0.7;

export const MIN_SCORE = 0;
export const MAX_SCORE = 100;

export interface ScoreResult {
  score: number;
  reasons: Reason[];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const iso = (unix: number | null | undefined) => (unix == null ? null : new Date(unix * 1000).toISOString());

export function effectiveSanctions(hits: SanctionsHit[]): SanctionsHit[] {
  return hits
    .filter((h) => h.matchedOn === "address" || h.score >= SANCTIONS_NAME_MIN_CONFIDENCE)
    .slice()
    .sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId));
}

function sanctionsEvidence(hits: SanctionsHit[]) {
  return hits.map((h) => ({
    source: h.source,
    entityId: h.entityId,
    caption: h.caption,
    datasets: [...h.datasets].sort(),
    confidence: h.score,
    matchedOn: h.matchedOn,
  }));
}

function pathEvidence(path: FunderHop[]) {
  const sorted = [...path].sort((a, b) => a.timestamp - b.timestamp || a.txHash.localeCompare(b.txHash));
  const addresses: Address[] = [];
  for (const hop of sorted) {
    if (addresses[addresses.length - 1] !== hop.from) addresses.push(hop.from);
    addresses.push(hop.to);
  }
  return {
    path: addresses,
    txs: sorted.map((h) => h.txHash),
    transfers: sorted.map((h) => ({
      from: h.from,
      to: h.to,
      txHash: h.txHash,
      amountUsdc: h.amountUsdc,
      timestamp: h.timestamp,
      at: iso(h.timestamp),
    })),
  };
}

/** Weight of the i-th (0-based) hit at the same hop/signal, with diminishing returns. */
export function stackedWeight(base: number, index: number): number {
  return Math.round(base * Math.pow(FUNDER_STACK_DECAY, index));
}

function clamp(n: number): number {
  return Math.min(MAX_SCORE, Math.max(MIN_SCORE, Math.round(n)));
}

type FunderEntry = EvidenceBundle["funders"][number];

function dedupeAndSortFunders(funders: FunderEntry[]): FunderEntry[] {
  const seen = new Map<string, FunderEntry>();
  for (const f of funders) {
    const key = `${f.hop}:${f.facts.address.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()].sort(
    (a, b) => a.hop - b.hop || a.facts.address.toLowerCase().localeCompare(b.facts.address.toLowerCase()),
  );
}

function isBlacklisted(f: AddressFacts): boolean {
  return f.usdcBlacklisted || f.protocolBlocklisted;
}

// ─── main ────────────────────────────────────────────────────────────────────

export function scoreEvidence(bundle: EvidenceBundle): ScoreResult {
  const reasons: Reason[] = [];
  const now = bundle.collectedAt;
  const subj = bundle.subject;

  // 1. Direct hits on the subject
  const directSanctions = effectiveSanctions(subj.sanctions ?? []);
  if (directSanctions.length > 0) {
    reasons.push({
      code: "SANCTIONS_DIRECT",
      weight: WEIGHTS.SANCTIONS_DIRECT,
      evidence: { address: subj.address, hits: sanctionsEvidence(directSanctions), checkedAt: iso(now) },
    });
  }
  if (subj.usdcBlacklisted) {
    reasons.push({
      code: "USDC_BLACKLISTED",
      weight: WEIGHTS.USDC_BLACKLISTED,
      evidence: { address: subj.address, source: "FiatTokenV2.isBlacklisted", checkedAt: iso(now) },
    });
  }
  if (subj.protocolBlocklisted) {
    reasons.push({
      code: "PROTOCOL_BLOCKLISTED",
      weight: WEIGHTS.PROTOCOL_BLOCKLISTED,
      evidence: { address: subj.address, source: "Arc protocol blocklist", checkedAt: iso(now) },
    });
  }

  // 2. Funder graph (hop 1 / hop 2), stacking with diminishing returns per (hop, signal)
  const funders = dedupeAndSortFunders(bundle.funders ?? []);
  const groups: Record<"SANCTIONED" | "BLACKLISTED", Record<1 | 2, { hits: Record<string, unknown>[]; total: number }>> = {
    SANCTIONED: { 1: { hits: [], total: 0 }, 2: { hits: [], total: 0 } },
    BLACKLISTED: { 1: { hits: [], total: 0 }, 2: { hits: [], total: 0 } },
  };
  for (const f of funders) {
    const sanc = effectiveSanctions(f.facts.sanctions ?? []);
    const pe = pathEvidence(f.path);
    if (sanc.length > 0) {
      const g = groups.SANCTIONED[f.hop];
      const base = f.hop === 1 ? WEIGHTS.FUNDER_1HOP_SANCTIONED : WEIGHTS.FUNDER_2HOP_SANCTIONED;
      const w = stackedWeight(base, g.hits.length);
      g.total += w;
      g.hits.push({ funder: f.facts.address, hop: f.hop, weight: w, ...pe, sanctions: sanctionsEvidence(sanc) });
    }
    if (isBlacklisted(f.facts)) {
      const g = groups.BLACKLISTED[f.hop];
      const base = f.hop === 1 ? WEIGHTS.FUNDER_1HOP_BLACKLISTED : WEIGHTS.FUNDER_2HOP_BLACKLISTED;
      const w = stackedWeight(base, g.hits.length);
      g.total += w;
      g.hits.push({
        funder: f.facts.address,
        hop: f.hop,
        weight: w,
        ...pe,
        usdcBlacklisted: f.facts.usdcBlacklisted,
        protocolBlocklisted: f.facts.protocolBlocklisted,
      });
    }
  }
  const funderCode = (signal: "SANCTIONED" | "BLACKLISTED", hop: 1 | 2): ReasonCode =>
    `FUNDER_${hop}HOP_${signal}` as ReasonCode;
  for (const signal of ["SANCTIONED", "BLACKLISTED"] as const) {
    for (const hop of [1, 2] as const) {
      const g = groups[signal][hop];
      if (g.hits.length === 0) continue;
      reasons.push({
        code: funderCode(signal, hop),
        weight: g.total,
        evidence: { hop, count: g.hits.length, hits: g.hits, stacking: `1st 100%, then x${FUNDER_STACK_DECAY} per extra hit` },
      });
    }
  }

  // 3. Wallet age / footprint (NO_HISTORY takes precedence over FRESH_WALLET)
  if (subj.firstSeen == null && subj.txCount === 0) {
    reasons.push({
      code: "NO_HISTORY",
      weight: WEIGHTS.NO_HISTORY,
      evidence: { address: subj.address, firstSeen: null, txCount: 0, checkedAt: iso(now) },
    });
  } else {
    const age = subj.firstSeen == null ? null : now - subj.firstSeen;
    const young = age != null && age < FRESH_WALLET_MAX_AGE_SECONDS;
    const fewTxs = subj.txCount < FRESH_WALLET_MAX_TX_COUNT;
    if (young || fewTxs) {
      reasons.push({
        code: "FRESH_WALLET",
        weight: WEIGHTS.FRESH_WALLET,
        evidence: {
          address: subj.address,
          firstSeen: iso(subj.firstSeen),
          firstSeenUnix: subj.firstSeen,
          ageSeconds: age,
          txCount: subj.txCount,
          triggers: { youngerThan7d: young, fewerThan5Txs: fewTxs },
        },
      });
    }
  }

  // 4. Client payee-book signals
  if (bundle.lookalikes && bundle.lookalikes.length > 0) {
    const matches = [...bundle.lookalikes].sort(
      (a, b) => b.similarity - a.similarity || a.payeeAddress.localeCompare(b.payeeAddress),
    );
    reasons.push({
      code: "LOOKALIKE_OF_KNOWN_PAYEE",
      weight: WEIGHTS.LOOKALIKE_OF_KNOWN_PAYEE,
      evidence: {
        subject: subj.address,
        matches: matches.map((m) => ({ payeeLabel: m.payeeLabel, payeeAddress: m.payeeAddress, similarity: m.similarity })),
        hint: "Possible address poisoning: subject resembles a payee already in your book",
      },
    });
  }
  if (bundle.payeeChanged) {
    reasons.push({
      code: "PAYEE_ADDRESS_CHANGED",
      weight: WEIGHTS.PAYEE_ADDRESS_CHANGED,
      evidence: {
        payeeLabel: bundle.payeeChanged.payeeLabel,
        previousAddress: bundle.payeeChanged.previousAddress,
        newAddress: subj.address,
      },
    });
  }
  if (bundle.concentration && bundle.concentration.otherPayees > 0) {
    reasons.push({
      code: "HIGH_CONCENTRATION",
      weight: WEIGHTS.HIGH_CONCENTRATION,
      evidence: { sharedFunder: bundle.concentration.sharedFunder, otherPayees: bundle.concentration.otherPayees },
    });
  }

  // 5. Our own history
  if (bundle.priorTier && bundle.priorTier.tier === "HIGH" && now - bundle.priorTier.at <= PRIOR_HIGH_TIER_LOOKBACK_SECONDS) {
    reasons.push({
      code: "PRIOR_HIGH_TIER",
      weight: WEIGHTS.PRIOR_HIGH_TIER,
      evidence: { tier: bundle.priorTier.tier, at: iso(bundle.priorTier.at), atUnix: bundle.priorTier.at },
    });
  }

  // 5a. Verified community tips (tip market). Evidence: ids/categories/strength only.
  if (bundle.communityTips?.length) {
    reasons.push({
      code: "COMMUNITY_TIP_VERIFIED",
      weight: WEIGHTS.COMMUNITY_TIP_VERIFIED,
      evidence: { count: bundle.communityTips.length, tips: bundle.communityTips.map((t) => ({ tipId: t.tipId, category: t.category, strength: t.strength, verifiedAt: iso(t.verifiedAt) })) },
    });
  }

  // 5b. Network signals (shared-oracle; src/lib/network). Evidence carries counts only - never another client's id.
  const net = bundle.network;
  if (net && net.heldElsewhere.clients > 0) {
    const many = net.heldElsewhere.clients >= 2;
    reasons.push({
      code: "NETWORK_HELD_ELSEWHERE",
      weight: many ? WEIGHTS.NETWORK_HELD_ELSEWHERE : NETWORK_HELD_ELSEWHERE_SINGLE_WEIGHT,
      evidence: {
        otherClients: net.heldElsewhere.clients,
        lastAt: iso(net.heldElsewhere.lastAt),
        windowDays: net.windowDays,
        anonymised: true,
        hint: `rated HIGH by ${net.heldElsewhere.clients} other integrator${many ? "s" : ""} on CompliR in the last ${net.windowDays} days`,
      },
    });
  }
  if (net && net.sharedFunder.count >= NETWORK_SHARED_FUNDER_MIN_PAYEES && net.sharedFunder.funder) {
    reasons.push({
      code: "NETWORK_SHARED_FUNDER",
      weight: WEIGHTS.NETWORK_SHARED_FUNDER,
      evidence: {
        sharedFunder: net.sharedFunder.funder,
        yourPayees: net.sharedFunder.count,
        hint: `shares hop-1 funder with ${net.sharedFunder.count} of your own payees`,
      },
    });
  }

  // 5c. ERC-8004 agent identity (src/lib/erc8004). Evidence carries agentId + registry addresses (all public on-chain data).
  const agent = bundle.agent;
  if (agent?.registered) {
    const agentEvidence = {
      agentId: agent.agentId, role: agent.role, agentURI: agent.agentURI, owner: agent.owner, agentWallet: agent.agentWallet,
      registries: agent.registries, indexPending: agent.indexPending ?? false,
    };
    reasons.push({
      code: "AGENT_REGISTERED",
      weight: WEIGHTS.AGENT_REGISTERED,
      evidence: { ...agentEvidence, reputation: agent.reputation, validations: agent.validations ? { count: agent.validations.count, responded: agent.validations.responded, nonSelf: agent.validations.nonSelf } : null, checkedAt: iso(now) },
    });
    if (agent.validations && agent.validations.nonSelf > 0) {
      reasons.push({
        code: "AGENT_VALIDATED",
        weight: WEIGHTS.AGENT_VALIDATED,
        evidence: { agentId: agent.agentId, registry: agent.registries.validation, validators: [...agent.validations.validators].sort(), responded: agent.validations.responded, nonSelf: agent.validations.nonSelf, last: agent.validations.last ? { ...agent.validations.last, at: iso(agent.validations.last.at) } : null },
      });
    }
    if (agent.disputes.length > 0) {
      const disputes = [...agent.disputes].sort((a, b) => a.source.localeCompare(b.source) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
      reasons.push({
        code: "AGENT_DISPUTED",
        weight: WEIGHTS.AGENT_DISPUTED,
        evidence: { agentId: agent.agentId, registries: { reputation: agent.registries.reputation, validation: agent.registries.validation }, count: disputes.length, disputes, negativeFeedback: agent.reputation?.negative ?? 0, failedValidations: agent.validations?.failed ?? 0 },
      });
    }
  }

  // 5d. CCTP inbound from a flagged source-chain sender (src/lib/cctp). Counts + source chains only; the sender itself stays in cctp_inbound.
  const inbound = bundle.inbound;
  if (inbound && inbound.flaggedCount > 0 && (inbound.lastAt == null || now - inbound.lastAt <= INBOUND_FLAGGED_LOOKBACK_DAYS * 86_400)) {
    reasons.push({
      code: "INBOUND_FLAGGED",
      weight: WEIGHTS.INBOUND_FLAGGED,
      evidence: { flaggedMints: inbound.flaggedCount, lastAt: iso(inbound.lastAt), sources: [...inbound.sources].sort(), windowDays: inbound.windowDays, hint: "received bridged USDC via CCTP from a sanctioned or USDC-blacklisted source-chain wallet; see /api/v1/inbound/{address}" },
    });
  }

  // 6. Aggregate
  if (reasons.length === 0) {
    return {
      score: 0,
      reasons: [
        {
          code: "CLEAN",
          weight: 0,
          evidence: { address: subj.address, depth: bundle.depth, fundersChecked: funders.length, checkedAt: iso(now) },
        },
      ],
    };
  }
  let score = clamp(reasons.reduce((s, r) => s + r.weight, 0));
  if (reasons.some((r) => HARD_HIT_CODES.includes(r.code))) score = Math.max(score, HARD_HIT_FLOOR);
  reasons.sort((a, b) => b.weight - a.weight || a.code.localeCompare(b.code));
  return { score, reasons };
}
