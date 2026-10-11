/**
 * Orchestrator: ScreenRequest → Evidence → Rules (score/tier) → Risk Analyst → EIP-712 attestation
 *               → decision log (hash chain) → store → optional on-chain registry write → Verdict.
 */
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { config } from "./config";
import { scoreEvidence } from "./scoring";
import { analyze, decideDepth } from "./analyst";
import { buildAttestationTypedData, signAttestation, decisionHash as hashDecision } from "./attest";
import { appendDecision } from "./ledger";
import { insertAttestation, recordScreening, priorTier as loadPriorTier, classifyPayer } from "./store";
import { writeAttestationToRegistry } from "./chain/registryWriter";
import { createEddRequest } from "./edd";
import { tierForScore, type Address, type PayeeBookEntry, type ScreenRequest, type Verdict } from "./types";

import { collectEvidence } from "./evidence";
type Collector = typeof collectEvidence;
async function getCollector(): Promise<Collector> { return collectEvidence; }

// ── attester key: real key from env, else one ephemeral dev key per process (signatures still verify) ──
let attesterKey: `0x${string}` | null = null;
export function attesterPrivateKey(): `0x${string}` {
  if (attesterKey) return attesterKey;
  const fromEnv = config().ATTESTER_PRIVATE_KEY as `0x${string}` | undefined;
  attesterKey = fromEnv ?? generatePrivateKey();
  if (!fromEnv) console.warn("[complir] ATTESTER_PRIVATE_KEY unset → using ephemeral dev attester", privateKeyToAccount(attesterKey).address);
  return attesterKey;
}
export function attesterAddress(): Address { return privateKeyToAccount(attesterPrivateKey()).address.toLowerCase() as Address; }

export class ServicePausedError extends Error { code = "SERVICE_PAUSED" as const; constructor() { super("CompliR is paused"); } }

export interface ScreenOptions { kind?: "SCREEN" | "RESCREEN"; previousBook?: PayeeBookEntry[]; writeOnChain?: boolean }

export async function screen(req: ScreenRequest, opts: ScreenOptions = {}): Promise<Verdict> {
  const cfg = config();
  if (cfg.COMPLIR_PAUSED) throw new ServicePausedError();
  const now = Math.floor(Date.now() / 1000);
  const collect = await getCollector();

  // 1. evidence (hop 1, then hop 2 if the depth heuristic or the analyst asks)
  const prior = await loadPriorTier(req.address, 30 * 86400);
  let bundle = await collect(req, { depth: 1, previousBook: opts.previousBook, priorTier: prior });
  const depth = decideDepth(req, bundle);
  if (depth === 2 && bundle.depth < 2) bundle = await collect(req, { depth: 2, previousBook: opts.previousBook, priorTier: prior });

  // 2. deterministic rules own score + tier
  let { score, reasons } = scoreEvidence(bundle);
  let tier = tierForScore(score);

  // 3. analyst decides limits / EDD / cadence / rationale (guard-railed); may ask for hop 2 once
  let analysis = await analyze({ req, bundle, score, tier, reasons, priorTier: prior?.tier ?? null, now });
  if (analysis.decision.requestDepth === 2 && bundle.depth < 2) {
    bundle = await collect(req, { depth: 2, previousBook: opts.previousBook, priorTier: prior });
    ({ score, reasons } = scoreEvidence(bundle));
    tier = tierForScore(score);
    analysis = await analyze({ req, bundle, score, tier, reasons, priorTier: prior?.tier ?? null, now });
  }
  const d = analysis.decision;

  // 4. decision hash over the replayable core
  const core = {
    address: req.address, score, tier, reasons, recommendedLimits: d.recommendedLimits, rationale: d.rationale,
    eddRequested: d.eddRequested, nextRescreenAt: d.nextRescreenAt, evidenceDepth: bundle.depth, collectedAt: bundle.collectedAt,
    analyst: analysis.meta, guards: analysis.guardNotes, screenedAt: now, priorTier: prior?.tier ?? null, clientId: req.clientId ?? null,
  };
  const dHash = hashDecision(core);

  // 5. EIP-712 attestation
  const typedData = buildAttestationTypedData({
    subject: req.address, tier, score, decisionHash: dHash, issuedAt: now, chainId: cfg.ARC_CHAIN_ID,
    verifyingContract: (cfg.REGISTRY_ADDRESS?.toLowerCase() ?? "0x0000000000000000000000000000000000000000") as Address,
  });
  const attestation = await signAttestation(typedData, attesterPrivateKey());

  // 6. append to the hash-chained decision log
  const entry = await appendDecision({ kind: opts.kind ?? "SCREEN", subject: req.address, clientId: req.clientId ?? null, payload: { ...core, decisionHash: dHash, attestation: { signature: attestation.signature, attester: attestation.attester, validUntil: attestation.validUntil } } });

  const verdict: Verdict = {
    address: req.address, score, tier, recommendedLimits: d.recommendedLimits, reasons, rationale: d.rationale,
    eddRequested: d.eddRequested, nextRescreenAt: new Date(d.nextRescreenAt * 1000).toISOString(), attestation,
    decisionId: entry.id, screenedAt: new Date(now * 1000).toISOString(), evidence: bundle,
  };

  // 7. persist + public feed
  await insertAttestation(verdict);
  await recordScreening(verdict, req.clientId ?? null, classifyPayer(req.clientId));

  // 7b. open an Enhanced Due Diligence request the payer can forward (not when this screen was itself triggered by an EDD answer)
  if (verdict.eddRequested.length > 0 && req.clientId !== "edd") {
    try {
      const edd = await createEddRequest({ subject: req.address, decisionId: entry.id, questions: verdict.eddRequested });
      verdict.edd = { id: edd.id, url: edd.url };
    } catch (e) { console.warn("[complir] edd request failed:", (e as Error)?.message); verdict.edd = null; }
  }

  // 8. mirror to AttestationRegistry on Arc (non-blocking; only when configured)
  if (opts.writeOnChain !== false) void writeAttestationToRegistry(verdict).catch((e) => console.warn("[complir] registry write failed:", e?.message ?? e));

  return verdict;
}
