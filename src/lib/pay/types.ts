/**
 * x402 v2 wire types (subset we use), as zod schemas.
 * Spec: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
 * HTTP transport: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md
 * exact/EVM scheme: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
 */
import { z } from "zod";

export const X402_VERSION = 2 as const;

/** v2 header names (case-insensitive on the wire). v1 names kept for compatibility. */
export const HEADERS = {
  paymentRequired: "PAYMENT-REQUIRED",
  paymentSignature: "PAYMENT-SIGNATURE",
  paymentResponse: "PAYMENT-RESPONSE",
  v1Payment: "X-PAYMENT",
  v1PaymentResponse: "X-PAYMENT-RESPONSE",
  complir: "X-CompliR-Payment",
} as const;

const HexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "invalid address");
const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "invalid bytes32");
const DecimalString = z.string().regex(/^\d+$/, "expected unsigned decimal string");

export const ResourceInfoSchema = z.object({
  url: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;

export const PaymentRequirementsSchema = z.object({
  scheme: z.string(),
  /** CAIP-2, e.g. "eip155:5042" (Arc mainnet) / "eip155:5042002" (Arc testnet). */
  network: z.string(),
  amount: DecimalString,
  asset: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

export const PaymentRequiredSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  error: z.string().optional(),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsSchema).min(1),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

/** EIP-3009 TransferWithAuthorization parameters (exact/EVM, eip3009 transfer method). */
export const Eip3009AuthorizationSchema = z.object({
  from: HexAddress,
  to: HexAddress,
  value: DecimalString,
  validAfter: DecimalString,
  validBefore: DecimalString,
  nonce: Bytes32,
});
export type Eip3009Authorization = z.infer<typeof Eip3009AuthorizationSchema>;

export const ExactEvmPayloadSchema = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  authorization: Eip3009AuthorizationSchema,
});
export type ExactEvmPayload = z.infer<typeof ExactEvmPayloadSchema>;

export const PaymentPayloadSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  resource: ResourceInfoSchema.optional(),
  accepted: PaymentRequirementsSchema,
  payload: ExactEvmPayloadSchema,
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export const VerifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: z.string().optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

export const SettleResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  payer: z.string().optional(),
  transaction: z.string(),
  network: z.string(),
  amount: z.string().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type SettleResponse = z.infer<typeof SettleResponseSchema>;

/** Circle `GET /status/{paymentId}` body (used only to reconcile `settlement_pending`). */
export const SettlementStatusSchema = z.object({
  status: z.string(),
  transaction: z.string().optional(),
  payer: z.string().optional(),
  amount: z.string().optional(),
  network: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type SettlementStatus = z.infer<typeof SettlementStatusSchema>;

export const SupportedResponseSchema = z.object({
  kinds: z.array(
    z.object({
      x402Version: z.number(),
      scheme: z.string(),
      network: z.string(),
      extra: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  extensions: z.array(z.string()).optional(),
  signers: z.record(z.string(), z.array(z.string())).optional(),
});
export type SupportedResponse = z.infer<typeof SupportedResponseSchema>;

// ─── base64 header encoding (UTF-8 safe, works in Node and browsers) ─────────
export function encodeHeader(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
export function decodeHeader(value: string): unknown {
  const bin = atob(value.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
