/**
 * USYC revenue sweep — spec C15.
 *
 * x402 revenue lands as USDC in the revenue wallet. Idle USDC above a small float is subscribed into USYC
 * (Circle's tokenized money-market fund on Arc) via the USYC Teller; when the float runs low, USYC is redeemed back.
 *
 * Contracts (Arc mainnet 5042, verified against docs.arc.io/arc/references/contract-addresses and
 * developers.circle.com/tokenized/usyc/smart-contracts on 2026-10-11; on-chain: USYC symbol()="USYC", decimals()=6):
 *   USYC          0x8a5D989Bbb96929F689B0200f435f53dA42bF490   (testnet 0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C)
 *   USYC Teller   0x51A8CE47dC08ba5CD19c7aa84EA6fD6664f60f9b   (testnet 0x9fdF14c5B14173D74C08Af27AebFf39240dC105A)
 *   Entitlements  0xb69ecb156Dc0028198028c501340d5367845ca72   (testnet 0xcc205224862c7641930c87679e98999d23c26113)
 * Teller interface (developers.circle.com/tokenized/usyc/subscribe-and-redeem):
 *   deposit(uint256 _assets, address _receiver) returns (uint256 shares)   — after usdc.approve(teller, _assets)
 *   redeem(uint256 _shares, address _receiver, address _account) returns (uint256 assets)
 *
 * IMPORTANT: USYC is a permissioned token. The Teller and the token query the Entitlements contract; a wallet that
 * has not completed Circle/Hashnote investor onboarding (KYB, non-US person under Reg S) is NOT entitled and every
 * deposit/redeem/transfer reverts. Default mode is DRY-RUN: we only log the plan to the decision log.
 *
 * Env (all optional; read via process.env so src/lib/config.ts stays untouched):
 *   USYC_MODE=dry|live (default dry)        USYC_ADDRESS, USYC_TELLER_ADDRESS (defaults per chain id above)
 *   REVENUE_PRIVATE_KEY (live only)         REVENUE_WALLET (dry-run address; falls back to key → X402_PAY_TO)
 *   USYC_FLOAT_USDC (default 5)             USYC_MIN_SWEEP_USDC (default 1)
 */
import { createPublicClient, createWalletClient, http, erc20Abi, parseAbi, formatUnits, parseUnits, type Address as ViemAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config";
import { arcChain } from "../chain/registryWriter";
import { appendDecision } from "../ledger";

export type SweepAction = "DEPOSIT" | "REDEEM" | "NONE";
export interface SweepPlan {
  action: SweepAction;
  /** USDC amount to move (6 dp decimal number). For REDEEM this is the USDC we want back. */
  amount: number;
  reason: string;
}
export interface PlanInput {
  /** spendable USDC in the revenue wallet */
  balanceUsdc: number;
  /** USDC to keep liquid for gas/refunds */
  floatUsdc: number;
  /** ignore moves smaller than this */
  minSweepUsdc: number;
  /** current USYC holding expressed in USDC (optional; 0 when unknown) */
  usycUsdc?: number;
}

export const USYC_DEFAULTS: Record<number, { usyc: ViemAddress; teller: ViemAddress; entitlements: ViemAddress }> = {
  5042: { usyc: "0x8a5D989Bbb96929F689B0200f435f53dA42bF490", teller: "0x51A8CE47dC08ba5CD19c7aa84EA6fD6664f60f9b", entitlements: "0xb69ecb156Dc0028198028c501340d5367845ca72" },
  5042002: { usyc: "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C", teller: "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A", entitlements: "0xcc205224862c7641930c87679e98999d23c26113" },
};

export const tellerAbi = parseAbi([
  "function deposit(uint256 _assets, address _receiver) returns (uint256)",
  "function redeem(uint256 _shares, address _receiver, address _account) returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Pure planner. Keeps `floatUsdc` liquid; deposits the excess, redeems the shortfall, never moves < minSweepUsdc. */
export function planSweep(input: PlanInput): SweepPlan {
  const balance = Math.max(0, Number(input.balanceUsdc) || 0);
  const float = Math.max(0, Number(input.floatUsdc) || 0);
  const min = Math.max(0, Number(input.minSweepUsdc) || 0);
  const usyc = Math.max(0, Number(input.usycUsdc) || 0);
  const excess = round6(balance - float);
  if (excess >= min && excess > 0) {
    return { action: "DEPOSIT", amount: excess, reason: `balance ${balance} USDC exceeds float ${float} by ${excess} (≥ min ${min})` };
  }
  if (excess < 0) {
    const shortfall = round6(-excess);
    const amount = round6(Math.min(shortfall, usyc));
    if (amount >= min && amount > 0) {
      return { action: "REDEEM", amount, reason: `balance ${balance} USDC is ${shortfall} below float ${float}; redeeming ${amount} of ${usyc} USYC-USDC` };
    }
    if (usyc <= 0) return { action: "NONE", amount: 0, reason: `balance ${balance} below float ${float} but no USYC to redeem` };
    return { action: "NONE", amount: 0, reason: `shortfall ${amount} below min sweep ${min}` };
  }
  return { action: "NONE", amount: 0, reason: excess > 0 ? `excess ${excess} below min sweep ${min}` : `balance ${balance} equals float ${float}` };
}

export interface UsycEnv {
  mode: "dry" | "live";
  usyc: ViemAddress | null;
  teller: ViemAddress | null;
  entitlements: ViemAddress | null;
  wallet: ViemAddress | null;
  hasKey: boolean;
  floatUsdc: number;
  minSweepUsdc: number;
}
const isAddr = (s: string | undefined): s is ViemAddress => !!s && /^0x[0-9a-fA-F]{40}$/.test(s);
export function usycEnv(): UsycEnv {
  const cfg = config();
  const d = USYC_DEFAULTS[cfg.ARC_CHAIN_ID];
  const key = process.env.REVENUE_PRIVATE_KEY;
  const hasKey = !!key && /^0x[0-9a-fA-F]{64}$/.test(key);
  const walletFromKey = hasKey ? privateKeyToAccount(key as `0x${string}`).address : null;
  const walletEnv = process.env.REVENUE_WALLET;
  const wallet = walletFromKey ?? (isAddr(walletEnv) ? walletEnv : isAddr(cfg.X402_PAY_TO) ? (cfg.X402_PAY_TO as ViemAddress) : null);
  const num = (k: string, def: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== "" ? v : def; };
  return {
    mode: (process.env.USYC_MODE ?? "dry").toLowerCase() === "live" ? "live" : "dry",
    usyc: isAddr(process.env.USYC_ADDRESS) ? process.env.USYC_ADDRESS : d?.usyc ?? null,
    teller: isAddr(process.env.USYC_TELLER_ADDRESS) ? process.env.USYC_TELLER_ADDRESS : d?.teller ?? null,
    entitlements: isAddr(process.env.USYC_ENTITLEMENTS_ADDRESS) ? process.env.USYC_ENTITLEMENTS_ADDRESS : d?.entitlements ?? null,
    wallet, hasKey,
    floatUsdc: num("USYC_FLOAT_USDC", 5),
    minSweepUsdc: num("USYC_MIN_SWEEP_USDC", 1),
  };
}

export interface SweepResult {
  mode: "dry" | "live";
  executed: boolean;
  wallet: ViemAddress | null;
  balances: { usdc: number; usyc: number; usycUsdc: number } | null;
  plan: SweepPlan;
  txs: { approve?: `0x${string}`; deposit?: `0x${string}`; redeem?: `0x${string}` };
  decisionId: string | null;
  skipped?: string;
  error?: string;
}

/** Best-effort: Hashnote's public entitlement check (docs: usyc.docs.hashnote.com → Web2 API). Null when unreachable. */
export async function checkEntitlement(address: ViemAddress): Promise<boolean | null> {
  try {
    const r = await fetch(`https://api.hashnote.com/v1/entitlements/token_access?address=${address}&symbol=USYC`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown>;
    const v = j.entitled ?? j.has_access ?? j.allowed ?? j.access;
    return typeof v === "boolean" ? v : null;
  } catch { return null; }
}

/** One sweep tick. DRY-RUN logs the plan as a NOOP decision; LIVE executes Teller deposit/redeem. */
export async function runSweepOnce(): Promise<SweepResult> {
  const env = usycEnv();
  const base: SweepResult = { mode: env.mode, executed: false, wallet: env.wallet, balances: null, plan: { action: "NONE", amount: 0, reason: "" }, txs: {}, decisionId: null };
  if (config().COMPLIR_PAUSED) return { ...base, skipped: "COMPLIR_PAUSED" };
  if (!env.wallet) return { ...base, skipped: "no revenue wallet (set REVENUE_WALLET, REVENUE_PRIVATE_KEY or X402_PAY_TO)" };
  if (!env.usyc || !env.teller) return { ...base, skipped: "USYC_ADDRESS / USYC_TELLER_ADDRESS unknown for this chain" };

  const cfg = config();
  const chain = arcChain();
  const pub = createPublicClient({ chain, transport: http(cfg.ARC_RPC_URL) });
  const usdcAddr = cfg.USDC_ADDRESS as ViemAddress;
  let usdcRaw: bigint, usycRaw: bigint, usycUsdcRaw: bigint;
  try {
    [usdcRaw, usycRaw] = await Promise.all([
      pub.readContract({ address: usdcAddr, abi: erc20Abi, functionName: "balanceOf", args: [env.wallet] }),
      pub.readContract({ address: env.usyc, abi: erc20Abi, functionName: "balanceOf", args: [env.wallet] }),
    ]);
    usycUsdcRaw = usycRaw === 0n ? 0n : await pub.readContract({ address: env.teller, abi: tellerAbi, functionName: "convertToAssets", args: [usycRaw] }).catch(() => usycRaw);
  } catch (e) {
    return { ...base, error: `balance read failed: ${(e as Error)?.message ?? e}` };
  }
  const balances = { usdc: Number(formatUnits(usdcRaw, 6)), usyc: Number(formatUnits(usycRaw, 6)), usycUsdc: Number(formatUnits(usycUsdcRaw, 6)) };
  const plan = planSweep({ balanceUsdc: balances.usdc, floatUsdc: env.floatUsdc, minSweepUsdc: env.minSweepUsdc, usycUsdc: balances.usycUsdc });
  const result: SweepResult = { ...base, balances, plan };

  const live = env.mode === "live" && env.hasKey && plan.action !== "NONE";
  if (live) {
    try {
      const account = privateKeyToAccount(process.env.REVENUE_PRIVATE_KEY as `0x${string}`);
      const wallet = createWalletClient({ account, chain, transport: http(cfg.ARC_RPC_URL) });
      const amountRaw = parseUnits(plan.amount.toFixed(6), 6);
      if (plan.action === "DEPOSIT") {
        const approve = await wallet.writeContract({ address: usdcAddr, abi: erc20Abi, functionName: "approve", args: [env.teller, amountRaw] });
        await pub.waitForTransactionReceipt({ hash: approve, timeout: 60_000 });
        const deposit = await wallet.writeContract({ address: env.teller, abi: tellerAbi, functionName: "deposit", args: [amountRaw, env.wallet] });
        await pub.waitForTransactionReceipt({ hash: deposit, timeout: 60_000 });
        result.txs = { approve, deposit };
      } else {
        let shares = await pub.readContract({ address: env.teller, abi: tellerAbi, functionName: "convertToShares", args: [amountRaw] }).catch(() => amountRaw);
        if (shares > usycRaw) shares = usycRaw;
        const redeem = await wallet.writeContract({ address: env.teller, abi: tellerAbi, functionName: "redeem", args: [shares, env.wallet, env.wallet] });
        await pub.waitForTransactionReceipt({ hash: redeem, timeout: 60_000 });
        result.txs = { redeem };
      }
      result.executed = true;
    } catch (e) {
      result.error = `live sweep failed (is the wallet entitled? see docs/USYC.md): ${(e as Error)?.message ?? e}`;
    }
  }

  const entry = await appendDecision({
    kind: "NOOP", subject: null, clientId: null,
    payload: { type: "USYC_SWEEP", mode: env.mode, executed: result.executed, wallet: env.wallet, balances, plan, floatUsdc: env.floatUsdc, minSweepUsdc: env.minSweepUsdc, txs: result.txs, ...(result.error ? { error: result.error } : {}), at: Math.floor(Date.now() / 1000) },
  });
  result.decisionId = entry.id;
  return result;
}
