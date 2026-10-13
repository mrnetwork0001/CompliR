/** Test fixture: a healthy, fully-populated company snapshot (dry-run everywhere, x402 enabled). */
import type { CompanySnapshot } from "./state";

export const NOW = 1_800_000_000;

export function snap(over: Partial<CompanySnapshot> = {}): CompanySnapshot {
  const base: CompanySnapshot = {
    revenue: { last24hUsdc: 0.5, last7dUsdc: 2, totalUsdc: 4, payers: 3, callsPaid: 400, callsPaid24h: 10, outsideCalls48h: 4, refunds: 0, refundedUsdc: 0 },
    reserves: {
      floatUsdc: 20, usycUsdc: 50, usycShares: 49, revenueWallet: "0x00000000000000000000000000000000000000aa", usycMode: "dry", usycFloatUsdc: 5, usycMinSweepUsdc: 1,
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
    mode: { treasury: "dry-run", usyc: "dry", signer: "local", circle: "dry-run", x402: "enabled", paused: false, chainId: 5042, explorerUrl: "https://explorer.arc.io", treasuryAddress: null },
    errors: {},
    asOf: new Date(NOW * 1000).toISOString(),
  };
  return { ...base, ...over };
}
