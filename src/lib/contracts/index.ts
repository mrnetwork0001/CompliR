/**
 * Typed ABIs + constants for the CompliR on-chain contracts (contracts/src).
 *
 * The ABI files are generated - regenerate with:
 *   cd contracts && forge build && node scripts/export-abi.mjs
 */
import { TIER_ONCHAIN } from "../types";

export { registryAbi } from "./registryAbi";
export { guardedTreasuryAbi } from "./guardedTreasuryAbi";

/**
 * Mirror of `ICompliR.Tier` (contracts/src/ICompliR.sol). The numeric values are part of the
 * public ABI; `UNKNOWN` means never attested or revoked and is never written by `attest`.
 */
export enum REGISTRY_TIER {
  UNKNOWN = 0,
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
}

/** Compile-time guard: REGISTRY_TIER must agree with TIER_ONCHAIN in src/lib/types.ts. */
const _tierParity: Record<keyof typeof TIER_ONCHAIN, REGISTRY_TIER> = {
  LOW: REGISTRY_TIER.LOW,
  MEDIUM: REGISTRY_TIER.MEDIUM,
  HIGH: REGISTRY_TIER.HIGH,
};
void _tierParity;

/** Runtime check (cheap; call from tests or startup) that the two tier tables agree. */
export function assertTierParity(): void {
  for (const [name, n] of Object.entries(TIER_ONCHAIN)) {
    if (REGISTRY_TIER[name as keyof typeof REGISTRY_TIER] !== n) {
      throw new Error(`REGISTRY_TIER.${name} (${REGISTRY_TIER[name as keyof typeof REGISTRY_TIER]}) != TIER_ONCHAIN.${name} (${n})`);
    }
  }
}

/** Human label for an on-chain tier value (e.g. from `tierOf`). */
export function registryTierName(n: number): keyof typeof REGISTRY_TIER {
  const name = REGISTRY_TIER[n as REGISTRY_TIER];
  if (name === undefined) throw new Error(`registry: unknown tier value ${n}`);
  return name as keyof typeof REGISTRY_TIER;
}

/** Arc chain ids used by the deploy scripts (contracts/README.md). */
export const ARC_CHAIN_IDS = {
  testnet: 5042002,
  mainnet: 5042,
} as const;
