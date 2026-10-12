/**
 * Circle Developer-Controlled Wallets client (official SDK `@circle-fin/developer-controlled-wallets`).
 *
 * Everything here is env-driven and safe without credentials: `circleEnabled()` is false until both
 * CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET are set, and callers report a dry-run instead of throwing.
 *
 * Chain mapping (Circle "blockchain" enum, verified against the SDK types and
 * https://developers.circle.com/wallets/supported-blockchains):
 *   Arc mainnet 5042    → "ARC"
 *   Arc testnet 5042002 → "ARC-TESTNET"
 */
import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { config } from "../config";

export type CircleBlockchain = "ARC" | "ARC-TESTNET";

const BLOCKCHAIN_BY_CHAIN_ID: Record<number, CircleBlockchain> = {
  5042: "ARC",
  5042002: "ARC-TESTNET",
};

/** Circle blockchain id for a chain id, or null when Circle has no wallet support for it. */
export function circleBlockchainFor(chainId: number): CircleBlockchain | null {
  return BLOCKCHAIN_BY_CHAIN_ID[chainId] ?? null;
}

/** Circle blockchain id for the configured ARC_CHAIN_ID (null → unsupported chain). */
export function circleBlockchain(): CircleBlockchain | null {
  return circleBlockchainFor(config().ARC_CHAIN_ID);
}

export interface CircleStatus {
  enabled: boolean;
  /** Human-readable reason when disabled. */
  reason?: string;
  blockchain: CircleBlockchain | null;
  signerMode: "local" | "circle";
  accountType: "SCA" | "EOA";
  feeLevel: "LOW" | "MEDIUM" | "HIGH";
}

const ENTITY_SECRET_RE = /^[0-9a-fA-F]{64}$/;

/** Why Circle is (not) usable right now. Never throws. */
export function circleStatus(): CircleStatus {
  const c = config();
  const base = {
    blockchain: circleBlockchain(),
    signerMode: c.SIGNER_MODE,
    accountType: c.CIRCLE_ACCOUNT_TYPE,
    feeLevel: c.CIRCLE_FEE_LEVEL,
  } as const;
  const missing: string[] = [];
  if (!c.CIRCLE_API_KEY) missing.push("CIRCLE_API_KEY");
  if (!c.CIRCLE_ENTITY_SECRET) missing.push("CIRCLE_ENTITY_SECRET");
  if (missing.length) return { ...base, enabled: false, reason: `${missing.join(" + ")} unset → dry-run` };
  if (!ENTITY_SECRET_RE.test(c.CIRCLE_ENTITY_SECRET!)) {
    return { ...base, enabled: false, reason: "CIRCLE_ENTITY_SECRET must be 32 bytes hex (64 chars) — see docs/CIRCLE_WALLETS.md" };
  }
  if (!base.blockchain) return { ...base, enabled: false, reason: `ARC_CHAIN_ID=${c.ARC_CHAIN_ID} has no Circle blockchain id (5042→ARC, 5042002→ARC-TESTNET)` };
  return { ...base, enabled: true };
}

export function circleEnabled(): boolean {
  return circleStatus().enabled;
}

let cached: CircleDeveloperControlledWalletsClient | null = null;

/** SDK client. Throws when Circle is not configured — check `circleEnabled()` first. */
export function circleClient(): CircleDeveloperControlledWalletsClient {
  if (cached) return cached;
  const s = circleStatus();
  if (!s.enabled) throw new Error(`circle: ${s.reason}`);
  const c = config();
  cached = initiateDeveloperControlledWalletsClient({
    apiKey: c.CIRCLE_API_KEY!,
    entitySecret: c.CIRCLE_ENTITY_SECRET!,
    ...(c.CIRCLE_BASE_URL ? { baseUrl: c.CIRCLE_BASE_URL } : {}),
  });
  return cached;
}

/** test helper */
export function __resetCircleClient() {
  cached = null;
}
