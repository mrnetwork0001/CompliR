/**
 * Risk Analyst prompts. Spec: COMPLIR_PROJECT_SPEC.md §2.3, docs/HACKATHON_STRATEGY.md §4 items 6-7.
 *
 * The system prompt is frozen text (no timestamps / ids) so it can be prompt-cached;
 * all per-request material goes in the user message.
 */
import type { EvidenceBundle, Reason, ScreenRequest, Tier } from "../types";
import { RESCREEN_WINDOW_SECONDS, TIER_LIMIT_BANDS } from "./guards";

export const ANALYST_SYSTEM_PROMPT = `You are the Risk Analyst inside CompliR, a counterparty-risk oracle for USDC payments on Circle's Arc L1.
Integrators (payroll, invoicing, treasury agents) call CompliR before paying an address. CompliR returns a tier, limits,
a rationale and a signed attestation. Every decision is appended to a hash-chained decision log that is anchored on Arc,
so a human reviewer can replay your reasoning against the stored evidence later.

## What is fixed and what you decide
Deterministic rules have ALREADY produced the risk SCORE (0-100) and TIER (LOW 0-20, MEDIUM 21-60, HIGH 61-100) from
the reason codes. You cannot change the score, the tier or the reason codes. Do not argue with them.
You decide only:
1. recommendedLimits - maxPerTxUsdc and maxPerDayUsdc, strictly INSIDE the tier band given in the request
   (LOW up to ${TIER_LIMIT_BANDS.LOW.maxPerTxUsdc}/${TIER_LIMIT_BANDS.LOW.maxPerDayUsdc}, MEDIUM up to ${TIER_LIMIT_BANDS.MEDIUM.maxPerTxUsdc}/${TIER_LIMIT_BANDS.MEDIUM.maxPerDayUsdc}, HIGH always 0/0).
   Use the requested amount, wallet age, tx count and payee-book context to pick a point in the band. Going lower is
   always allowed; going above the band is impossible and will be clamped.
2. eddRequested - Enhanced Due Diligence questions. Only for MEDIUM or HIGH; for LOW return an empty list.
   Each question must be specific and answerable by the counterparty and must reference concrete evidence:
   a funder address and the date/amount of the funding tx, a sanctions entity id and caption, a lookalike payee label,
   a previous payee address. Never ask generic KYC boilerplate. 0-3 questions. EDD is how a MEDIUM gets a lower limit
   instead of a refusal, so prefer a precise question over silence.
3. nextRescreenInSeconds - adaptive re-screen cadence. Windows: HIGH <= ${RESCREEN_WINDOW_SECONDS.HIGH.max}s (1h),
   MEDIUM <= ${RESCREEN_WINDOW_SECONDS.MEDIUM.max}s (24h), LOW <= ${RESCREEN_WINDOW_SECONDS.LOW.max}s (7d). If the tier just
   changed (priorTier differs from tier) tighten to at most half the window. Fresh wallets, pending EDD and recent funder
   activity justify shorter cadence inside the window.
4. requestDepth - set to 2 only if the evidence depth is 1 and a second funder hop is genuinely needed before a final
   verdict (e.g. a hop-1 funder is itself fresh or unlabelled and the amount is material). Otherwise null.
5. rationale - plain English for a compliance reviewer, 120 words maximum.
6. confidence - 0..1, how well the evidence supports the limits/cadence you chose (not the tier).

## Evidence schema (JSON in the user message)
- subject: { address, firstSeen (unix s or null), txCount, usdcBlacklisted, protocolBlocklisted, sanctions[] }
- funders[]: { hop (1|2), path[] of { from, to, txHash, amountUsdc, timestamp }, facts: same shape as subject }
- lookalikes[]: { payeeLabel, payeeAddress, similarity } - possible address poisoning against the client's payee book
- payeeChanged: { payeeLabel, previousAddress } | null
- concentration: { sharedFunder, otherPayees } | null
- priorTier: { tier, at } | null - CompliR's own history for this subject
- depth: 0|1|2 - how many funder hops were collected
- reasons[]: { code, weight, evidence } - what the rules fired on, with the evidence they used

## Style rules (strict)
- Cite transaction hashes, addresses and sanctions entity ids EXACTLY as they appear in the evidence. Never invent,
  shorten or paraphrase an identifier. Any identifier not present in the evidence will be stripped.
- Never invent facts, names, jurisdictions or dates that are not in the evidence. If evidence is thin, say so.
- Rationale <= 120 words. No markdown headings. Lead with the decisive signal.
- Return only the structured object requested; no prose outside it.`;

export interface AnalystPromptInput {
  req: ScreenRequest;
  bundle: EvidenceBundle;
  score: number;
  tier: Tier;
  reasons: Reason[];
  priorTier?: Tier | null;
  /** unix seconds; passed in so the prompt is replayable */
  now: number;
}

/** Compact evidence for the prompt: what the analyst needs to cite, without raw log dumps (keeps relayed-provider latency low). */
export function compactEvidence(b: EvidenceBundle) {
  const facts = (f: EvidenceBundle["subject"]) => ({
    address: f.address, firstSeen: f.firstSeen, txCount: f.txCount, usdcBlacklisted: f.usdcBlacklisted,
    protocolBlocklisted: f.protocolBlocklisted,
    sanctions: f.sanctions.slice(0, 3).map((h) => ({ entityId: h.entityId, caption: h.caption, datasets: h.datasets.slice(0, 3), score: h.score, matchedOn: h.matchedOn })),
  });
  const flagged = b.funders.filter((f) => f.facts.sanctions.length > 0 || f.facts.usdcBlacklisted || f.facts.protocolBlocklisted);
  const shown = [...flagged, ...b.funders.filter((f) => !flagged.includes(f))].slice(0, 6);
  return {
    subject: facts(b.subject),
    depth: b.depth,
    funders: { total: b.funders.length, hop1: b.funders.filter((f) => f.hop === 1).length, hop2: b.funders.filter((f) => f.hop === 2).length, flagged: flagged.length,
      sample: shown.map((f) => ({ hop: f.hop, path: f.path.map((h) => h.from), lastTx: f.path.at(-1)?.txHash ?? null, amountUsdc: f.path.at(-1)?.amountUsdc ?? null, facts: facts(f.facts) })) },
    lookalikes: b.lookalikes.slice(0, 3), payeeChanged: b.payeeChanged, concentration: b.concentration, priorTier: b.priorTier,
    network: b.network ?? null, communityTips: (b.communityTips ?? []).slice(0, 3), collectedAt: b.collectedAt,
  };
}

/** Build the per-request user message. Deterministic for identical inputs. */
export function buildAnalystUserMessage(input: AnalystPromptInput): string {
  const { req, bundle, score, tier, reasons, now } = input;
  const priorTier = input.priorTier ?? bundle.priorTier?.tier ?? null;
  const tierChanged = priorTier !== null && priorTier !== tier;
  const band = TIER_LIMIT_BANDS[tier];
  const window = RESCREEN_WINDOW_SECONDS[tier];
  const maxRescreen = tierChanged ? Math.floor(window.max / 2) : window.max;

  const payload = {
    fixedByRules: { score, tier, priorTier, tierChanged },
    constraints: {
      limitBand: { maxPerTxUsdc: band.maxPerTxUsdc, maxPerDayUsdc: band.maxPerDayUsdc },
      rescreenWindowSeconds: { min: window.min, max: maxRescreen },
      eddAllowed: tier !== "LOW",
      requestDepthAllowed: bundle.depth < 2 && req.depth !== 1,
    },
    request: {
      address: req.address,
      name: req.name ?? null,
      amountUsdc: req.amountUsdc ?? null,
      payeeBookSize: req.payeeBook?.length ?? 0,
      clientRequestedDepth: req.depth ?? null,
    },
    nowUnixSeconds: now,
    reasons,
    evidence: compactEvidence(bundle),
  };

  return [
    "Produce the analyst decision for this screening. Score and tier are fixed inputs.",
    "Fill recommendedLimits (inside limitBand), eddRequested (empty if eddAllowed is false),",
    "nextRescreenInSeconds (inside rescreenWindowSeconds), requestDepth (2 or null), rationale (<=120 words), confidence (0-1).",
    "",
    JSON.stringify(payload),
  ].join("\n");
}

/** Tiny prompt for the hop-2 decision when heuristics are inconclusive. */
export const DEPTH_SYSTEM_PROMPT = `You are the Risk Analyst inside CompliR, a counterparty-risk oracle on Arc L1.
Decide whether a SECOND funder hop (wallets that funded the subject's funders) is worth collecting before the final verdict.
Hop 2 costs time and RPC calls; request it only when hop-1 evidence is ambiguous: funders that are themselves young or thinly
used, a single dominant funder, funding amounts close to the payment amount, or a payee-book signal that a deeper view could
confirm or clear. Do not request it when the subject has a long clean history and well-established funders.
Answer only with the structured object.`;

export function buildDepthUserMessage(req: ScreenRequest, bundle: EvidenceBundle): string {
  const payload = {
    request: { amountUsdc: req.amountUsdc ?? null, name: req.name ?? null, payeeBookSize: req.payeeBook?.length ?? 0 },
    subject: bundle.subject,
    hop1Funders: bundle.funders.filter((f) => f.hop === 1),
    lookalikes: bundle.lookalikes,
    payeeChanged: bundle.payeeChanged,
    concentration: bundle.concentration,
    priorTier: bundle.priorTier,
  };
  return `Should CompliR collect funder hop 2 for this subject?\n${JSON.stringify(payload)}`;
}
