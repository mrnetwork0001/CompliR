/**
 * Company snapshot - everything the operator agent (and the /company page) needs to see in one object.
 *
 * Reads only: revenue from the `payments` table, reserves from the revenue wallet on Arc (+ USYC) and the Circle
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
import { priceState, type PriceState } from "./pricing";

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
  /** USYC holding valued in USDC */
  usycUsdc: number | null;
  usycShares: number | null;
  revenueWallet: string | null;
  usycMode: "dry" | "live";
  usycFloatUsdc: number;
  usycMinSweepUsdc: number;
  circle: { enabled: boolean; reason?: string; blockchain: string | null; wallets: CircleWalletView[] };
  error?: string;
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
  usyc: "dry" | "live";
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

async function safe<T>(name: string, errors: Record<string, string>, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    errors[name] = (e as Error)?.message ?? String(e);
    return null;
  }
}

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

/** Revenue-wallet USDC + USYC straight from Arc (read-only; 6 s timeout). */
async function chainReserves(env: ReturnType<typeof usycEnv>): Promise<{ floatUsdc: number; usycUsdc: number; usycShares: number } | null> {
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
  return { floatUsdc: Number(formatUnits(usdcRaw, 6)), usycUsdc: Number(formatUnits(usycUsdcRaw, 6)), usycShares: Number(formatUnits(usycRaw, 6)) };
}

export async function reservesSnapshot(): Promise<ReservesSnapshot> {
  const env = usycEnv();
  const base: ReservesSnapshot = {
    floatUsdc: null, usycUsdc: null, usycShares: null, revenueWallet: env.wallet, usycMode: env.mode, usycFloatUsdc: env.floatUsdc, usycMinSweepUsdc: env.minSweepUsdc,
    circle: { enabled: false, blockchain: null, wallets: [] },
  };
  const [chain, circle] = await Promise.allSettled([
    chainReserves(env),
    (async () => {
      const status = circleStatus();
      const stored = await listStoredWallets();
      const wallets: CircleWalletView[] = [];
      for (const role of ["revenue", "ops"] as const) {
        const w = stored.find((x) => x.role === role) ?? null;
        try {
          const b = status.enabled ? await circleBalances(role) : null;
          wallets.push({ role, address: w?.address ?? null, accountType: w?.accountType ?? null, policy: w?.policy ?? null, balances: b?.balances ?? [], status: b?.status ?? (w ? "dry-run" : "not-provisioned"), reason: b?.reason ?? status.reason });
        } catch (e) {
          wallets.push({ role, address: w?.address ?? null, accountType: w?.accountType ?? null, policy: w?.policy ?? null, balances: [], status: "error", reason: (e as Error)?.message ?? String(e) });
        }
      }
      return { enabled: status.enabled, reason: status.reason, blockchain: status.blockchain, wallets };
    })(),
  ]);
  if (chain.status === "fulfilled" && chain.value) Object.assign(base, chain.value);
  else if (chain.status === "rejected") base.error = `chain read failed: ${(chain.reason as Error)?.message ?? chain.reason}`;
  if (circle.status === "fulfilled") base.circle = circle.value;
  else base.circle = { enabled: false, reason: (circle.reason as Error)?.message ?? String(circle.reason), blockchain: null, wallets: [] };
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
    treasury: ts.mode, usyc: usycEnv().mode, signer: signerMode(), circle: circleStatus().enabled ? "live" : "dry-run",
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
