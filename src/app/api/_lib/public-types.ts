/**
 * Response shapes for the public (free) endpoints that power the UI.
 * Backed by `@/lib/store` (`recentScreenings`, `publicStats`, `latestAttestation`) and `@/lib/ledger`.
 */
import type { Attestation, DecisionLogEntry, ReasonCode, Tier } from "@/lib/types";

export interface HealthResponse {
  ok: boolean;
  chainId: number | null;
  network: {
    chainId: number | null;
    explorerUrl: string;
    usdcAddress: string | null;
    registryAddress: string | null;
    protocolBlocklistAddress: string | null;
  };
  paused: boolean;
  x402: { disabled: boolean; priceScreenUsdc: number; priceWatchUsdc: number };
  signer?: { mode: "local" | "circle"; circle: unknown };
  /** demo addresses the Explorer offers as one-click examples */
  examples: ExampleAddress[];
  time: string;
  error?: string;
}
export interface ExampleAddress {
  label: string;
  address: string;
  expectedTier?: Tier;
}

/** One anonymised screening for the live feed. Address is masked (`0x1234…abcd`). */
export interface FeedItem {
  decisionId: string;
  addressMasked: string;
  tier: Tier;
  score: number;
  reasonCodes: ReasonCode[];
  screenedAt: string; // ISO
  /** "outside" = paid by a wallet we do not control; "own" = our own test wallets; "unknown" = unpaid/free call */
  payer: "own" | "outside" | "unknown";
}
export interface FeedResponse {
  items: FeedItem[];
  limit: number;
  page: number;
  total: number;
  pages: number;
  source: "store";
}

/** GET /api/v1/numbers - honest public counters. Own wallets are always excluded. */
export interface PublicStats {
  screenings: number;
  distinctClients: number;
  outsidePayers: number;
  totalPaidUsdc: number;
  refunds: number;
  watchesActive: number;
  since: string; // ISO
  ownWalletsExcluded: true;
}

/** GET /api/v1/attestation/:address (src/lib/freeVerdict). */
export type AttestationResponse = import("@/lib/freeVerdict").FreeVerdict;

export interface LedgerListResponse {
  entries: (DecisionLogEntry & { registryTx?: string | null })[];
  limit: number;
  page: number;
  total: number;
  pages: number;
}
export interface LedgerVerifyResponse {
  ok: boolean;
  brokenAt: number | null;
  length: number;
  checkedAt: string;
}

export interface ShadowEntry {
  label: string;
  address: string;
  score: number;
  tier: Tier;
  reasonCodes: ReasonCode[];
  wouldHold: boolean;
  wouldLimit: boolean;
}
export interface ShadowPayment {
  to: string;
  amountUsdc: number;
  txHash?: string;
}
export interface ShadowResponse {
  entries: ShadowEntry[];
  summary: { screened: number; wouldHold: number; wouldLimit: number; lookalikes: number };
  paymentsAtRisk: ShadowPayment[];
}

export function maskAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
