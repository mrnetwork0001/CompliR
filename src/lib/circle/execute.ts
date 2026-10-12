/**
 * Contract execution, USDC transfer and EIP-712 signing through Circle Developer-Controlled Wallets.
 *
 * Gas on Arc: USDC *is* the native gas asset, so an EOA/SCA wallet pays gas from its own USDC balance.
 * "Sponsored" means an active Circle Gas Station policy for ARC (console → Gas Station → mainnet policy; needs an
 * SCA wallet) — then Circle's ERC-4337 paymaster pays and bills the developer in USD (+5%). Sponsorship is decided
 * by the policy, not by a request field; the request always carries a `fee.level` (CIRCLE_FEE_LEVEL).
 * Circle Paymaster (user pays gas in USDC) is a different product and not deployed on Arc — not needed there.
 *
 * Every function reports `status: "dry-run"` (never throws) when Circle is not configured.
 */
import { randomUUID } from "node:crypto";
import { encodeFunctionData, type Abi, type Hex } from "viem";
import { config } from "../config";
import type { Address, AttestationTypedData } from "../types";
import { circleClient, circleStatus } from "./client";
import { checkSpend, ensureWallets, recordSpend, walletByRole, type CircleWalletRow, type WalletRole } from "./wallets";

export type CircleTxState = "INITIATED" | "CLEARED" | "QUEUED" | "SENT" | "STUCK" | "CONFIRMED" | "COMPLETE" | "FAILED" | "DENIED" | "CANCELLED";
const FAILURE_STATES = new Set<string>(["FAILED", "DENIED", "CANCELLED", "STUCK"]);
const ONCHAIN_STATES = new Set<string>(["SENT", "CONFIRMED", "COMPLETE"]);

export interface ExecuteContractInput {
  role: WalletRole;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** Native value (USDC on Arc) to attach, in decimal units. Counts against the spending policy. */
  amountUsdc?: number;
  refId?: string;
  pollMs?: number;
  timeoutMs?: number;
}

export type ExecuteResult =
  | { status: "dry-run"; role: WalletRole; reason: string; to: Address; calldata: Hex; functionName: string }
  | { status: "sent"; role: WalletRole; txId: string; txHash: Hex; state: CircleTxState; to: Address; calldata: Hex; walletId: string; from: Address; feeLevel: string; accountType: "SCA" | "EOA" };

/** Resolve the role's wallet, provisioning on first use when Circle is live. Throws when it cannot. */
async function requireWallet(role: WalletRole): Promise<CircleWalletRow> {
  const w = (await walletByRole(role)) ?? (await ensureWallets()).wallets.find((x) => x.role === role) ?? null;
  if (!w) throw new Error(`circle: no ${role} wallet provisioned (run scripts/circle/setup.ts)`);
  return w;
}

interface TxSnapshot { state?: string; txHash?: string; errorReason?: string; errorDetails?: string }
type TxFetcher = (id: string) => Promise<TxSnapshot | undefined>;

/**
 * Poll a Circle transaction until it has a txHash and is on-chain (SENT/CONFIRMED/COMPLETE). SCA wallets only get a
 * hash at CONFIRMED (ERC-4337 bundling), so we wait for the hash rather than a state. Rejects on FAILED/DENIED/
 * CANCELLED/STUCK or timeout.
 */
export async function waitForTxHash(fetch: TxFetcher, id: string, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<{ txHash: Hex; state: CircleTxState }> {
  const pollMs = opts.pollMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? config().CIRCLE_TX_TIMEOUT_MS);
  let last: TxSnapshot | undefined;
  for (;;) {
    last = await fetch(id);
    const state = last?.state ?? "";
    if (FAILURE_STATES.has(state)) {
      throw new Error(`circle: transaction ${id} ${state}${last?.errorReason ? ` (${last.errorReason})` : ""}${last?.errorDetails ? `: ${last.errorDetails}` : ""}`);
    }
    if (last?.txHash && ONCHAIN_STATES.has(state)) return { txHash: last.txHash as Hex, state: state as CircleTxState };
    if (Date.now() >= deadline) throw new Error(`circle: transaction ${id} timed out in state ${state || "unknown"}${last?.txHash ? ` (txHash ${last.txHash})` : ""}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function sdkFetcher(): TxFetcher {
  const client = circleClient();
  return async (id) => {
    const r = await client.getTransaction({ id });
    return r.data?.transaction;
  };
}

/** Execute `functionName(args)` on `address` from the role's Circle wallet; resolves once the tx hash is known. */
export async function executeContract(input: ExecuteContractInput): Promise<ExecuteResult> {
  const calldata = encodeFunctionData({ abi: input.abi, functionName: input.functionName, args: input.args as unknown[] });
  const status = circleStatus();
  if (!status.enabled) return { status: "dry-run", role: input.role, reason: status.reason!, to: input.address, calldata, functionName: input.functionName };
  const w = await requireWallet(input.role);
  const amount = input.amountUsdc ?? 0;
  await checkSpend(input.role, { target: input.address, amountUsdc: amount });
  const client = circleClient();
  const created = await client.createContractExecutionTransaction({
    walletId: w.walletId,
    contractAddress: input.address,
    callData: calldata,
    ...(amount > 0 ? { amount: String(amount) } : {}),
    fee: { type: "level", config: { feeLevel: status.feeLevel } },
    refId: input.refId ?? `complir:${input.functionName}`,
    idempotencyKey: randomUUID(),
  });
  const txId = created.data?.id;
  if (!txId) throw new Error("circle: createContractExecutionTransaction returned no id");
  await recordSpend(input.role, { kind: "contract", target: input.address, amountUsdc: amount, txId });
  const { txHash, state } = await waitForTxHash(sdkFetcher(), txId, { pollMs: input.pollMs, timeoutMs: input.timeoutMs });
  return { status: "sent", role: input.role, txId, txHash, state, to: input.address, calldata, walletId: w.walletId, from: w.address, feeLevel: status.feeLevel, accountType: w.accountType };
}

export type TransferResult =
  | { status: "dry-run"; role: WalletRole; reason: string; to: Address; amountUsdc: number }
  | { status: "sent"; role: WalletRole; txId: string; txHash: Hex; state: CircleTxState; to: Address; amountUsdc: number; from: Address };

/**
 * Send USDC from a role's wallet (policy-checked: allowlist + per-tx + rolling daily cap). On Arc USDC is the native
 * asset; Circle's transfer API identifies it by `tokenAddress` (USDC_ADDRESS) + `blockchain`.
 */
export async function transferUsdc(input: { role: WalletRole; to: Address; amountUsdc: number; refId?: string; pollMs?: number; timeoutMs?: number }): Promise<TransferResult> {
  const status = circleStatus();
  if (!status.enabled) return { status: "dry-run", role: input.role, reason: status.reason!, to: input.to, amountUsdc: input.amountUsdc };
  if (!(input.amountUsdc > 0)) throw new Error("circle: amountUsdc must be > 0");
  const w = await requireWallet(input.role);
  await checkSpend(input.role, { target: input.to, amountUsdc: input.amountUsdc });
  const created = await circleClient().createTransaction({
    // walletAddress+blockchain form: the SDK's walletId variant forbids `blockchain`, which tokenAddress lookups need.
    walletAddress: w.address,
    blockchain: status.blockchain!,
    destinationAddress: input.to,
    amount: [String(input.amountUsdc)],
    tokenAddress: config().USDC_ADDRESS,
    fee: { type: "level", config: { feeLevel: status.feeLevel } },
    refId: input.refId ?? "complir:transfer",
    idempotencyKey: randomUUID(),
  });
  const txId = created.data?.id;
  if (!txId) throw new Error("circle: createTransaction returned no id");
  await recordSpend(input.role, { kind: "transfer", target: input.to, amountUsdc: input.amountUsdc, txId });
  const { txHash, state } = await waitForTxHash(sdkFetcher(), txId, { pollMs: input.pollMs, timeoutMs: input.timeoutMs });
  return { status: "sent", role: input.role, txId, txHash, state, to: input.to, amountUsdc: input.amountUsdc, from: w.address };
}

export type SignTypedDataResult =
  | { status: "dry-run"; role: WalletRole; reason: string }
  | { status: "signed"; role: WalletRole; signature: Hex; signer: Address; accountType: "SCA" | "EOA" };

/**
 * EIP-712 signature by a role's Circle wallet (`POST /v1/w3s/developer/sign/typedData`). Only an **EOA** wallet yields a
 * plain secp256k1 signature that `AttestationRegistry.attest` can `ECDSA.recover`; an SCA signs ERC-1271-style, which
 * the registry does not verify. So to make a Circle wallet the registry attester it must be created with
 * CIRCLE_ACCOUNT_TYPE=EOA (which forfeits Gas Station sponsorship — see docs/CIRCLE_WALLETS.md).
 */
export async function signTypedDataWithCircle(role: WalletRole, typedData: AttestationTypedData | Record<string, unknown>, memo?: string): Promise<SignTypedDataResult> {
  const status = circleStatus();
  if (!status.enabled) return { status: "dry-run", role, reason: status.reason! };
  const w = await requireWallet(role);
  const res = await circleClient().signTypedData({ walletId: w.walletId, data: JSON.stringify(typedData), ...(memo ? { memo } : {}) });
  const signature = res.data?.signature;
  if (!signature) throw new Error("circle: signTypedData returned no signature");
  return { status: "signed", role, signature: signature as Hex, signer: w.address, accountType: w.accountType };
}
