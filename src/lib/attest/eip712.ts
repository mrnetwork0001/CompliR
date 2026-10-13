/**
 * EIP-712 attestation signed by the CompliR attester key and mirrored by AttestationRegistry.sol.
 *
 * Solidity must use exactly:
 *   EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
 *     name = "CompliR", version = "1"
 *   Attestation(address subject,uint8 tier,uint8 score,bytes32 decisionHash,uint64 issuedAt,uint64 validUntil)
 */
import { hashTypedData, keccak256, stringToHex, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TIER_ONCHAIN, type Address, type Attestation, type AttestationTypedData, type Tier } from "../types";

export const ATTESTATION_DOMAIN_NAME = "CompliR" as const;
export const ATTESTATION_DOMAIN_VERSION = "1" as const;

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "subject", type: "address" },
    { name: "tier", type: "uint8" },
    { name: "score", type: "uint8" },
    { name: "decisionHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export const ATTESTATION_TYPE_STRING =
  "Attestation(address subject,uint8 tier,uint8 score,bytes32 decisionHash,uint64 issuedAt,uint64 validUntil)";
/** keccak256(ATTESTATION_TYPE_STRING) - must equal the contract's ATTESTATION_TYPEHASH. */
export const ATTESTATION_TYPEHASH: Hex = keccak256(stringToHex(ATTESTATION_TYPE_STRING));

/** Attestation lifetime per tier: LOW 7d, MEDIUM 24h, HIGH 1h. */
export const VALIDITY_SECONDS: Record<Tier, number> = {
  LOW: 7 * 86_400,
  MEDIUM: 86_400,
  HIGH: 3_600,
};
export function validityForTier(tier: Tier): number {
  return VALIDITY_SECONDS[tier];
}

const ONCHAIN_TO_TIER: Record<number, Tier> = { 1: "LOW", 2: "MEDIUM", 3: "HIGH" };
export function tierFromOnchain(n: number): Tier | null {
  return ONCHAIN_TO_TIER[n] ?? null;
}

export interface BuildAttestationInput {
  subject: Address;
  /** Tier name or on-chain enum value (LOW=1, MEDIUM=2, HIGH=3). */
  tier: Tier | number;
  score: number;
  decisionHash: Hex;
  issuedAt: number;
  /** Defaults to issuedAt + validityForTier(tier). */
  validUntil?: number;
  chainId: number;
  verifyingContract: Address;
}

function assertUint(n: number, bits: number, label: string) {
  if (!Number.isInteger(n) || n < 0 || n > 2 ** bits - 1) throw new Error(`attestation: ${label} must be uint${bits}`);
}

export function buildAttestationTypedData(input: BuildAttestationInput): AttestationTypedData {
  const tierName: Tier | null = typeof input.tier === "number" ? tierFromOnchain(input.tier) : input.tier;
  if (!tierName || !(tierName in TIER_ONCHAIN)) throw new Error(`attestation: unknown tier ${String(input.tier)}`);
  const tier = TIER_ONCHAIN[tierName];
  const validUntil = input.validUntil ?? input.issuedAt + validityForTier(tierName);
  assertUint(input.score, 8, "score");
  if (input.score > 100) throw new Error("attestation: score must be 0–100");
  assertUint(input.issuedAt, 64, "issuedAt");
  assertUint(validUntil, 64, "validUntil");
  if (validUntil <= input.issuedAt) throw new Error("attestation: validUntil must be after issuedAt");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.decisionHash)) throw new Error("attestation: decisionHash must be bytes32");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.subject)) throw new Error("attestation: subject must be an address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.verifyingContract)) throw new Error("attestation: verifyingContract must be an address");
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) throw new Error("attestation: chainId must be a positive integer");

  return {
    domain: {
      name: ATTESTATION_DOMAIN_NAME,
      version: ATTESTATION_DOMAIN_VERSION,
      chainId: input.chainId,
      verifyingContract: input.verifyingContract.toLowerCase() as Address,
    },
    types: { Attestation: ATTESTATION_TYPES.Attestation.map((f) => ({ ...f })) },
    primaryType: "Attestation",
    message: {
      subject: input.subject.toLowerCase() as Address,
      tier,
      score: input.score,
      decisionHash: input.decisionHash.toLowerCase() as Hex,
      issuedAt: input.issuedAt,
      validUntil,
    },
  };
}

function toViemTypedData(td: AttestationTypedData) {
  return {
    domain: {
      name: td.domain.name,
      version: td.domain.version,
      chainId: BigInt(td.domain.chainId),
      verifyingContract: td.domain.verifyingContract,
    },
    types: ATTESTATION_TYPES,
    primaryType: "Attestation" as const,
    message: {
      subject: td.message.subject,
      tier: td.message.tier,
      score: td.message.score,
      decisionHash: td.message.decisionHash,
      issuedAt: BigInt(td.message.issuedAt),
      validUntil: BigInt(td.message.validUntil),
    },
  };
}

/** EIP-712 digest (what the contract recovers against). */
export function hashAttestation(typedData: AttestationTypedData): Hex {
  return hashTypedData(toViemTypedData(typedData));
}

export async function signAttestation(typedData: AttestationTypedData, privateKey: Hex): Promise<Attestation> {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData(toViemTypedData(typedData));
  return {
    typedData,
    signature,
    attester: account.address.toLowerCase() as Address,
    validUntil: typedData.message.validUntil,
    registryTx: null,
  };
}

export interface VerifyOptions {
  /** unix seconds; defaults to Date.now()/1000. */
  now?: number;
  /** Skip the validUntil check (e.g. when auditing historical attestations). */
  ignoreExpiry?: boolean;
  /** When set, the recovered signer must equal this address. */
  expectedAttester?: Address;
  /** When set, the domain must be bound to this chain / contract. */
  expectedChainId?: number;
  expectedVerifyingContract?: Address;
}

/** Fully offline verification: structure, domain, expiry, and signature recovery. Never throws. */
export async function verifyAttestation(att: Attestation, opts: VerifyOptions = {}): Promise<boolean> {
  try {
    const td = att.typedData;
    if (!td || td.primaryType !== "Attestation") return false;
    if (td.domain.name !== ATTESTATION_DOMAIN_NAME || td.domain.version !== ATTESTATION_DOMAIN_VERSION) return false;
    if (!typesMatch(td.types?.Attestation)) return false;
    const m = td.message;
    if (!tierFromOnchain(m.tier)) return false;
    if (!Number.isInteger(m.score) || m.score < 0 || m.score > 100) return false;
    if (!Number.isInteger(m.issuedAt) || !Number.isInteger(m.validUntil) || m.validUntil <= m.issuedAt) return false;
    if (att.validUntil !== m.validUntil) return false;
    if (!/^0x[0-9a-fA-F]{64}$/.test(m.decisionHash)) return false;
    if (!/^0x[0-9a-fA-F]{40}$/.test(m.subject) || !/^0x[0-9a-fA-F]{40}$/.test(att.attester)) return false;
    if (opts.expectedAttester && opts.expectedAttester.toLowerCase() !== att.attester.toLowerCase()) return false;
    if (opts.expectedChainId !== undefined && opts.expectedChainId !== td.domain.chainId) return false;
    if (
      opts.expectedVerifyingContract &&
      opts.expectedVerifyingContract.toLowerCase() !== td.domain.verifyingContract.toLowerCase()
    )
      return false;
    if (!opts.ignoreExpiry) {
      const now = opts.now ?? Math.floor(Date.now() / 1000);
      if (m.validUntil <= now) return false;
    }
    return await verifyTypedData({ ...toViemTypedData(td), address: att.attester, signature: att.signature });
  } catch {
    return false;
  }
}

function typesMatch(fields: { name: string; type: string }[] | undefined): boolean {
  const want = ATTESTATION_TYPES.Attestation;
  if (!fields || fields.length !== want.length) return false;
  return want.every((f, i) => fields[i].name === f.name && fields[i].type === f.type);
}
