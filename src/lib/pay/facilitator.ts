/**
 * Typed client for an x402 v2 facilitator (REST): POST /verify, POST /settle, GET /status/{id}, GET /supported.
 *
 * Built for Circle's Facilitator Service (https://developers.circle.com/facilitator-service), base
 * `https://api.circle.com/v1/facilitator/x402`, which authenticates each call with EITHER
 *   - `Authorization: Bearer <CIRCLE_API_KEY>` (production), or
 *   - `Facilitator-Seller-Proof: <base64url envelope>` — an EIP-712 `SellerRequest` signed by the key that
 *     controls `payTo`, bound to the request body hash (keyless trial; also valid in production).
 *   https://developers.circle.com/facilitator-service/sign-seller-proof
 * Without either it degrades to a plain unauthenticated client (works with the x402.org facilitator).
 */
import { keccak256, toBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  PaymentPayloadSchema,
  SettlementStatusSchema,
  SettleResponseSchema,
  SupportedResponseSchema,
  VerifyResponseSchema,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementStatus,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "./types";

export type FacilitatorErrorKind = "timeout" | "network" | "http" | "invalid_response";

export class FacilitatorError extends Error {
  readonly kind: FacilitatorErrorKind;
  readonly status?: number;
  readonly body?: unknown;
  constructor(kind: FacilitatorErrorKind, message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = "FacilitatorError";
    this.kind = kind;
    this.status = opts.status;
    this.body = opts.body;
  }
}

export interface FacilitatorClientOptions {
  /** Base URL without trailing slash, e.g. https://api.circle.com/v1/facilitator/x402 */
  baseUrl: string;
  /** Circle API key → `Authorization: Bearer`. */
  apiKey?: string;
  /** Private key of the `payTo` address → `Facilitator-Seller-Proof` per request. */
  sellerPrivateKey?: Hex;
  /** Per-request timeout. Default 10s; settle defaults to 30s. */
  timeoutMs?: number;
  settleTimeoutMs?: number;
  fetch?: typeof fetch;
}

type Purpose = "verify" | "settle" | "status" | "supported";

export class FacilitatorClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly seller?: PrivateKeyAccount;
  private readonly timeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FacilitatorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.seller = opts.sellerPrivateKey ? privateKeyToAccount(opts.sellerPrivateKey) : undefined;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.settleTimeoutMs = opts.settleTimeoutMs ?? 30_000;
    // Bind lazily so tests can stub globalThis.fetch after construction.
    this.fetchImpl = opts.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  get sellerAddress(): `0x${string}` | undefined {
    return this.seller?.address;
  }

  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    const body = JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements });
    const json = await this.request("verify", "POST", "/verify", body, paymentRequirements, this.timeoutMs);
    return parse(VerifyResponseSchema, json, "verify");
  }

  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    const body = JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements });
    const json = await this.request("settle", "POST", "/settle", body, paymentRequirements, this.settleTimeoutMs);
    return parse(SettleResponseSchema, json, "settle");
  }

  /** Circle-specific: reconcile a `settlement_pending` settle. */
  async status(paymentId: string, ctx: { network: string; payTo: string }): Promise<SettlementStatus> {
    const json = await this.request("status", "GET", `/status/${encodeURIComponent(paymentId)}`, "", ctx, this.timeoutMs);
    return parse(SettlementStatusSchema, json, "status");
  }

  async supported(ctx?: { network: string; payTo: string }): Promise<SupportedResponse> {
    const json = await this.request("supported", "GET", "/supported", "", ctx, this.timeoutMs);
    return parse(SupportedResponseSchema, json, "supported");
  }

  private async request(
    purpose: Purpose,
    method: "GET" | "POST",
    path: string,
    body: string,
    ctx: { network: string; payTo: string } | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method === "POST") headers["Content-Type"] = "application/json";
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    else if (this.seller && ctx) {
      headers["Facilitator-Seller-Proof"] = await buildSellerProof({
        account: this.seller,
        purpose: purpose === "supported" ? "status" : purpose,
        method,
        body,
        network: ctx.network,
        payTo: ctx.payTo,
      });
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
        signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) throw new FacilitatorError("timeout", `facilitator ${purpose} timed out after ${timeoutMs}ms`);
      throw new FacilitatorError("network", `facilitator ${purpose} unreachable: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body; handled below */
    }
    if (!res.ok) {
      throw new FacilitatorError("http", `facilitator ${purpose} returned HTTP ${res.status}`, { status: res.status, body: json ?? text });
    }
    if (json === null) throw new FacilitatorError("invalid_response", `facilitator ${purpose} returned a non-JSON body`);
    return json;
  }
}

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } }, json: unknown, what: string): T {
  const r = schema.safeParse(json);
  if (!r.success || r.data === undefined) throw new FacilitatorError("invalid_response", `facilitator ${what} response failed validation`, { body: json });
  return r.data;
}

// ─── Circle seller proof ─────────────────────────────────────────────────────
export const SELLER_PROOF_TYPES = {
  SellerRequest: [
    { name: "purpose", type: "string" },
    { name: "method", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "network", type: "string" },
    { name: "payTo", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export interface SellerProofInput {
  account: PrivateKeyAccount;
  purpose: "verify" | "settle" | "status";
  method: string;
  /** Raw request body exactly as sent (empty string for GET). */
  body: string;
  /** CAIP-2 network; must equal paymentRequirements.network on verify/settle. */
  network: string;
  payTo: string;
  now?: number;
  nonce?: Hex;
}

/** `Facilitator-Seller-Proof` header value: base64url(JSON envelope) carrying an EIP-712 SellerRequest signature. */
export async function buildSellerProof(input: SellerProofInput): Promise<string> {
  const chainId = chainIdFromCaip2(input.network);
  const issuedAt = input.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300;
  const nonce = input.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(32)));
  const signature = await input.account.signTypedData({
    domain: { name: "Circle Facilitator Seller Request", version: "1", chainId },
    types: SELLER_PROOF_TYPES,
    primaryType: "SellerRequest",
    message: {
      purpose: input.purpose,
      method: input.method.toUpperCase(),
      bodyHash: keccak256(toBytes(input.body)),
      network: input.network,
      payTo: input.payTo as `0x${string}`,
      nonce,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
    },
  });
  const envelope = { version: 1, signature, network: input.network, payTo: input.payTo, nonce, issuedAt, expiresAt };
  return Buffer.from(JSON.stringify(envelope)).toString("base64url");
}

/** "eip155:5042" → 5042 */
export function chainIdFromCaip2(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`x402: network "${network}" is not an eip155 CAIP-2 identifier`);
  return Number(m[1]);
}

/** Re-exported for callers that want to validate a decoded PAYMENT-SIGNATURE before hitting the facilitator. */
export { PaymentPayloadSchema };
