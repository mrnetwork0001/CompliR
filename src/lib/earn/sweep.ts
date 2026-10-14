/**
 * Revenue yield sweep through Circle Earn (Morpho USDC vaults on Arc) - the default since USYC is permissioned.
 *
 * x402 revenue lands as USDC in the Circle `revenue` wallet. Idle USDC above the float is deposited into the best
 * eligible Earn vault (see planner.ts); a shortfall is redeemed. Execution is plain ERC-4626 from the Circle wallet via
 * `executeContract` (app-enforced spending policy, Gas Station-sponsored on an SCA wallet):
 *   DEPOSIT  USDC.approve(vault, assets) → vault.deposit(assets, receiver = revenue wallet)
 *   REDEEM   vault.redeem(shares, receiver = revenue wallet, owner = revenue wallet)
 * Morpho Vault V2 (what Earn lists on Arc) returns 0 from maxDeposit/maxWithdraw by design, so liquidity comes from
 * Circle Earn's `liquidityProfile.available` and the redeem is simulated (eth_call from the wallet) before sending.
 *
 * Env (read via process.env; see .env.example):
 *   YIELD_MODE=dry|live (default dry)     YIELD_FLOAT_USDC (5)        YIELD_MIN_SWEEP_USDC (1)
 *   YIELD_MAX_SWEEP_USDC (25)             YIELD_MIN_TVL_USDC (100000) YIELD_REQUIRE_SENTINEL (1)
 *   YIELD_LIQUIDITY_MULTIPLE (2)          YIELD_VAULT (pin one vault) YIELD_EARN_API_URL / YIELD_EARN_API_KEY (optional)
 *   REVENUE_WALLET / X402_PAY_TO          (the Circle revenue wallet address)
 */
import { createPublicClient, erc20Abi, formatUnits, http, parseAbi, parseUnits, type Address as ViemAddress, type Hex } from "viem";
import { config } from "../config";
import { arcChain } from "../chain/registryWriter";
import { appendDecision } from "../ledger";
import { executeContract, policyFor, walletByRole, type ExecuteContractInput, type ExecuteResult } from "../circle";
import type { DecisionKind, DecisionLogEntry } from "../types";
import { planYield, type YieldPlan, type YieldPolicy, type YieldPosition } from "./planner";
import { fetchEarnVaults, type YieldVault } from "./vaults";

export const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
]);

export interface YieldEnv {
  mode: "dry" | "live";
  wallet: ViemAddress | null;
  floatUsdc: number;
  minSweepUsdc: number;
  maxSweepUsdc: number;
  policy: Omit<YieldPolicy, "contractAllowlist">;
  apiUrl: string | undefined;
  apiKey: string | undefined;
}
const isAddr = (s: string | undefined | null): s is ViemAddress => !!s && /^0x[0-9a-fA-F]{40}$/.test(s);
const num = (k: string, def: number) => { const v = Number(process.env[k]); return process.env[k] !== undefined && process.env[k] !== "" && Number.isFinite(v) ? v : def; };

export function yieldEnv(): YieldEnv {
  const cfg = config();
  const w = process.env.REVENUE_WALLET;
  return {
    mode: (process.env.YIELD_MODE ?? "dry").toLowerCase() === "live" ? "live" : "dry",
    wallet: isAddr(w) ? (w.toLowerCase() as ViemAddress) : isAddr(cfg.X402_PAY_TO) ? (cfg.X402_PAY_TO.toLowerCase() as ViemAddress) : null,
    floatUsdc: num("YIELD_FLOAT_USDC", 5),
    minSweepUsdc: num("YIELD_MIN_SWEEP_USDC", 1),
    maxSweepUsdc: num("YIELD_MAX_SWEEP_USDC", 25),
    policy: {
      usdcAddress: cfg.USDC_ADDRESS.toLowerCase(),
      minTvlUsdc: num("YIELD_MIN_TVL_USDC", 100_000),
      requireSentinel: !["0", "false", "no"].includes((process.env.YIELD_REQUIRE_SENTINEL ?? "1").toLowerCase()),
      liquidityMultiple: Math.max(1, num("YIELD_LIQUIDITY_MULTIPLE", 2)),
      pinnedVault: isAddr(process.env.YIELD_VAULT) ? process.env.YIELD_VAULT.toLowerCase() : null,
    },
    apiUrl: process.env.YIELD_EARN_API_URL || undefined,
    apiKey: process.env.YIELD_EARN_API_KEY || undefined,
  };
}

/** Revenue wallet's contract allowlist (empty = unrestricted). Never throws. */
async function revenueContractAllowlist(): Promise<string[]> {
  try { return (await policyFor("revenue")).contractAllowlist ?? []; } catch { return []; }
}

export interface YieldState {
  balanceUsdc: number;
  positions: (YieldPosition & { sharesRaw: string })[];
}

function publicClient() {
  const cfg = config();
  return createPublicClient({ chain: arcChain(), transport: http(cfg.ARC_RPC_URL, { timeout: 8_000, retryCount: 1 }) });
}

/** USDC balance + share positions in every USDC Earn vault (one multicall). */
export async function readYieldState(wallet: ViemAddress, vaults: YieldVault[] | null, extra: string[] = []): Promise<YieldState> {
  const cfg = config();
  const pub = publicClient();
  const usdc = cfg.USDC_ADDRESS.toLowerCase();
  const addrs = [...new Set([...(vaults ?? []).filter((v) => v.assetAddress === usdc).map((v) => v.address.toLowerCase()), ...extra.map((x) => x.toLowerCase())])].filter(isAddr) as ViemAddress[];
  const usdcRaw = await pub.readContract({ address: cfg.USDC_ADDRESS as ViemAddress, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
  const positions: YieldState["positions"] = [];
  if (addrs.length) {
    const bals = await pub.multicall({ contracts: addrs.map((address) => ({ address, abi: vaultAbi, functionName: "balanceOf" as const, args: [wallet] as const })), allowFailure: true });
    const held = addrs.map((a, i) => ({ a, r: bals[i] })).filter((x) => x.r.status === "success" && (x.r.result as bigint) > 0n);
    if (held.length) {
      const assets = await pub.multicall({ contracts: held.map((h) => ({ address: h.a, abi: vaultAbi, functionName: "convertToAssets" as const, args: [h.r.result as bigint] as const })), allowFailure: true });
      held.forEach((h, i) => {
        const shares = h.r.result as bigint;
        const a = assets[i].status === "success" ? (assets[i].result as bigint) : 0n;
        const meta = vaults?.find((v) => v.address.toLowerCase() === h.a);
        positions.push({ vault: h.a, name: meta?.name ?? h.a, shares: Number(formatUnits(shares, 18)), sharesRaw: shares.toString(), assetsUsdc: Number(formatUnits(a, 6)) });
      });
    }
  }
  return { balanceUsdc: Number(formatUnits(usdcRaw, 6)), positions };
}

export interface YieldReserves {
  mode: "dry" | "live";
  wallet: string | null;
  floatSettingUsdc: number;
  minSweepUsdc: number;
  maxSweepUsdc: number;
  positions: YieldPosition[];
  heldUsdc: number;
  /** USDC Earn vaults on the chain (null = Earn API unreachable) */
  vaults: YieldVault[] | null;
  /** the vault a deposit of `minSweepUsdc` would go to now, and why the rest are out */
  preferred: { address: string; name: string; apy: number; availableUsdc: number } | null;
  policy: YieldPolicy;
  vaultsError?: string;
}

/** Earn metadata + policy, without balances (the snapshot reads balances itself). Never throws. */
export async function yieldContext(env = yieldEnv()): Promise<{ vaults: YieldVault[] | null; policy: YieldPolicy; error?: string }> {
  const policy: YieldPolicy = { ...env.policy, contractAllowlist: await revenueContractAllowlist() };
  try {
    const all = await fetchEarnVaults({ chainId: config().ARC_CHAIN_ID, baseUrl: env.apiUrl, apiKey: env.apiKey });
    return { vaults: all.filter((v) => v.assetAddress === env.policy.usdcAddress), policy };
  } catch (e) {
    return { vaults: null, policy, error: (e as Error)?.message ?? String(e) };
  }
}

export interface YieldResult {
  backend: "earn";
  mode: "dry" | "live";
  executed: boolean;
  wallet: ViemAddress | null;
  balances: { usdc: number; heldUsdc: number; positions: YieldPosition[] } | null;
  floatUsdc: number;
  plan: YieldPlan;
  txs: { approve?: Hex; deposit?: Hex; redeem?: Hex };
  decisionId: string | null;
  ledgerKind: DecisionKind | null;
  skipped?: string;
  error?: string;
}

export interface YieldDeps {
  context: typeof yieldContext;
  readState: typeof readYieldState;
  execute: (input: ExecuteContractInput) => Promise<ExecuteResult>;
  revenueWallet: () => Promise<string | null>;
  preview: (vault: ViemAddress, fn: "previewDeposit" | "previewWithdraw", assets: bigint) => Promise<bigint>;
  simulateRedeem: (vault: ViemAddress, shares: bigint, wallet: ViemAddress) => Promise<void>;
  append: (e: { kind: DecisionKind; subject: null; clientId: string | null; payload: unknown }) => Promise<DecisionLogEntry>;
}
const defaultDeps: YieldDeps = {
  context: yieldContext,
  readState: readYieldState,
  execute: executeContract,
  revenueWallet: async () => (await walletByRole("revenue"))?.address ?? null,
  preview: (vault, fn, assets) => publicClient().readContract({ address: vault, abi: vaultAbi, functionName: fn, args: [assets] }),
  simulateRedeem: async (vault, shares, wallet) => { await publicClient().simulateContract({ account: wallet, address: vault, abi: vaultAbi, functionName: "redeem", args: [shares, wallet, wallet] }); },
  append: (e) => appendDecision(e as Parameters<typeof appendDecision>[0]),
};

export interface RunYieldOptions {
  /** effective float (operator passes cushion + obligations due 48 h); default YIELD_FLOAT_USDC */
  floatUsdc?: number;
  deps?: Partial<YieldDeps>;
}

/**
 * One yield tick. Plans from live balances + Circle Earn metadata; DRY logs the plan (NOOP · YIELD_PLAN), LIVE executes
 * through the Circle revenue wallet and logs OPERATOR · YIELD_SWEEP / YIELD_REDEEM with the tx hashes. Never throws.
 */
export async function runYieldOnce(opts: RunYieldOptions = {}): Promise<YieldResult> {
  const d: YieldDeps = { ...defaultDeps, ...(opts.deps ?? {}) };
  const env = yieldEnv();
  const floatUsdc = opts.floatUsdc ?? env.floatUsdc;
  const base: YieldResult = { backend: "earn", mode: env.mode, executed: false, wallet: env.wallet, balances: null, floatUsdc, plan: { action: "NONE", amount: 0, vault: null, reason: "", excluded: [] }, txs: {}, decisionId: null, ledgerKind: null };
  if (config().COMPLIR_PAUSED) return { ...base, skipped: "COMPLIR_PAUSED" };
  if (!env.wallet) return { ...base, skipped: "no revenue wallet (set REVENUE_WALLET or X402_PAY_TO to the Circle revenue wallet)" };

  const ctx = await d.context(env);
  let state: YieldState;
  try {
    state = await d.readState(env.wallet, ctx.vaults, env.policy.pinnedVault ? [env.policy.pinnedVault] : []);
  } catch (e) {
    return { ...base, error: `balance read failed: ${(e as Error)?.message ?? e}` }; // float unknown → never sweep
  }
  const heldUsdc = Math.round(state.positions.reduce((s, p) => s + p.assetsUsdc, 0) * 1e6) / 1e6;
  const plan = planYield({ balanceUsdc: state.balanceUsdc, floatUsdc, minSweepUsdc: env.minSweepUsdc, maxSweepUsdc: env.maxSweepUsdc, positions: state.positions, vaults: ctx.vaults, policy: ctx.policy });
  const result: YieldResult = { ...base, balances: { usdc: state.balanceUsdc, heldUsdc, positions: state.positions.map(({ sharesRaw: _s, ...p }) => p) }, plan, ...(ctx.error ? { error: `earn metadata: ${ctx.error}` } : {}) };

  if (env.mode === "live" && plan.action !== "NONE" && plan.vault) {
    try {
      const circleWallet = (await d.revenueWallet())?.toLowerCase() ?? null;
      if (circleWallet !== env.wallet) throw new Error(`Circle revenue wallet ${circleWallet ?? "(not provisioned)"} ≠ REVENUE_WALLET ${env.wallet} - refusing to move funds`);
      const usdc = config().USDC_ADDRESS as ViemAddress;
      const vault = plan.vault.address;
      const raw = parseUnits(plan.amount.toFixed(6), 6);
      if (plan.action === "DEPOSIT") {
        if ((await d.preview(vault, "previewDeposit", raw)) <= 0n) throw new Error("previewDeposit returned 0 shares");
        const approve = await d.execute({ role: "revenue", address: usdc, abi: erc20Abi, functionName: "approve", args: [vault, raw], refId: `complir:yield:approve` });
        if (approve.status !== "sent") throw new Error(`circle dry-run: ${approve.reason}`);
        result.txs.approve = approve.txHash;
        const dep = await d.execute({ role: "revenue", address: vault, abi: vaultAbi, functionName: "deposit", args: [raw, env.wallet], policyAmountUsdc: plan.amount, refId: `complir:yield:deposit` });
        if (dep.status !== "sent") throw new Error(`circle dry-run: ${dep.reason}`);
        result.txs.deposit = dep.txHash;
      } else {
        const pos = state.positions.find((p) => p.vault.toLowerCase() === vault.toLowerCase());
        const have = BigInt(pos?.sharesRaw ?? "0");
        let shares = await d.preview(vault, "previewWithdraw", raw);
        if (shares > have) shares = have;
        if (shares <= 0n) throw new Error("no shares to redeem");
        await d.simulateRedeem(vault, shares, env.wallet);
        const red = await d.execute({ role: "revenue", address: vault, abi: vaultAbi, functionName: "redeem", args: [shares, env.wallet, env.wallet], refId: `complir:yield:redeem` });
        if (red.status !== "sent") throw new Error(`circle dry-run: ${red.reason}`);
        result.txs.redeem = red.txHash;
      }
      result.executed = true;
    } catch (e) {
      result.error = `live ${plan.action.toLowerCase()} failed: ${(e as Error)?.message ?? e}`;
    }
  }

  const type = result.executed ? (plan.action === "DEPOSIT" ? "YIELD_SWEEP" : "YIELD_REDEEM") : "YIELD_PLAN";
  const kind: DecisionKind = result.executed ? "OPERATOR" : "NOOP";
  try {
    const entry = await d.append({
      kind, subject: null, clientId: result.executed ? "operator" : null,
      payload: {
        type, backend: "earn", mode: env.mode, executed: result.executed, wallet: env.wallet, balances: result.balances,
        plan: { ...plan, excluded: plan.excluded.slice(0, 12) }, floatUsdc, minSweepUsdc: env.minSweepUsdc, maxSweepUsdc: env.maxSweepUsdc,
        txs: result.txs, ...(result.error ? { error: result.error } : {}), at: Math.floor(Date.now() / 1000),
      },
    });
    result.decisionId = entry.id;
    result.ledgerKind = kind;
  } catch (e) {
    result.error = [result.error, `ledger append failed: ${(e as Error)?.message ?? e}`].filter(Boolean).join("; ");
  }
  return result;
}
