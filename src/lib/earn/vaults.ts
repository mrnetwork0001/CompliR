/**
 * Circle Earn Kit vault metadata (Morpho USDC vaults on Arc), read straight from the Earn Service API.
 *
 * Earn Kit (`@circle-fin/earn-kit`, App Kits) is a thin SDK over `https://api.circle.com/v1/earnKit/*`. Vault
 * discovery (`exploreVaults`) is `GET /v1/earnKit/vaults/explore?chain=ARC` and works keyless (the SDK's
 * "permissionless (keyless) client path"); an API key is optional and server-only. We only need the metadata - the
 * deposit/redeem calls are plain ERC-4626 on the vault (Morpho Vault V2), executed from the Circle revenue wallet -
 * so we call the endpoint with fetch instead of pulling the SDK + adapter into the bundle.
 *
 * Per-vault fields we use (types from @circle-fin/provider-earn-service 1.7.1, `EarnOpportunity`):
 *   address, name, asset, assetAddress, apyProfile.{current,d7,d30}, liquidityProfile.{available,totalDeposits,status}
 *   (status 'low_liquidity' = Circle's illiquid flag), riskSignals.{circleSentinel,warnings[{type,level}],earnKitWarnings},
 *   manager.name (curator), asOf.
 */
import { z } from "zod";

export const EARN_API_DEFAULT = "https://api.circle.com";
/** Earn API chain codes (provider-earn-service CHAIN_TO_API). */
export const EARN_API_CHAIN: Record<number, string> = { 5042: "ARC", 5042002: "ARC-TESTNET" };

export interface YieldVault {
  address: `0x${string}`;
  name: string;
  asset: string;
  assetAddress: string;
  protocol: string;
  /** current net APY as a decimal (0.03 = 3%) */
  apy: number;
  apy7d: number | null;
  apy30d: number | null;
  /** withdrawable liquidity right now, in the vault asset (USDC) */
  availableUsdc: number;
  /** total deposits (TVL) in the vault asset */
  tvlUsdc: number;
  status: "active" | "low_liquidity";
  /** Circle flags the vault as illiquid (liquidityProfile.status === "low_liquidity") */
  illiquid: boolean;
  circleSentinel: boolean;
  warnings: { type: string; level: string }[];
  earnKitWarnings: string[];
  curator: string | null;
  performanceFee: number | null;
  asOf: string | null;
}

const AmountSchema = z.object({ raw: z.string(), decimals: z.number() });
const VaultSchema = z.object({
  address: z.string().optional(),
  vaultAddress: z.string().optional(),
  name: z.string().default(""),
  protocol: z.string().default(""),
  asset: z.string().default(""),
  assetAddress: z.string().default(""),
  asOf: z.string().optional(),
  currentApy: z.number().optional(),
  apyProfile: z.object({ current: z.number(), d7: z.number().nullable().optional(), d30: z.number().nullable().optional() }).partial().optional(),
  liquidity: AmountSchema.optional(),
  totalDeposits: AmountSchema.optional(),
  status: z.string().optional(),
  liquidityProfile: z.object({ available: AmountSchema, totalDeposits: AmountSchema, status: z.string() }).partial().optional(),
  circleGuarded: z.boolean().optional(),
  riskSignals: z.object({
    circleSentinel: z.boolean().optional(),
    warnings: z.array(z.object({ type: z.string(), level: z.string() })).nullable().optional(),
    earnKitWarnings: z.array(z.string()).nullable().optional(),
  }).optional(),
  warnings: z.array(z.object({ type: z.string(), level: z.string() })).nullable().optional(),
  manager: z.object({ name: z.string() }).nullable().optional(),
  fee: z.object({ performance: z.number().nullable().optional() }).nullable().optional(),
}).passthrough();
const ExploreSchema = z.object({ data: z.object({ vaults: z.array(z.unknown()), pagination: z.object({ totalPages: z.number().optional() }).partial().optional() }) });

const amt = (a: { raw: string; decimals: number } | undefined): number => {
  if (!a) return 0;
  const n = Number(a.raw) / 10 ** a.decimals;
  return Number.isFinite(n) ? n : 0;
};

/** API vault → YieldVault. Returns null for rows we cannot use (no address). */
export function normalizeVault(raw: unknown): YieldVault | null {
  const p = VaultSchema.safeParse(raw);
  if (!p.success) return null;
  const v = p.data;
  const address = (v.address ?? v.vaultAddress ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  const lp = v.liquidityProfile ?? {};
  const status = (lp.status ?? v.status ?? "active") === "low_liquidity" ? "low_liquidity" : "active";
  return {
    address: address as `0x${string}`,
    name: v.name || address,
    asset: v.asset,
    assetAddress: v.assetAddress.toLowerCase(),
    protocol: v.protocol,
    apy: v.apyProfile?.current ?? v.currentApy ?? 0,
    apy7d: v.apyProfile?.d7 ?? null,
    apy30d: v.apyProfile?.d30 ?? null,
    availableUsdc: amt(lp.available ?? v.liquidity),
    tvlUsdc: amt(lp.totalDeposits ?? v.totalDeposits),
    status,
    illiquid: status === "low_liquidity",
    circleSentinel: v.riskSignals?.circleSentinel ?? v.circleGuarded ?? false,
    warnings: v.riskSignals?.warnings ?? v.warnings ?? [],
    earnKitWarnings: v.riskSignals?.earnKitWarnings ?? [],
    curator: v.manager?.name ?? null,
    performanceFee: v.fee?.performance ?? null,
    asOf: v.asOf ?? null,
  };
}

export interface FetchVaultsOptions {
  chainId: number;
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** bypass the 5-minute cache */
  fresh?: boolean;
}

const CACHE_MS = 5 * 60_000;
let cache: { key: string; at: number; vaults: YieldVault[] } | null = null;
/** test helper */
export function __resetVaultCache() { cache = null; }

/** All Earn vaults on the chain (USDC + EURC; filter by asset in the planner). Throws on HTTP/shape errors. */
export async function fetchEarnVaults(opts: FetchVaultsOptions): Promise<YieldVault[]> {
  const chain = EARN_API_CHAIN[opts.chainId];
  if (!chain) throw new Error(`earn: chain ${opts.chainId} is not supported by Circle Earn (Arc mainnet 5042 / testnet 5042002)`);
  const base = opts.baseUrl ?? EARN_API_DEFAULT;
  const key = `${base}|${chain}`;
  if (!opts.fresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.vaults;
  const f = opts.fetchImpl ?? fetch;
  const out: YieldVault[] = [];
  for (let page = 1, pages = 1; page <= pages && page <= 10; page++) {
    const url = new URL("/v1/earnKit/vaults/explore", base);
    url.searchParams.set("chain", chain);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("page", String(page));
    const r = await f(url.toString(), {
      headers: { accept: "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    });
    if (!r.ok) throw new Error(`earn: GET ${url.pathname} → HTTP ${r.status}`);
    const body = ExploreSchema.parse(await r.json());
    for (const raw of body.data.vaults) { const v = normalizeVault(raw); if (v) out.push(v); }
    pages = body.data.pagination?.totalPages ?? 1;
  }
  cache = { key, at: Date.now(), vaults: out };
  return out;
}
