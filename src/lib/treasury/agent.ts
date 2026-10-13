/**
 * Treasury agent: pays pending invoices on Arc, but every payout goes through CompliR.
 *
 *   invoice → screen(payee) → decidePayout(policy) → [LIVE] GuardedTreasury.release(payee, amount) → ledger "PAYOUT"
 *
 * Modes (env, see treasuryStatus()):
 *   dry-run (default)  - screens, decides, records; txHash = null ("simulated"). No key needed.
 *   live               - TREASURY_MODE=live + TREASURY_PRIVATE_KEY + GUARDED_TREASURY_ADDRESS + REGISTRY_ADDRESS.
 *                        The attestation is mirrored to the registry first (awaited), then `release` is simulated and
 *                        sent; nonces are serialised in-process; the receipt is awaited (Arc finality is deterministic).
 */
import { createPublicClient, createWalletClient, http, parseUnits, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcChain, registryEnabled, writeAttestationToRegistry } from "../chain/registryWriter";
import { config } from "../config";
import { guardedTreasuryAbi, registryAbi } from "../contracts";
import { appendDecision } from "../ledger";
import { screen } from "../pipeline";
import { TIER_ONCHAIN, type Address, type Tier, type Verdict } from "../types";
import { addSpend, migrateTreasury, payeeBook, pendingInvoices, seedDemoInvoices, settleInvoice, spentToday, type Invoice, type InvoiceStatus } from "./invoices";
import { decidePayout, policyFromEnv, round6, type OnChainAttestation, type PayoutDecision, type TreasuryPolicy } from "./policy";

export type TreasuryMode = "dry-run" | "live";
export const TREASURY_CLIENT_ID = "treasury-agent";

export interface TreasuryStatus {
  mode: TreasuryMode;
  chainId: number;
  explorerUrl: string;
  treasuryAddress: Address | null;
  agentAddress: Address | null;
  registryAddress: Address | null;
  usdcAddress: Address;
  policy: TreasuryPolicy;
  /** what is still missing before TREASURY_MODE=live takes effect */
  missingForLive: string[];
}

function liveEnv() {
  const e = process.env;
  const missing: string[] = [];
  if ((e.TREASURY_MODE ?? "").toLowerCase() !== "live") missing.push("TREASURY_MODE=live");
  if (!/^0x[0-9a-fA-F]{64}$/.test(e.TREASURY_PRIVATE_KEY ?? "")) missing.push("TREASURY_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{40}$/.test(e.GUARDED_TREASURY_ADDRESS ?? "")) missing.push("GUARDED_TREASURY_ADDRESS");
  if (!/^0x[0-9a-fA-F]{40}$/.test(e.REGISTRY_ADDRESS ?? "")) missing.push("REGISTRY_ADDRESS");
  return { missing, key: e.TREASURY_PRIVATE_KEY as `0x${string}` | undefined, treasury: e.GUARDED_TREASURY_ADDRESS?.toLowerCase() as Address | undefined };
}

export function treasuryMode(): TreasuryMode {
  return liveEnv().missing.length === 0 ? "live" : "dry-run";
}

export function treasuryStatus(): TreasuryStatus {
  const c = config();
  const le = liveEnv();
  const mode: TreasuryMode = le.missing.length === 0 ? "live" : "dry-run";
  let agent: Address | null = null;
  if (le.key && /^0x[0-9a-fA-F]{64}$/.test(le.key)) {
    try { agent = privateKeyToAccount(le.key).address.toLowerCase() as Address; } catch { agent = null; }
  }
  return {
    mode, chainId: c.ARC_CHAIN_ID, explorerUrl: c.ARC_EXPLORER_URL,
    treasuryAddress: le.treasury ?? null, agentAddress: agent,
    registryAddress: (c.REGISTRY_ADDRESS?.toLowerCase() as Address | undefined) ?? null, usdcAddress: c.USDC_ADDRESS.toLowerCase() as Address,
    policy: policyFromEnv(process.env, mode === "live"), missingForLive: le.missing,
  };
}

/** Migrate + seed the demo invoices (idempotent). Called by the routes and the tick. */
export async function ensureTreasury(): Promise<void> {
  await migrateTreasury();
  await seedDemoInvoices();
}

// ── on-chain helpers (live mode only) ────────────────────────────────────────
function clients(key: `0x${string}`) {
  const c = config();
  const account = privateKeyToAccount(key);
  const chain = arcChain();
  return {
    account,
    wallet: createWalletClient({ account, chain, transport: http(c.ARC_RPC_URL) }),
    pub: createPublicClient({ chain, transport: http(c.ARC_RPC_URL) }),
  };
}

export async function readRegistryAttestation(payee: Address): Promise<OnChainAttestation | null> {
  const c = config();
  if (!c.REGISTRY_ADDRESS) return null;
  const pub = createPublicClient({ chain: arcChain(), transport: http(c.ARC_RPC_URL, { timeout: 8_000 }) });
  const [tier, validUntil] = await pub.readContract({ address: c.REGISTRY_ADDRESS as Address, abi: registryAbi as unknown as Abi, functionName: "tierOf", args: [payee] }) as readonly [number, bigint, `0x${string}`];
  return { tier: Number(tier), validUntil: Number(validUntil) };
}

export interface Executor {
  (payee: Address, amountUsdc: number, ctx: { invoice: Invoice; verdict: Verdict; decision: PayoutDecision }): Promise<`0x${string}` | null>;
}

let lastTx: Promise<unknown> = Promise.resolve(); // serialise nonces (one treasury key per process)
/** LIVE executor: simulate `release` (surfaces "CompliR: payee tier too high" without gas), send, wait for the receipt. */
export const liveExecutor: Executor = (payee, amountUsdc) => {
  const le = liveEnv();
  if (le.missing.length || !le.key || !le.treasury) throw new Error(`treasury not live: missing ${le.missing.join(", ")}`);
  const { account, wallet, pub } = clients(le.key);
  const amount6 = parseUnits(amountUsdc.toFixed(6), 6);
  const run = async () => {
    const { request } = await pub.simulateContract({ account, address: le.treasury!, abi: guardedTreasuryAbi, functionName: "release", args: [payee, amount6] });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") throw new Error(`release reverted on-chain (tx ${hash})`);
    return hash;
  };
  const p = lastTx.then(run, run);
  lastTx = p.catch(() => undefined);
  return p;
};
/** DRY-RUN executor: nothing leaves the process; txHash is null ("simulated"). */
export const dryRunExecutor: Executor = async () => null;

// ── the tick ─────────────────────────────────────────────────────────────────
export interface PayoutResult {
  invoiceId: string;
  label: string;
  payee: Address;
  status: InvoiceStatus;
  action: PayoutDecision["action"] | null;
  tier: Tier | null;
  score: number | null;
  amountUsdc: number;
  paidUsdc: number;
  heldUsdc: number;
  txHash: `0x${string}` | null;
  decisionId: string | null;
  payoutDecisionId: string | null;
  reason: string;
}
export interface TickResult {
  mode: TreasuryMode;
  processed: number;
  paid: number;
  limited: number;
  held: number;
  failed: number;
  results: PayoutResult[];
}
export interface TickOptions {
  /** injected for tests */
  screenFn?: typeof screen;
  executor?: Executor;
  policy?: TreasuryPolicy;
  now?: number;
  /** skip the demo seed (tests) */
  seed?: boolean;
}

export async function runTreasuryOnce(opts: TickOptions = {}): Promise<TickResult> {
  const cfg = config();
  const mode = treasuryMode();
  const result: TickResult = { mode, processed: 0, paid: 0, limited: 0, held: 0, failed: 0, results: [] };
  if (cfg.COMPLIR_PAUSED) return result;
  if (opts.seed === false) await migrateTreasury(); else await ensureTreasury();

  const policy = opts.policy ?? policyFromEnv(process.env, mode === "live");
  const doScreen = opts.screenFn ?? screen;
  const execute = opts.executor ?? (mode === "live" ? liveExecutor : dryRunExecutor);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const pending = await pendingInvoices();
  if (!pending.length) return result;
  let spent = await spentToday(now);
  const treasuryAddr = treasuryStatus().treasuryAddress;

  for (const inv of pending) {
    result.processed++;
    let verdict: Verdict | null = null;
    let decision: PayoutDecision | null = null;
    let txHash: `0x${string}` | null = null;
    let status: InvoiceStatus;
    let reason: string;
    let error: string | null = null;
    try {
      // 1. screen the payee (CompliR verdict: deterministic score/tier + analyst rationale + signed attestation)
      //    payee book = trusted (previously paid) payees, so a new address that merely resembles one is flagged as a
      //    lookalike; a payee already in the book is judged on sanctions / blacklist / funder taint, not on resembling itself
      const book = await payeeBook(); // refreshed per invoice: a payee paid earlier in this tick is already trusted
      const known = book.some((p) => p.address === inv.payee);
      verdict = await doScreen({ address: inv.payee, amountUsdc: inv.amountUsdc, clientId: TREASURY_CLIENT_ID, payeeBook: known ? undefined : book }, { writeOnChain: false });

      // 2. live: mirror the attestation on-chain first (GuardedTreasury reads the registry, not our DB)
      let onChain: OnChainAttestation | null = null;
      if (mode === "live") {
        if (registryEnabled()) {
          try { const tx = await writeAttestationToRegistry(verdict); if (tx) verdict.attestation.registryTx = tx; }
          catch (e) { console.warn("[treasury] registry write failed:", (e as Error)?.message); }
        }
        try { onChain = await readRegistryAttestation(inv.payee); }
        catch (e) { console.warn("[treasury] registry read failed:", (e as Error)?.message); onChain = null; }
      }

      // 3. policy
      decision = decidePayout({ amountUsdc: inv.amountUsdc }, verdict, policy, spent, { onChain, now });
      reason = decision.reason;

      // 4. execute (PAY / LIMIT release the decided amount; HOLD releases nothing)
      if (decision.action !== "HOLD" && decision.amount > 0) {
        txHash = await execute(inv.payee, decision.amount, { invoice: inv, verdict, decision });
        spent = round6(spent + decision.amount);
        await addSpend(decision.amount, now);
        status = decision.action === "PAY" ? "PAID" : "LIMITED";
      } else {
        status = "HELD";
      }
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
      status = "FAILED";
      reason = `FAILED: ${error}${decision ? ` - intended ${decision.action} ${decision.amount} USDC. ${decision.reason}` : ""}`;
      console.warn("[treasury] invoice", inv.id, "failed:", error);
    }

    // 5. ledger: every decision, including HOLD and FAILED, with the verdict's decisionId + the signed attestation
    const paidUsdc = status === "PAID" || status === "LIMITED" ? decision!.amount : 0;
    const heldUsdc = round6(inv.amountUsdc - paidUsdc);
    const payload = {
      type: "PAYOUT", invoiceId: inv.id, label: inv.label, payee: inv.payee, memo: inv.memo, amountUsdc: inv.amountUsdc,
      action: status === "FAILED" ? null : decision?.action ?? "HOLD", status, paidUsdc, heldUsdc, bound: decision?.bound ?? null, reason,
      mode, simulated: mode !== "live", txHash, treasury: treasuryAddr, policy, error,
      verdict: verdict ? {
        decisionId: verdict.decisionId, tier: verdict.tier, score: verdict.score, rationale: verdict.rationale,
        recommendedLimits: verdict.recommendedLimits, reasonCodes: verdict.reasons.map((r) => r.code), screenedAt: verdict.screenedAt,
        attestation: { signature: verdict.attestation.signature, attester: verdict.attestation.attester, validUntil: verdict.attestation.validUntil, registryTx: verdict.attestation.registryTx },
      } : null,
      decidedAt: now,
    };
    const entry = await appendDecision({ kind: "PAYOUT", subject: inv.payee, clientId: TREASURY_CLIENT_ID, payload });

    await settleInvoice(inv.id, {
      status, decisionId: verdict?.decisionId ?? null, payoutDecisionId: entry.id, txHash, paidUsdc, heldUsdc,
      action: status === "FAILED" ? null : decision?.action ?? "HOLD", tier: verdict?.tier ?? null, score: verdict?.score ?? null, reason, mode,
    });

    if (status === "PAID") result.paid++; else if (status === "LIMITED") result.limited++; else if (status === "HELD") result.held++; else result.failed++;
    result.results.push({
      invoiceId: inv.id, label: inv.label, payee: inv.payee, status, action: status === "FAILED" ? null : decision?.action ?? "HOLD",
      tier: verdict?.tier ?? null, score: verdict?.score ?? null, amountUsdc: inv.amountUsdc, paidUsdc, heldUsdc, txHash,
      decisionId: verdict?.decisionId ?? null, payoutDecisionId: entry.id, reason,
    });
  }
  return result;
}

/** numeric on-chain tier for the policy's maxTier (what `release` passes to `isAllowed`) */
export function policyMaxTierOnChain(policy: TreasuryPolicy): number {
  return TIER_ONCHAIN[policy.maxTier];
}
