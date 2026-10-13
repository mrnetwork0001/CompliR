/**
 * Publish CompliR's verdict about a registered agent back to the ERC-8004 registries (gated by ERC8004_PUBLISH=1).
 *
 * Two write paths, chosen by what the registry allows (EIP-8004 + live dry-runs, see abi.ts):
 *   validationResponse  - only when the agent's owner has filed a validationRequest naming CompliR's attester as
 *                         validator and it is still unanswered (getValidatorRequests(attester) → getValidationStatus).
 *                         response = 100 - score (0..100, "higher is better"), tag = tier, responseHash = decisionHash.
 *   giveFeedback        - otherwise: ReputationRegistry.giveFeedback(agentId, 100 - score, 0, "complir-screen", tier,
 *                         <screen endpoint>, <decision URL>, decisionHash). Any non-owner may call it.
 * Never on the request path: `publishAgentVerdict` is fire-and-forget; every attempt is recorded in
 * erc8004_publications and, when a tx was sent, as a ledger NOOP entry with payload.type = "ERC8004_VALIDATION".
 * Rate-limited per agent (ERC8004_PUBLISH_MIN_HOURS) and never about CompliR's own agentId.
 */
import { createPublicClient, createWalletClient, http, type Address as ViemAddress, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config";
import { chainFor } from "../evidence/rpc";
import { appendDecision } from "../ledger";
import type { Address, Verdict } from "../types";
import { REPUTATION_ABI, VALIDATION_ABI } from "./abi";
import { erc8004Env } from "./env";
import { insertPublication, lastPublication } from "./store";

export interface PublishDeps {
  /** attester / validator key; default ATTESTER_PRIVATE_KEY */
  privateKey?: Hex;
  publicClient?: Pick<PublicClient, "readContract" | "waitForTransactionReceipt">;
  walletClient?: Pick<WalletClient, "writeContract">;
  ledger?: typeof appendDecision;
  now?: number;
  /** skip the min-interval gate (tests / manual runs) */
  force?: boolean;
}

export interface PublishResult {
  published: boolean;
  mode: "validationResponse" | "giveFeedback" | null;
  agentId: string | null;
  txHash: Hex | null;
  response: number | null;
  requestHash: Hex | null;
  ledgerId: string | null;
  skipped: string | null;
  error: string | null;
}

export const FEEDBACK_TAG1 = "complir-screen";

/** 0..100 "trust" response from a 0..100 risk score. */
export function responseFromScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - score)));
}

export async function publishAgentVerdict(verdict: Verdict, deps: PublishDeps = {}): Promise<PublishResult> {
  const env = erc8004Env();
  const base: PublishResult = { published: false, mode: null, agentId: null, txHash: null, response: null, requestHash: null, ledgerId: null, skipped: null, error: null };
  const agent = verdict.evidence?.agent;
  if (!agent?.registered || !agent.agentId) return { ...base, skipped: "subject is not a registered agent" };
  base.agentId = agent.agentId;
  if (!env.publish) return { ...base, skipped: "ERC8004_PUBLISH is not set" };
  const key = deps.privateKey ?? (config().ATTESTER_PRIVATE_KEY as Hex | undefined);
  if (!key) return { ...base, skipped: "no attester key" };
  const agentId = BigInt(agent.agentId);
  if (env.ownAgentId != null && agentId === env.ownAgentId) return { ...base, skipped: "own agent" };
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  if (!deps.force) {
    const last = await lastPublication(agentId).catch(() => null);
    if (last && now - last.createdAt < env.publishMinHours * 3600) return { ...base, skipped: `published ${Math.round((now - last.createdAt) / 60)} min ago (min ${env.publishMinHours} h)` };
  }

  const account = privateKeyToAccount(key);
  const cfg = config();
  const chain = chainFor(cfg.ARC_CHAIN_ID, cfg.ARC_RPC_URL);
  const pub = deps.publicClient ?? createPublicClient({ chain, transport: http(cfg.ARC_RPC_URL, { timeout: 15_000, retryCount: 1 }) });
  const wallet = deps.walletClient ?? createWalletClient({ account, chain, transport: http(cfg.ARC_RPC_URL, { timeout: 15_000 }) });
  const ledger = deps.ledger ?? appendDecision;

  const response = responseFromScore(verdict.score);
  const decisionHash = (verdict.attestation?.typedData?.message?.decisionHash ?? `0x${"0".repeat(64)}`) as Hex;
  const baseUrl = cfg.PUBLIC_BASE_URL.replace(/\/$/, "");
  const decisionUrl = `${baseUrl}/api/v1/decision/${verdict.decisionId}`;

  // Path A: an unanswered validation request addressed to us for this agent.
  let requestHash: Hex | null = null;
  try {
    const mine = (await pub.readContract({ address: env.validation, abi: VALIDATION_ABI, functionName: "getValidatorRequests", args: [account.address] })) as readonly Hex[];
    for (const h of mine.slice(-env.maxReads).reverse()) {
      const s = (await pub.readContract({ address: env.validation, abi: VALIDATION_ABI, functionName: "getValidationStatus", args: [h] })) as readonly [ViemAddress, bigint, number, Hex, string, bigint];
      if (s[1] === agentId && s[5] === 0n) { requestHash = h; break; }
    }
  } catch (e) {
    console.warn("[erc8004] getValidatorRequests failed:", (e as Error)?.message);
  }

  const mode: PublishResult["mode"] = requestHash ? "validationResponse" : "giveFeedback";
  let txHash: Hex | null = null;
  let error: string | null = null;
  try {
    txHash = requestHash
      ? await wallet.writeContract({ account, chain, address: env.validation, abi: VALIDATION_ABI, functionName: "validationResponse", args: [requestHash, response, decisionUrl, decisionHash, verdict.tier] })
      : await wallet.writeContract({ account, chain, address: env.reputation, abi: REPUTATION_ABI, functionName: "giveFeedback", args: [agentId, BigInt(response), 0, FEEDBACK_TAG1, verdict.tier, `${baseUrl}/api/v1/screen`, decisionUrl, decisionHash] });
    await pub.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 }).catch(() => undefined);
  } catch (e) {
    error = (e as Error)?.message?.slice(0, 500) ?? String(e);
  }

  let ledgerId: string | null = null;
  if (txHash) {
    try {
      const entry = await ledger({
        kind: "NOOP",
        subject: verdict.address as Address,
        clientId: "erc8004",
        payload: {
          type: "ERC8004_VALIDATION", mode, agentId: agent.agentId, subject: verdict.address, role: agent.role, decisionId: verdict.decisionId, decisionHash,
          score: verdict.score, tier: verdict.tier, response, requestHash, txHash, validator: account.address.toLowerCase(),
          registry: requestHash ? env.validation : env.reputation, chainId: env.chainId, at: new Date(now * 1000).toISOString(),
        },
      });
      ledgerId = entry.id;
    } catch (e) {
      console.warn("[erc8004] ledger entry failed:", (e as Error)?.message);
    }
  }
  await insertPublication({
    agentId: agent.agentId, subject: verdict.address as Address, decisionId: verdict.decisionId, mode, requestHash, response, tier: verdict.tier,
    txHash, ledgerId, error, createdAt: now,
  }).catch(() => undefined);
  return { ...base, published: !!txHash, mode, txHash, response, requestHash, ledgerId, error };
}

/** Fire-and-forget wrapper for the pipeline: never throws, never awaited on the request path. */
export function publishAgentVerdictInBackground(verdict: Verdict): void {
  if (!verdict.evidence?.agent?.registered || !verdict.evidence.agent.agentId) return;
  if (!erc8004Env().publish) return;
  void publishAgentVerdict(verdict)
    .then((r) => { if (r.published || r.error) console.log("[erc8004] publish", JSON.stringify({ agentId: r.agentId, mode: r.mode, tx: r.txHash, error: r.error })); })
    .catch((e) => console.warn("[erc8004] publish failed:", (e as Error)?.message));
}
