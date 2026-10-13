/**
 * Tip payouts in USDC on Arc. Rail selection (first that applies):
 *   circle   Circle Developer-Controlled `revenue` wallet → `transferUsdc({ role: "revenue" })` (policy-checked, Gas
 *            Station-sponsored when a policy is active). Requires CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET.
 *   local    viem: ERC-20 `transfer(to, amount)` on the USDC interface from TIPS_PAYOUT_PRIVATE_KEY (pays its own gas).
 *   dry-run  nothing leaves the process; txHash null. Default without credentials.
 *
 * Circle Nanopayments (Gateway batched x402) is NOT a rail here: it is a buyer→x402-seller flow (the buyer signs
 * EIP-3009 authorizations against a Gateway deposit; the seller's middleware settles batches). There is no server-side
 * "push USDC to an arbitrary address" API and the SDK (@circle-fin/x402-batching) is not installed — see docs/TIPS.md.
 *
 * Slash = the stake was already settled to X402_PAY_TO by x402; we only record it (ledger "TIP"/SLASH) and update stats.
 * Daily cap: TIPS_DAILY_CAP_USDC (default 5). A VERIFIED tip beyond today's cap stays VERIFIED and is retried tomorrow.
 */
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcChain } from "../chain/registryWriter";
import { circleStatus } from "../circle/client";
import { transferUsdc } from "../circle/execute";
import { config } from "../config";
import type { Address } from "../types";
import { ANON_SUBMITTER, DEMO_SUBMITTER, addSpend, round6, spentToday, tipsEnv, type PayoutMode, type Tip } from "./model";

export const USDC_TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 value) returns (bool)"]);

export interface PayoutStatus {
  mode: PayoutMode;
  reason: string;
  payerAddress: Address | null;
  dailyCapUsdc: number;
  circleEnabled: boolean;
  localKey: boolean;
}

/** Which rail a payout would take right now (never throws). */
export function payoutStatus(): PayoutStatus {
  const env = tipsEnv();
  const cs = circleStatus();
  if (cs.enabled) return { mode: "circle", reason: `Circle ${cs.accountType} revenue wallet on ${cs.blockchain}`, payerAddress: null, dailyCapUsdc: env.dailyCapUsdc, circleEnabled: true, localKey: Boolean(env.payoutPrivateKey) };
  if (env.payoutPrivateKey) {
    let addr: Address | null = null;
    try { addr = privateKeyToAccount(env.payoutPrivateKey).address.toLowerCase() as Address; } catch { addr = null; }
    return { mode: "local", reason: "TIPS_PAYOUT_PRIVATE_KEY sends USDC via viem", payerAddress: addr, dailyCapUsdc: env.dailyCapUsdc, circleEnabled: false, localKey: true };
  }
  return { mode: "dry-run", reason: `${cs.reason ?? "Circle not configured"}; TIPS_PAYOUT_PRIVATE_KEY unset`, payerAddress: null, dailyCapUsdc: env.dailyCapUsdc, circleEnabled: false, localKey: false };
}

export type Transfer = (to: Address, amountUsdc: number, refId: string) => Promise<{ mode: PayoutMode; txHash: `0x${string}` | null; note?: string }>;

let localChain: Promise<unknown> = Promise.resolve(); // serialise nonces for the local key
/** Default rail chooser: circle → local → dry-run. */
export const defaultTransfer: Transfer = async (to, amountUsdc, refId) => {
  const st = payoutStatus();
  if (st.mode === "circle") {
    const r = await transferUsdc({ role: "revenue", to, amountUsdc, refId });
    if (r.status === "sent") return { mode: "circle", txHash: r.txHash };
    return { mode: "dry-run", txHash: null, note: r.reason };
  }
  if (st.mode === "local") {
    const key = tipsEnv().payoutPrivateKey!;
    const c = config();
    const account = privateKeyToAccount(key);
    const chain = arcChain();
    const wallet = createWalletClient({ account, chain, transport: http(c.ARC_RPC_URL) });
    const pub = createPublicClient({ chain, transport: http(c.ARC_RPC_URL) });
    const run = async () => {
      const hash = await wallet.writeContract({ address: c.USDC_ADDRESS as Address, abi: USDC_TRANSFER_ABI, functionName: "transfer", args: [to, parseUnits(amountUsdc.toFixed(6), 6)] });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (receipt.status !== "success") throw new Error(`USDC transfer reverted (tx ${hash})`);
      return hash;
    };
    const p = localChain.then(run, run);
    localChain = p.catch(() => undefined);
    return { mode: "local", txHash: await p };
  }
  return { mode: "dry-run", txHash: null, note: st.reason };
};

export type PayOutcome =
  | { paid: true; mode: PayoutMode; txHash: `0x${string}` | null; amountUsdc: number; note: string }
  | { paid: false; deferred: true; amountUsdc: number; note: string };

export interface PayOptions { transfer?: Transfer; now?: number; dailyCapUsdc?: number }

/**
 * Pay a VERIFIED tip's bounty. Demo / anonymous submitters have no payable address → recorded as a dry-run payout
 * (the bounty is shown, nothing is sent). Beyond the daily cap → deferred (caller leaves the tip VERIFIED).
 */
export async function payTip(tip: Tip, amountUsdc: number, opts: PayOptions = {}): Promise<PayOutcome> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const cap = opts.dailyCapUsdc ?? tipsEnv().dailyCapUsdc;
  const amount = round6(amountUsdc);
  if (amount <= 0) return { paid: true, mode: "dry-run", txHash: null, amountUsdc: 0, note: "zero bounty" };
  const spent = await spentToday(now);
  if (spent + amount > cap) return { paid: false, deferred: true, amountUsdc: amount, note: `daily cap ${cap} USDC reached (${round6(spent)} spent today); retried on a later tick` };

  const payable = /^0x[0-9a-f]{40}$/i.test(tip.submitter) && tip.submitter !== DEMO_SUBMITTER && tip.submitter !== ANON_SUBMITTER;
  if (!payable) {
    await addSpend(amount, now);
    return { paid: true, mode: "dry-run", txHash: null, amountUsdc: amount, note: `${tip.submitter} submitter has no payout address (same-origin demo / x402 disabled) — bounty recorded, nothing sent` };
  }
  const transfer = opts.transfer ?? defaultTransfer;
  const r = await transfer(tip.submitter.toLowerCase() as Address, amount, `complir:tip:${tip.id}`);
  await addSpend(amount, now);
  return { paid: true, mode: r.mode, txHash: r.txHash, amountUsdc: amount, note: r.note ?? (r.txHash ? `sent via ${r.mode}` : `${r.mode}: simulated`) };
}
