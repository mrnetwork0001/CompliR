/**
 * Company snapshot - everything the operator agent (and the /company page) needs to see in one object.
 *
 * Reads only: revenue from the `payments` table, reserves from the revenue wallet on Arc (+ Circle Earn vault
 * positions, or USYC when YIELD_BACKEND=usyc) and the Circle
 * wallets, obligations from the treasury invoices, screening volume from `screenings`, prices from operator_pricing.
 * Every section is fetched independently and degrades to nulls when its source fails: this function never throws.
 */
import { createPublicClient, erc20Abi, formatUnits, http, type Address as ViemAddress } from "viem";
import { arcChain, signerMode } from "../chain/registryWriter";
import { balances as circleBalances, circleStatus, listStoredWallets, type CircleWalletRow, type TokenBalance } from "../circle";
import { config } from "../config";
import { db, migrate } from "../store/db";
import { invoiceTotals, pendingInvoices, policyFromEnv, spentToday, treasuryStatus, type TreasuryMode, type TreasuryPolicy } from "../treasury";
import { tellerAbi, usycEnv } from "../usyc";
import { chooseDepositVault, readYieldState, yieldBackend, yieldContext, yieldEnv, type YieldBackend, type YieldPolicy, type YieldPosition, type YieldVault } from "../earn";
import { priceState, type PriceState } from "./pricing";
import { isRateLimited } from "../evidence/util";

export interface RevenueSnapshot {
  last24hUsdc: number;
  last7dUsdc: number;
  totalUsdc: number;
  /** distinct payers, all time */
  payers: number;
  /** settled (non-refunded) paid calls, all time */
  callsPaid: number;
  callsPaid24h: number;
  /** paid calls from wallets we do not control, last 48 h (the "is anyone buying?" signal) */
  outsideCalls48h: number;
  refunds: number;
  refundedUsdc: number;
}
export interface CircleWalletView {
  role: CircleWalletRow["role"];
  address: string | null;
  accountType: string | null;
  policy: CircleWalletRow["policy"] | null;
  balances: TokenBalance[];
  status: "ok" | "dry-run" | "not-provisioned" | "error";
  reason?: string;
}
export interface ReservesSnapshot {
  /** spendable USDC in the revenue wallet (x402 payTo) */
  floatUsdc: number | null;
  /** all yield positions valued in USDC (Earn vault shares via convertToAssets, or USYC) */
  yieldUsdc: number | null;
  /** per-vault positions (Earn: one per Morpho vault held; USYC: the USYC token) */
  positions: YieldPosition[];
  revenueWallet: string | null;
  yieldBackend: YieldBackend;
  yieldMode: "dry" | "live";
  /** fixed cushion (YIELD_FLOAT_USDC, or USYC_FLOAT_USDC on the usyc backend) */
  yieldFloatUsdc: number;
  yieldMinSweepUsdc: number;
  yieldMaxSweepUsdc: number;
  /** USDC Circle Earn vaults on this chain (null = Earn API unreachable or usyc backend) */
  vaults: YieldVault[] | null;
  yieldPolicy: YieldPolicy | null;
  /** where a deposit would go right now (planner preview at min sweep) */
  preferredVault: { address: string; name: string; apy: number; availableUsdc: number; tvlUsdc: number } | null;
  vaultsError?: string;
  circle: { enabled: boolean; reason?: string; blockchain: string | null; wallets: CircleWalletView[] };
  /** short, human-readable reason when the chain read failed (never a raw RPC dump) */
  error?: string;
  /** set when float/yield are the last successful read because the live read failed (ISO time of that read) */
  floatAsOf?: string;
}
export interface ObligationsSnapshot {
  pendingInvoices: number;
  pendingUsdc: number;
  heldInvoices: number;
  heldUsdc: number;
  /** what the treasury could still pay today: pending, capped by the daily headroom */
  dueTodayUsdc: number;
  /** pending USDC that may fall due within 48 h (all pending invoices are payable now) */
  due48hUsdc: number;
  paidInvoices: number;
  paidUsdc: number;
  spentTodayUsdc: number;
  dailyHeadroomUsdc: number;
  policy: TreasuryPolicy | null;
}
export interface ScreeningSnapshot {
  screenings24h: number;
  high24h: number;
  medium24h: number;
  low24h: number;
  screeningsTotal: number;
  watchesActive: number;
  /** p95 end-to-end latency, ms - null when not measured (no latency source yet) */
  p95LatencyMs: number | null;
}
export interface PricingSnapshot {
  screenUsdc: number;
  watchUsdc: number;
  lastChangeAt: number | null;
  reason: string;
  screen: PriceState;
  watch: PriceState;
}
export interface ModeSnapshot {
  treasury: TreasuryMode;
  yield: "dry" | "live";
  yieldBackend: YieldBackend;
  signer: "local" | "circle";
  circle: "live" | "dry-run";
  x402: "enabled" | "disabled";
  paused: boolean;
  chainId: number | null;
  explorerUrl: string;
  treasuryAddress: string | null;
}
export interface CompanySnapshot {
  revenue: RevenueSnapshot | null;
  reserves: ReservesSnapshot | null;
  obligations: ObligationsSnapshot | null;
  screening: ScreeningSnapshot | null;
  pricing: PricingSnapshot | null;
  mode: ModeSnapshot | null;
  /** which sections failed and why (empty = complete) */
  errors: Record<string, string>;
  asOf: string;
}

const now = () => Math.floor(Date.now() / 1000);
const num = (v: unknown) => Number(v ?? 0) || 0;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * One short line for a public page: rate limits are named as such, viem's multi-line dumps (URL, request body,
 * raw call arguments, docs link, version) are cut to their first sentence.
 */
export function friendlyError(e: unknown): string {
  if (isRateLimited(e)) return "Arc RPC rate limit; retrying shortly";
  const ex = e as { shortMessage?: string; message?: string } | null;
  const raw = String(ex?.shortMessage ?? ex?.message ?? e ?? "unknown error");
  const first = raw.split(/\n|URL:|Request body:|Raw Call Arguments:|Contract Call:|Docs:|Details:|Version:/)[0].trim();
  return (first.length > 120 ? `${first.slice(0, 117)}...` : first) || "temporarily unavailable";
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Retry a read when the RPC rate-limits it (0.4 s, then 1.2 s); other errors throw at once. */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, delays: number[] = [400, 1200]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= delays.length || !isRateLimited(e)) throw e;
      await sleepMs(delays[i]);
    }
  }
}

async function safe<T>(name: string, errors: Record<string, string>, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    errors[name] = friendlyError(e);
    return null;
  }
}

/** Last successful chain read of float/yield, served (with its age) when a live read fails. */
let lastGoodChain: { at: number; value: { floatUsdc: number; yieldUsdc: number; positions: YieldPosition[] } } | null = null;
const LAST_GOOD_MAX_AGE_S = 6 * 3600;
export function __resetReservesCache(): void { lastGoodChain = null; }

function ownWalletFilter(): { clause: string; args: string[] } {
  const own = (process.env.OWN_WALLETS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { clause: own.length ? `AND payer NOT IN (${own.map(() => "?").join(",")})` : "", args: own };
}

export async function revenueSnapshot(at = now()): Promise<RevenueSnapshot> {
  await migrate();
  const d = db();
  const own = ownWalletFilter();
  const sum = (since: number) => d.execute({ sql: `SELECT COALESCE(SUM(amount_usdc),0) AS s, COUNT(*) AS n FROM payments WHERE refunded = 0 AND created_at >= ?`, args: [since] });
  const [h24, d7, all, refunds, outside] = await Promise.all([
    sum(at - 86_400),
    sum(at - 7 * 86_400),
    d.execute(`SELECT COALESCE(SUM(amount_usdc),0) AS s, COUNT(*) AS n, COUNT(DISTINCT payer) AS payers FROM payments WHERE refunded = 0`),
    d.execute(`SELECT COALESCE(SUM(amount_usdc),0) AS s, COUNT(*) AS n FROM payments WHERE refunded != 0`),
    d.execute({ sql: `SELECT COUNT(*) AS n FROM payments WHERE refunded = 0 AND created_at >= ? ${own.clause}`, args: [at - 48 * 3600, ...own.args] }),
  ]);
  const row = (r: { rows: unknown[] }) => r.rows[0] as Record<string, unknown>;
  return {
    last24hUsdc: r6(num(row(h24).s)), last7dUsdc: r6(num(row(d7).s)), totalUsdc: r6(num(row(all).s)),
    payers: num(row(all).payers), callsPaid: num(row(all).n), callsPaid24h: num(row(h24).n), outsideCalls48h: num(row(outside).n),
    refunds: num(row(refunds).n), refundedUsdc: r6(num(row(refunds).s)),
  };
}

/** Revenue-wallet USDC + USYC straight from Arc (legacy backend; read-only; 6 s timeout). */
async function usycReserves(env: ReturnType<typeof usycEnv>): Promise<{ floatUsdc: number; yieldUsdc: number; positions: YieldPosition[] } | null> {
  if (!env.wallet) return null;
  const cfg = config();
  const pub = createPublicClient({ chain: arcChain(), transport: http(cfg.ARC_RPC_URL, { timeout: 6_000, retryCount: 0 }) });
  const usdcRaw = await pub.readContract({ address: cfg.USDC_ADDRESS as ViemAddress, abi: erc20Abi, functionName: "balanceOf", args: [env.wallet] });
  let usycRaw = 0n;
  let usycUsdcRaw = 0n;
  if (env.usyc) {
    usycRaw = await pub.readContract({ address: env.usyc, abi: erc20Abi, functionName: "balanceOf", args: [env.wallet] }).catch(() => 0n);
    usycUsdcRaw = usycRaw === 0n || !env.teller ? usycRaw : await pub.readContract({ address: env.teller, abi: tellerAbi, functionName: "convertToAssets", args: [usycRaw] }).catch(() => usycRaw);
  }
  const yieldUsdc = Number(formatUnits(usycUsdcRaw, 6));
  const positions: YieldPosition[] = usycRaw > 0n && env.usyc ? [{ vault: env.usyc, name: "USYC", shares: Number(formatUnits(usycRaw, 6)), assetsUsdc: yieldUsdc }] : [];
  return { floatUsdc: Number(formatUnits(usdcRaw, 6)), yieldUsdc, positions };
}

/** Circle wallets view (balances from Circle when live). */
async function circleView(): Promise<ReservesSnapshot["circle"]> {
  const status = circleStatus();
  const stored = await listStoredWallets();
  const wallets: CircleWalletView[] = [];
  for (const role of ["revenue", "ops"] as const) {
    const w = stored.find((x) => x.role === role) ?? null;
    try {
      const b = status.enabled ? await circleBalances(role) : null;
      wallets.push({ role, address: w?.address ?? null, accountType: w?.accountType ?? null, policy: w?.policy ?? null, balances: b?.balances ?? [], status: b?.status ?? (w ? "dry-run" : "not-provisioned"), reason: b?.reason ?? status.reason });
    } catch (e) {
      wallets.push({ role, address: w?.address ?? null, accountType: w?.accountType ?? null, policy: w?.policy ?? null, balances: [], status: "error", reason: friendlyError(e) });
    }
  }
  return { enabled: status.enabled, reason: status.reason, blockchain: status.blockchain, wallets };
}

export async function reservesSnapshot(): Promise<ReservesSnapshot> {
  const backend = yieldBackend();
  const yenv = yieldEnv();
  const uenv = usycEnv();
  const base: ReservesSnapshot = {
    floatUsdc: null, yieldUsdc: null, positions: [], revenueWallet: backend === "earn" ? yenv.wallet : uenv.wallet,
    yieldBackend: backend, yieldMode: backend === "earn" ? yenv.mode : uenv.mode,
    yieldFloatUsdc: backend === "earn" ? yenv.floatUsdc : uenv.floatUsdc, yieldMinSweepUsdc: backend === "earn" ? yenv.minSweepUsdc : uenv.minSweepUsdc,
    yieldMaxSweepUsdc: backend === "earn" ? yenv.maxSweepUsdc : 0,
    vaults: null, yieldPolicy: null, preferredVault: null,
    circle: { enabled: false, blockchain: null, wallets: [] },
  };
  const chain = withRateLimitRetry(async () => {
    if (backend === "usyc") return usycReserves(uenv);
    const ctx = await yieldContext(yenv);
    base.vaults = ctx.vaults; base.yieldPolicy = ctx.policy;
    if (ctx.error) base.vaultsError = friendlyError(ctx.error);
    if (!yenv.wallet) return null;
    const st = await readYieldState(yenv.wallet, ctx.vaults, yenv.policy.pinnedVault ? [yenv.policy.pinnedVault] : []);
    const positions = st.positions.map(({ sharesRaw: _s, ...p }) => p);
    if (ctx.vaults) {
      const v = chooseDepositVault(ctx.vaults, Math.max(yenv.minSweepUsdc, 0.000001), positions, ctx.policy).vault;
      base.preferredVault = v ? { address: v.address, name: v.name, apy: v.apy, availableUsdc: v.availableUsdc, tvlUsdc: v.tvlUsdc } : null;
    }
    return { floatUsdc: st.balanceUsdc, yieldUsdc: r6(positions.reduce((s, p) => s + p.assetsUsdc, 0)), positions };
  });
  const [c, circle] = await Promise.allSettled([chain, circleView()]);
  if (c.status === "fulfilled" && c.value) {
    Object.assign(base, c.value);
    if (backend === "earn") lastGoodChain = { at: now(), value: c.value as { floatUsdc: number; yieldUsdc: number; positions: YieldPosition[] } };
  } else if (c.status === "rejected") {
    base.error = friendlyError(c.reason);
    if (lastGoodChain && now() - lastGoodChain.at <= LAST_GOOD_MAX_AGE_S) {
      Object.assign(base, lastGoodChain.value);
      base.floatAsOf = new Date(lastGoodChain.at * 1000).toISOString();
    }
  }
  if (circle.status === "fulfilled") base.circle = circle.value;
  else base.circle = { enabled: false, reason: friendlyError(circle.reason), blockchain: null, wallets: [] };
  return base;
}

export async function obligationsSnapshot(at = now()): Promise<ObligationsSnapshot> {
  const status = treasuryStatus();
  const [pending, totals, spent] = await Promise.all([pendingInvoices(), invoiceTotals(), spentToday(at)]);
  const policy = status.policy ?? policyFromEnv(process.env, status.mode === "live");
  const pendingUsdc = r6(pending.reduce((s, i) => s + i.amountUsdc, 0));
  const headroom = r6(Math.max(0, policy.dailyCapUsdc - spent));
  return {
    pendingInvoices: pending.length, pendingUsdc, heldInvoices: totals.held, heldUsdc: totals.heldUsdc,
    dueTodayUsdc: r6(Math.min(pendingUsdc, headroom)), due48hUsdc: pendingUsdc,
    paidInvoices: totals.paid + totals.limited, paidUsdc: totals.paidUsdc, spentTodayUsdc: r6(spent), dailyHeadroomUsdc: headroom, policy,
  };
}

export async function screeningSnapshot(at = now()): Promise<ScreeningSnapshot> {
  await migrate();
  const d = db();
  const [byTier, total, watches] = await Promise.all([
    d.execute({ sql: `SELECT tier, COUNT(*) AS n FROM screenings WHERE created_at >= ? GROUP BY tier`, args: [at - 86_400] }),
    d.execute(`SELECT COUNT(*) AS n FROM screenings`),
    d.execute({ sql: `SELECT COUNT(*) AS n FROM watches WHERE expires_at > ?`, args: [at] }),
  ]);
  const t: Record<string, number> = {};
  for (const r of byTier.rows as unknown as Record<string, unknown>[]) t[String(r.tier)] = num(r.n);
  const high = t.HIGH ?? 0, medium = t.MEDIUM ?? 0, low = t.LOW ?? 0;
  return { screenings24h: high + medium + low, high24h: high, medium24h: medium, low24h: low, screeningsTotal: num((total.rows[0] as Record<string, unknown>).n), watchesActive: num((watches.rows[0] as Record<string, unknown>).n), p95LatencyMs: null };
}

export async function pricingSnapshot(): Promise<PricingSnapshot> {
  const [screen, watch] = await Promise.all([priceState("screen", { fresh: true }), priceState("watch", { fresh: true })]);
  const latest = [screen, watch].filter((p) => p.changedAt != null).sort((a, b) => (b.changedAt ?? 0) - (a.changedAt ?? 0))[0];
  return { screenUsdc: screen.priceUsdc, watchUsdc: watch.priceUsdc, lastChangeAt: latest?.changedAt ?? null, reason: latest ? `${latest.key}: ${latest.reason}` : "config defaults (operator has not changed prices)", screen, watch };
}

export function modeSnapshot(): ModeSnapshot {
  const ts = treasuryStatus();
  const c = config();
  return {
    treasury: ts.mode, yield: yieldBackend() === "earn" ? yieldEnv().mode : usycEnv().mode, yieldBackend: yieldBackend(), signer: signerMode(), circle: circleStatus().enabled ? "live" : "dry-run",
    x402: c.X402_DISABLED ? "disabled" : "enabled", paused: c.COMPLIR_PAUSED, chainId: c.ARC_CHAIN_ID, explorerUrl: c.ARC_EXPLORER_URL, treasuryAddress: ts.treasuryAddress,
  };
}

/** The whole company in one read. Never throws; failed sections are null and listed in `errors`. */
export async function companySnapshot(): Promise<CompanySnapshot> {
  const errors: Record<string, string> = {};
  const at = now();
  const [revenue, reserves, obligations, screening, pricing, mode] = await Promise.all([
    safe("revenue", errors, () => revenueSnapshot(at)),
    safe("reserves", errors, () => reservesSnapshot()),
    safe("obligations", errors, () => obligationsSnapshot(at)),
    safe("screening", errors, () => screeningSnapshot(at)),
    safe("pricing", errors, () => pricingSnapshot()),
    safe("mode", errors, async () => modeSnapshot()),
  ]);
  return { revenue, reserves, obligations, screening, pricing, mode, errors, asOf: new Date(at * 1000).toISOString() };
}
