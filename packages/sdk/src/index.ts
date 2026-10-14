/**
 * @complir/sdk - minimal client for CompliR (counterparty risk oracle on Arc).
 *
 *   import { CompliR } from "@complir/sdk";
 *   import { privateKeyToAccount } from "viem/accounts";
 *   const c = new CompliR({ baseUrl: "https://trycomplir.xyz", account: privateKeyToAccount(PK) });
 *   const v = await c.screen("0xPayee", { amountUsdc: 120 });          // pays 0.01 USDC via x402 (exact / EIP-3009)
 *   if (v.tier === "HIGH") hold(); else pay(Math.min(amount, v.recommendedLimits.maxPerTxUsdc));
 *   await c.watch("0xPayee", { webhookUrl: "https://me/complir" });     // 0.05 USDC / 30 days
 *   await CompliR.verifyAttestation(v.attestation);                      // offline, no network
 *
 * x402 v2 (https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md): on 402 the SDK
 * reads `PAYMENT-REQUIRED` (base64 PaymentRequired; JSON body fallback), signs an EIP-3009
 * TransferWithAuthorization for the first `exact` / `eip155:*` requirement with the viem account, and retries
 * once with `PAYMENT-SIGNATURE`. The settlement receipt from `PAYMENT-RESPONSE` is exposed as `lastPayment`.
 */
import { toHex, verifyTypedData, type Hex, type LocalAccount } from "viem";

// ─── Public types (mirror src/lib/types.ts; keep in sync) ────────────────────
export type Address = `0x${string}`;
export type Tier = "LOW" | "MEDIUM" | "HIGH";

export interface AttestationTypedData {
  domain: { name: "CompliR"; version: "1"; chainId: number; verifyingContract: Address };
  types: { Attestation: { name: string; type: string }[] };
  primaryType: "Attestation";
  message: { subject: Address; tier: number; score: number; decisionHash: Hex; issuedAt: number; validUntil: number };
}
export interface Attestation {
  typedData: AttestationTypedData;
  signature: Hex;
  attester: Address;
  validUntil: number;
  registryTx: Hex | null;
}
export interface Reason {
  code: string;
  weight: number;
  evidence: Record<string, unknown>;
}
export interface Verdict {
  address: Address;
  score: number;
  tier: Tier;
  recommendedLimits: { maxPerTxUsdc: number; maxPerDayUsdc: number };
  reasons: Reason[];
  rationale: string;
  eddRequested: string[];
  nextRescreenAt: string;
  attestation: Attestation;
  decisionId: string;
  screenedAt: string;
  evidence: unknown;
}
/** GET /api/v1/attestation/:address - the free verdict (always answers; never-seen addresses are screened on demand). */
export interface FreeVerdict {
  address: Address;
  score: number;
  tier: Tier;
  reasons: Reason[];
  recommendedLimits: { maxPerTxUsdc: number; maxPerDayUsdc: number } | null;
  rationale: string | null;
  eddRequested: string[];
  edd: { id: string; url: string; status: string } | null;
  nextRescreenAt: string | null;
  attestation: Attestation;
  decisionId: string;
  screenedAt: string;
  /** now > attestation.validUntil: signature lapsed, a re-screen is due (started in the background) */
  expired: boolean;
  refreshing: boolean;
  source: "store" | "fresh";
}
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
export interface PayeeBookEntry {
  label: string;
  address: Address;
}
export interface ScreenOptions {
  name?: string;
  amountUsdc?: number;
  payeeBook?: PayeeBookEntry[];
  clientId?: string;
  depth?: 1 | 2;
}
export interface WatchOptions {
  webhookUrl: string;
  clientId?: string;
  payeeBook?: PayeeBookEntry[];
}

// ─── x402 wire types (subset) ────────────────────────────────────────────────
export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}
export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
}
export interface PaymentReceipt {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  amount?: string;
  errorReason?: string;
}

export type X402Signer = Pick<LocalAccount, "address" | "signTypedData">;

export interface CompliROptions {
  /** e.g. https://trycomplir.xyz (no trailing slash needed) */
  baseUrl: string;
  /** viem account that pays (privateKeyToAccount, Circle wallet adapter, ...). */
  account: X402Signer;
  /** Refuse to sign for more than this many USDC per call. Default 1. */
  maxPriceUsdc?: number | string;
  /** Only accept requirements on this CAIP-2 network (e.g. "eip155:5042"). Default: any eip155:*. */
  network?: string;
  /** Extra seconds added to the server's maxTimeoutSeconds for authorization validity. Default 540. */
  authorizationSlackSeconds?: number;
  fetch?: typeof fetch;
}

export class CompliRError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;
  constructor(status: number, message: string, opts: { code?: string; body?: unknown } = {}) {
    super(message);
    this.name = "CompliRError";
    this.status = status;
    this.code = opts.code;
    this.body = opts.body;
  }
}
export class CompliRPaymentError extends CompliRError {
  readonly requirements?: PaymentRequired;
  readonly receipt?: PaymentReceipt;
  constructor(message: string, opts: { status?: number; requirements?: PaymentRequired; receipt?: PaymentReceipt; body?: unknown } = {}) {
    super(opts.status ?? 402, message, { code: "PAYMENT_REQUIRED", body: opts.body });
    this.name = "CompliRPaymentError";
    this.requirements = opts.requirements;
    this.receipt = opts.receipt;
  }
}

const USDC_DECIMALS = 6n;
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export class CompliR {
  private readonly baseUrl: string;
  private readonly account: X402Signer;
  private readonly maxAtomic: bigint;
  private readonly network?: string;
  private readonly slack: number;
  private readonly fetchImpl: typeof fetch;
  /** Settlement receipt of the most recent paid call (from `PAYMENT-RESPONSE`). */
  lastPayment: PaymentReceipt | null = null;

  constructor(opts: CompliROptions) {
    if (!opts.baseUrl) throw new Error("CompliR: baseUrl is required");
    if (!opts.account?.address || typeof opts.account.signTypedData !== "function") throw new Error("CompliR: account must be a viem account with signTypedData");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.account = opts.account;
    this.maxAtomic = usdcToAtomic(opts.maxPriceUsdc ?? 1);
    this.network = opts.network;
    this.slack = opts.authorizationSlackSeconds ?? 540;
    this.fetchImpl = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  /** POST /api/v1/screen (0.01 USDC). */
  async screen(address: string, opts: ScreenOptions = {}): Promise<Verdict> {
    return this.postJson<Verdict>("/api/v1/screen", { address, ...opts });
  }

  /** POST /api/v1/watch (0.05 USDC / 30 days). */
  async watch(address: string, opts: WatchOptions): Promise<Watch> {
    return this.postJson<Watch>("/api/v1/watch", { address, ...opts });
  }

  /**
   * GET /api/v1/attestation/:address (free). The full verdict: tier, score, reasons, recommendedLimits, rationale,
   * EDD, nextRescreenAt and the signed attestation. Never-seen addresses are screened on demand (allow ~90 s on first sight).
   */
  async verdict(address: string): Promise<FreeVerdict | null> {
    const res = await this.paidFetch(`/api/v1/attestation/${address}`, { method: "GET" });
    if (res.status === 404) return null;
    return (await this.unwrap(res)) as FreeVerdict;
  }

  /** The signed attestation only, from the free verdict (see verdict()). */
  async attestation(address: string): Promise<Attestation | null> {
    return (await this.verdict(address))?.attestation ?? null;
  }

  /** Offline attestation check (domain, types, expiry, signature). Never throws. */
  static verifyAttestation(att: Attestation, opts: VerifyAttestationOptions = {}): Promise<boolean> {
    return verifyAttestation(att, opts);
  }
  verifyAttestation(att: Attestation, opts: VerifyAttestationOptions = {}): Promise<boolean> {
    return verifyAttestation(att, opts);
  }

  /**
   * fetch() with the x402 402→sign→retry dance. Path may be relative to baseUrl or absolute.
   * Bodies must be re-sendable (string / undefined), which is all this SDK sends.
   */
  async paidFetch(path: string, init: RequestInit & { body?: string } = {}): Promise<Response> {
    const url = /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    const first = await this.fetchImpl(url, init);
    if (first.status !== 402) return this.recordReceipt(first);

    const required = await readPaymentRequired(first);
    if (!required) throw new CompliRPaymentError("402 without a readable PAYMENT-REQUIRED header/body", { body: await safeText(first) });
    const req = this.pickRequirement(required);
    const paymentHeader = await this.signPayment(required, req);

    const headers = new Headers(init.headers);
    headers.set("PAYMENT-SIGNATURE", paymentHeader);
    const second = await this.fetchImpl(url, { ...init, headers });
    if (second.status === 402) {
      const again = await readPaymentRequired(second);
      const receipt = readReceipt(second);
      throw new CompliRPaymentError(`payment rejected: ${again?.error ?? receipt?.errorReason ?? "unknown"}`, { requirements: again ?? required, receipt: receipt ?? undefined, body: again ?? (await safeText(second)) });
    }
    return this.recordReceipt(second);
  }

  private pickRequirement(required: PaymentRequired): PaymentRequirements {
    if (required.x402Version !== 2) throw new CompliRPaymentError(`unsupported x402Version ${required.x402Version}`, { requirements: required });
    const req = required.accepts.find((a) => a.scheme === "exact" && /^eip155:\d+$/.test(a.network) && (!this.network || a.network === this.network));
    if (!req) throw new CompliRPaymentError(`no acceptable payment option (need scheme exact on ${this.network ?? "eip155:*"})`, { requirements: required });
    if (BigInt(req.amount) > this.maxAtomic) throw new CompliRPaymentError(`price ${atomicToUsdc(req.amount)} USDC exceeds maxPriceUsdc ${atomicToUsdc(this.maxAtomic)}`, { requirements: required });
    return req;
  }

  private async signPayment(required: PaymentRequired, req: PaymentRequirements): Promise<string> {
    const chainId = Number(req.network.split(":")[1]);
    const extra = (req.extra ?? {}) as { name?: string; version?: string; assetTransferMethod?: string };
    if (extra.assetTransferMethod && extra.assetTransferMethod !== "eip3009") throw new CompliRPaymentError(`unsupported assetTransferMethod ${extra.assetTransferMethod}`, { requirements: required });
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: this.account.address,
      to: req.payTo as Address,
      value: req.amount,
      validAfter: "0",
      validBefore: String(now + req.maxTimeoutSeconds + this.slack),
      nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    const signature = await this.account.signTypedData({
      domain: { name: extra.name ?? "USDC", version: extra.version ?? "2", chainId, verifyingContract: req.asset as Address },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    const payload = { x402Version: 2, resource: required.resource, accepted: req, payload: { signature, authorization } };
    return b64encode(JSON.stringify(payload));
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.paidFetch(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    return (await this.unwrap(res)) as T;
  }

  private async unwrap(res: Response): Promise<unknown> {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new CompliRError(res.status, err?.message ?? `HTTP ${res.status}`, { code: err?.code, body: json ?? text });
    }
    return json;
  }

  private recordReceipt(res: Response): Response {
    const r = readReceipt(res);
    if (r) this.lastPayment = r;
    return res;
  }
}

// ─── Attestation verification (mirror of src/lib/attest/eip712.ts) ──────────
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

export interface VerifyAttestationOptions {
  now?: number;
  ignoreExpiry?: boolean;
  expectedAttester?: Address;
  expectedChainId?: number;
  expectedVerifyingContract?: Address;
}

export async function verifyAttestation(att: Attestation, opts: VerifyAttestationOptions = {}): Promise<boolean> {
  try {
    const td = att.typedData;
    if (!td || td.primaryType !== "Attestation") return false;
    if (td.domain.name !== "CompliR" || td.domain.version !== "1") return false;
    const want = ATTESTATION_TYPES.Attestation;
    const got = td.types?.Attestation;
    if (!got || got.length !== want.length || !want.every((f, i) => got[i].name === f.name && got[i].type === f.type)) return false;
    const m = td.message;
    if (![1, 2, 3].includes(m.tier)) return false;
    if (!Number.isInteger(m.score) || m.score < 0 || m.score > 100) return false;
    if (!Number.isInteger(m.issuedAt) || !Number.isInteger(m.validUntil) || m.validUntil <= m.issuedAt) return false;
    if (att.validUntil !== m.validUntil) return false;
    if (!/^0x[0-9a-fA-F]{64}$/.test(m.decisionHash)) return false;
    if (!/^0x[0-9a-fA-F]{40}$/.test(m.subject) || !/^0x[0-9a-fA-F]{40}$/.test(att.attester)) return false;
    if (opts.expectedAttester && opts.expectedAttester.toLowerCase() !== att.attester.toLowerCase()) return false;
    if (opts.expectedChainId !== undefined && opts.expectedChainId !== td.domain.chainId) return false;
    if (opts.expectedVerifyingContract && opts.expectedVerifyingContract.toLowerCase() !== td.domain.verifyingContract.toLowerCase()) return false;
    if (!opts.ignoreExpiry && m.validUntil <= (opts.now ?? Math.floor(Date.now() / 1000))) return false;
    return await verifyTypedData({
      address: att.attester,
      domain: { name: td.domain.name, version: td.domain.version, chainId: BigInt(td.domain.chainId), verifyingContract: td.domain.verifyingContract },
      types: ATTESTATION_TYPES,
      primaryType: "Attestation",
      message: { subject: m.subject, tier: m.tier, score: m.score, decisionHash: m.decisionHash, issuedAt: BigInt(m.issuedAt), validUntil: BigInt(m.validUntil) },
      signature: att.signature,
    });
  } catch {
    return false;
  }
}

/** Tier for a 0–100 score (same bands as the server). */
export function tierForScore(score: number): Tier {
  return score <= 20 ? "LOW" : score <= 60 ? "MEDIUM" : "HIGH";
}

// ─── helpers ─────────────────────────────────────────────────────────────────
export async function readPaymentRequired(res: Response): Promise<PaymentRequired | null> {
  const h = res.headers.get("PAYMENT-REQUIRED");
  if (h) {
    try {
      return JSON.parse(b64decode(h)) as PaymentRequired;
    } catch {
      /* fall through to body */
    }
  }
  try {
    const j = (await res.clone().json()) as PaymentRequired;
    return j && Array.isArray(j.accepts) ? j : null;
  } catch {
    return null;
  }
}
export function readReceipt(res: Response): PaymentReceipt | null {
  const h = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  if (!h) return null;
  try {
    return JSON.parse(b64decode(h)) as PaymentReceipt;
  } catch {
    return null;
  }
}
export function usdcToAtomic(amount: number | string): bigint {
  const s = typeof amount === "number" ? amount.toFixed(6) : amount.trim();
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(s);
  if (!m) throw new Error(`invalid USDC amount "${amount}"`);
  return BigInt(m[1]) * 10n ** USDC_DECIMALS + BigInt((m[2] ?? "").padEnd(6, "0"));
}
export function atomicToUsdc(atomic: bigint | string): string {
  const v = BigInt(atomic);
  const frac = (v % 10n ** USDC_DECIMALS).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${v / 10n ** USDC_DECIMALS}.${frac}` : (v / 10n ** USDC_DECIMALS).toString();
}
function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(s: string): string {
  const bin = atob(s.trim());
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
async function safeText(res: Response): Promise<string> {
  try {
    return await res.clone().text();
  } catch {
    return "";
  }
}
