/**
 * CompliR shared types. Single source of truth for every module.
 * Spec: COMPLIR_PROJECT_SPEC.md §2.2. Change here first, then everywhere.
 */
import { z } from "zod";

export type Address = `0x${string}`;
export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "invalid EVM address")
  .transform((s) => s.toLowerCase() as Address);

// ─── Tiers ──────────────────────────────────────────────────────────────────
export const TIERS = ["LOW", "MEDIUM", "HIGH"] as const;
export type Tier = (typeof TIERS)[number];
/** Must match ICompliR.Tier enum in contracts/src/ICompliR.sol (UNKNOWN=0,LOW=1,MEDIUM=2,HIGH=3). */
export const TIER_ONCHAIN: Record<Tier, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
export const TIER_BANDS: Record<Tier, { min: number; max: number }> = {
  LOW: { min: 0, max: 20 },
  MEDIUM: { min: 21, max: 60 },
  HIGH: { min: 61, max: 100 },
};
export function tierForScore(score: number): Tier {
  if (score <= 20) return "LOW";
  if (score <= 60) return "MEDIUM";
  return "HIGH";
}

// ─── Reason codes (deterministic rules emit these) ───────────────────────────
export const REASON_CODES = [
  "SANCTIONS_DIRECT", // address or resolved entity hit in OpenSanctions/yente
  "USDC_BLACKLISTED", // Circle USDC isBlacklisted(addr) == true
  "PROTOCOL_BLOCKLISTED", // Arc protocol blocklist
  "FUNDER_1HOP_SANCTIONED", // a wallet that funded the subject is sanctioned
  "FUNDER_2HOP_SANCTIONED", // a wallet that funded a funder is sanctioned
  "FUNDER_1HOP_BLACKLISTED",
  "FUNDER_2HOP_BLACKLISTED",
  "FRESH_WALLET", // first seen < 7 days or < 5 txs
  "LOOKALIKE_OF_KNOWN_PAYEE", // address poisoning / lookalike vs client payee book
  "PAYEE_ADDRESS_CHANGED", // same payee name, new address
  "HIGH_CONCENTRATION", // shares funder with many other payees (Tamias signal)
  "PRIOR_HIGH_TIER", // our own history: was HIGH within last 30 days
  "NO_HISTORY", // zero on-chain footprint on Arc
  "NETWORK_HELD_ELSEWHERE", // shared-oracle signal: other integrators rated this address HIGH in the last 7 days (anonymised count)
  "NETWORK_SHARED_FUNDER", // shares a hop-1 funder with ≥3 of this client's own payees (src/lib/network)
  "COMMUNITY_TIP_VERIFIED", // a staked community tip about this address was verified by the agent (src/lib/tips)
  "CLEAN", // explicit positive: no signals
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  code: ReasonCode;
  /** points contributed to the score (0–100 total after clamp) */
  weight: number;
  /** anything a reviewer needs to click through: tx hashes, paths, names, timestamps */
  evidence: Record<string, unknown>;
}

// ─── Evidence bundle (Evidence Collector output → scoring input) ─────────────
export interface FunderHop {
  from: Address;
  to: Address;
  txHash: `0x${string}`;
  amountUsdc: string; // decimal string, 6dp
  timestamp: number; // unix seconds
}
export interface SanctionsHit {
  source: "opensanctions"; // extend later
  entityId: string;
  caption: string;
  datasets: string[];
  score: number; // matcher confidence 0–1
  matchedOn: "address" | "name";
}
export interface AddressFacts {
  address: Address;
  firstSeen: number | null; // unix seconds; null = never seen
  txCount: number;
  usdcBlacklisted: boolean;
  protocolBlocklisted: boolean;
  sanctions: SanctionsHit[];
}
export interface EvidenceBundle {
  subject: AddressFacts;
  /** hop 1: wallets that sent USDC to subject; hop 2: wallets that sent USDC to those */
  funders: { hop: 1 | 2; path: FunderHop[]; facts: AddressFacts }[];
  lookalikes: { payeeLabel: string; payeeAddress: Address; similarity: number }[];
  payeeChanged: { payeeLabel: string; previousAddress: Address } | null;
  concentration: { sharedFunder: Address; otherPayees: number } | null;
  priorTier: { tier: Tier; at: number } | null;
  collectedAt: number;
  /** how deep we actually went (agent may stop at hop 1) */
  depth: 0 | 1 | 2;
  /** cross-client network signal (src/lib/network): anonymised counts only, never other clients' ids. null/absent = store unavailable. */
  network?: NetworkSignal | null;
  /** verified community tips (tip market); counts + categories only */
  communityTips?: { tipId: string; category: string; strength: string; verifiedAt: number }[];
}

/** What only a shared oracle can say. Every field is a count or the subject's OWN funder — no other client is identifiable. */
export interface NetworkSignal {
  /** distinct OTHER (non-internal) clients whose screen rated the subject HIGH inside the window */
  heldElsewhere: { clients: number; lastAt: number | null };
  /** the subject shares a hop-1 funder with `count` of THIS client's other payees (0 when clientId is null) */
  sharedFunder: { count: number; funder: Address | null };
  /** network-wide: a hop-1 funder of the subject also funded `otherPayees` other payees / graded nodes (null below threshold) */
  concentrationHint: { funder: Address; otherPayees: number } | null;
  windowDays: number;
}

// ─── Request ─────────────────────────────────────────────────────────────────
export const PayeeBookEntrySchema = z.object({
  label: z.string().min(1).max(80),
  address: AddressSchema,
});
export const ScreenRequestSchema = z.object({
  address: AddressSchema,
  /** optional legal/display name for name-based sanctions matching */
  name: z.string().min(2).max(200).optional(),
  amountUsdc: z.number().nonnegative().optional(),
  payeeBook: z.array(PayeeBookEntrySchema).max(500).optional(),
  /** opaque client id (x402 payer address or API key id) */
  clientId: z.string().max(100).optional(),
  /** force full 2-hop (otherwise the analyst decides) */
  depth: z.union([z.literal(1), z.literal(2)]).optional(),
});
export type ScreenRequest = z.infer<typeof ScreenRequestSchema>;
export type PayeeBookEntry = z.infer<typeof PayeeBookEntrySchema>;

// ─── Analyst (LLM) decision — rules own score/tier; analyst owns the rest ────
export interface AnalystDecision {
  recommendedLimits: { maxPerTxUsdc: number; maxPerDayUsdc: number };
  rationale: string;
  eddRequested: string[];
  nextRescreenAt: number; // unix seconds
  /** "go deeper" request issued before final decision; pipeline honours it once */
  requestDepth?: 2;
}

// ─── Attestation (EIP-712, signed by CompliR attester key) ───────────────────
export interface AttestationTypedData {
  domain: { name: "CompliR"; version: "1"; chainId: number; verifyingContract: Address };
  types: {
    Attestation: { name: string; type: string }[];
  };
  primaryType: "Attestation";
  message: {
    subject: Address;
    tier: number; // TIER_ONCHAIN
    score: number;
    decisionHash: `0x${string}`; // keccak256 of canonical decision JSON
    issuedAt: number;
    validUntil: number;
  };
}
export interface Attestation {
  typedData: AttestationTypedData;
  signature: `0x${string}`;
  attester: Address;
  validUntil: number;
  /** tx hash once written to AttestationRegistry; null until then */
  registryTx: `0x${string}` | null;
}

// ─── Verdict (API response) ──────────────────────────────────────────────────
export interface Verdict {
  address: Address;
  score: number;
  tier: Tier;
  recommendedLimits: { maxPerTxUsdc: number; maxPerDayUsdc: number };
  reasons: Reason[];
  rationale: string;
  eddRequested: string[];
  nextRescreenAt: string; // ISO
  attestation: Attestation;
  decisionId: string;
  screenedAt: string; // ISO
  evidence: EvidenceBundle;
  /** Enhanced Due Diligence request the payer can forward to the counterparty (MEDIUM/HIGH only). */
  edd?: { id: string; url: string } | null;
}

// ─── Decision log (hash-chained, Merkle-anchored) ────────────────────────────
export type DecisionKind = "SCREEN" | "RESCREEN" | "TIER_CHANGE" | "EDD_RESPONSE" | "NOOP" | "ANCHOR" | "PAYOUT" | "OPERATOR" | "TIP" | "REFUND" | "REPORT";
export interface DecisionLogEntry {
  id: string; // dec_<ulid>
  seq: number; // monotonically increasing
  kind: DecisionKind;
  subject: Address | null;
  clientId: string | null;
  payload: unknown; // Verdict (without evidence duplication) or event body
  prevHash: `0x${string}`;
  hash: `0x${string}`; // keccak256(prevHash || canonical(payload) || seq || kind)
  createdAt: number;
  anchorTx: `0x${string}` | null;
}

// ─── Watch ───────────────────────────────────────────────────────────────────
export const WatchRequestSchema = z.object({
  address: AddressSchema,
  webhookUrl: z.string().url(),
  clientId: z.string().max(100).optional(),
  payeeBook: z.array(PayeeBookEntrySchema).max(500).optional(),
});
export type WatchRequest = z.infer<typeof WatchRequestSchema>;
export interface Watch {
  id: string;
  address: Address;
  webhookUrl: string;
  clientId: string | null;
  lastTier: Tier | null;
  nextRescreenAt: number;
  expiresAt: number;
  createdAt: number;
}
export interface TierChangeEvent {
  type: "tier.changed";
  address: Address;
  from: Tier | null;
  to: Tier;
  verdict: Omit<Verdict, "evidence">;
  registryTx: `0x${string}` | null;
}
