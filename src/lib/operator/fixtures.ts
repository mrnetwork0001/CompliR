/** Test fixture: a healthy, fully-populated company snapshot (dry-run everywhere, x402 enabled). */
import type { YieldPolicy } from "../earn/planner";
import type { YieldVault } from "../earn/vaults";
import type { CompanySnapshot } from "./state";

export const USDC = "0x0000000000000000000000000000000000000001";
export function vault(over: Partial<YieldVault> & { address: `0x${string}` }): YieldVault {
  return {
    name: "Vault", asset: "USDC", assetAddress: USDC, protocol: "MORPHO", apy: 0.03, apy7d: null, apy30d: null, availableUsdc: 1_000_000, tvlUsdc: 5_000_000,
    status: "active", illiquid: false, circleSentinel: true, warnings: [], earnKitWarnings: [], curator: "Curator", performanceFee: 0, asOf: null, ...over,
  };
}
export const VAULT_A = vault({ address: "0x00000000000000000000000000000000000000a1", name: "Steakhouse Prime USDC", apy: 0.0306 });
export const VAULT_B = vault({ address: "0x00000000000000000000000000000000000000b2", name: "Lower APY USDC", apy: 0.02 });
export const VAULT_ILLIQUID = vault({ address: "0x00000000000000000000000000000000000000c3", name: "Galaxy USDC", apy: 0.05, status: "low_liquidity", illiquid: true });
export const POLICY: YieldPolicy = { usdcAddress: USDC, minTvlUsdc: 100_000, requireSentinel: true, liquidityMultiple: 2, pinnedVault: null, contractAllowlist: [] };

export const NOW = 1_800_000_000;

export function snap(over: Partial<CompanySnapshot> = {}): CompanySnapshot {
  const base: CompanySnapshot = {
    revenue: { last24hUsdc: 0.5, last7dUsdc: 2, totalUsdc: 4, payers: 3, callsPaid: 400, callsPaid24h: 10, outsideCalls48h: 4, refunds: 0, refundedUsdc: 0 },
    reserves: {
      floatUsdc: 20, yieldUsdc: 50, revenueWallet: "0x00000000000000000000000000000000000000aa",
      positions: [{ vault: VAULT_A.address, name: VAULT_A.name, shares: 49, assetsUsdc: 50 }],
      yieldBackend: "earn", yieldMode: "dry", yieldFloatUsdc: 5, yieldMinSweepUsdc: 1, yieldMaxSweepUsdc: 25,
      vaults: [VAULT_A, VAULT_B, VAULT_ILLIQUID], yieldPolicy: POLICY, preferredVault: null,
      circle: { enabled: false, reason: "CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET unset → dry-run", blockchain: "ARC", wallets: [] },
    },
    obligations: {
      pendingInvoices: 2, pendingUsdc: 8, heldInvoices: 1, heldUsdc: 50, dueTodayUsdc: 8, due48hUsdc: 8, paidInvoices: 1, paidUsdc: 10, spentTodayUsdc: 10, dailyHeadroomUsdc: 40,
      policy: { maxTier: "MEDIUM", perPayoutCapUsdc: 25, dailyCapUsdc: 50, requireAttestationOnChain: false },
    },
    screening: { screenings24h: 12, high24h: 2, medium24h: 3, low24h: 7, screeningsTotal: 500, watchesActive: 4, p95LatencyMs: null },
    pricing: {
      screenUsdc: 0.01, watchUsdc: 0.05, lastChangeAt: null, reason: "config defaults",
      screen: { key: "screen", priceUsdc: 0.01, reason: "config default", changedAt: null, source: "config" },
      watch: { key: "watch", priceUsdc: 0.05, reason: "config default", changedAt: null, source: "config" },
    },
    mode: { treasury: "dry-run", yield: "dry", yieldBackend: "earn", signer: "local", circle: "dry-run", x402: "enabled", paused: false, chainId: 5042, explorerUrl: "https://explorer.arc.io", treasuryAddress: null },
    errors: {},
    asOf: new Date(NOW * 1000).toISOString(),
  };
  return { ...base, ...over };
}
