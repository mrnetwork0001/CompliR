/**
 * Thin HTTP layer over the CompliR API used by the MCP tools.
 *
 * With `payerPrivateKey` every request goes through `@complir/sdk`'s `paidFetch`, which answers an x402 402
 * by signing an EIP-3009 USDC authorization and retrying once. Without a key, requests are plain `fetch` and
 * a 402 is turned into an actionable error that tells the agent (or its operator) to configure a payer wallet.
 */
import { privateKeyToAccount } from "viem/accounts";
import { CompliR, CompliRPaymentError, atomicToUsdc, readPaymentRequired, type PaymentRequired } from "../../sdk/src/index";

export interface ApiOptions {
  /** CompliR deployment, e.g. https://complir.example or http://localhost:3000. */
  baseUrl: string;
  /** 0x-prefixed private key of a wallet holding USDC on Arc. Optional: only paid endpoints need it. */
  payerPrivateKey?: string;
  /** Refuse to sign x402 payments above this many USDC per call. */
  maxPriceUsdc: number;
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Json = Record<string, unknown>;

export class Api {
  readonly baseUrl: string;
  readonly payer: CompliR | null;
  readonly payerAddress: string | null;
  readonly maxPriceUsdc: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.maxPriceUsdc = opts.maxPriceUsdc;
    this.fetchImpl = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    if (opts.payerPrivateKey) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(opts.payerPrivateKey)) throw new Error("COMPLIR_PAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key");
      const account = privateKeyToAccount(opts.payerPrivateKey as `0x${string}`);
      this.payer = new CompliR({ baseUrl: this.baseUrl, account, maxPriceUsdc: opts.maxPriceUsdc, fetch: this.fetchImpl });
      this.payerAddress = account.address;
    } else {
      this.payer = null;
      this.payerAddress = null;
    }
  }

  /** Receipt of the last x402 payment made through the SDK (null when unpaid or no payer configured). */
  get lastPayment() {
    return this.payer?.lastPayment ?? null;
  }

  // ─── endpoints ────────────────────────────────────────────────────────────
  screen(body: Json) {
    return this.post("/api/v1/screen", body);
  }
  watch(body: Json) {
    return this.post("/api/v1/watch", body);
  }
  shadow(body: Json) {
    return this.post("/api/v1/shadow", body);
  }
  attestation(address: string) {
    return this.get(`/api/v1/attestation/${enc(address)}`, { allow404: true });
  }
  network(address: string) {
    return this.get(`/api/v1/network/${enc(address)}`, { allow404: true });
  }
  decision(id: string) {
    return this.get(`/api/v1/decision/${enc(id)}`);
  }
  mapChanges(limit: number) {
    return this.get(`/api/v1/map/changes?limit=${Math.max(1, Math.min(200, Math.floor(limit)))}`);
  }
  company() {
    return this.get("/api/v1/company", { allow404: true });
  }
  numbers() {
    return this.get("/api/v1/numbers");
  }
  health() {
    return this.get("/api/v1/health");
  }

  // ─── transport ────────────────────────────────────────────────────────────
  private post(path: string, body: Json): Promise<unknown> {
    return this.request(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  }
  private get(path: string, opts: { allow404?: boolean } = {}): Promise<unknown> {
    return this.request(path, { method: "GET", headers: { Accept: "application/json" } }, opts);
  }

  async request(path: string, init: RequestInit & { body?: string }, opts: { allow404?: boolean } = {}): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = this.payer ? await this.payer.paidFetch(url, init) : await this.fetchImpl(url, init);
    } catch (e) {
      if (e instanceof CompliRPaymentError) throw paymentError(init.method ?? "GET", path, e.requirements, e.message, this.maxPriceUsdc, true);
      const msg = e instanceof Error ? e.message : String(e);
      throw new ApiError(0, "UNREACHABLE", `Cannot reach CompliR at ${this.baseUrl} (${msg}). Check COMPLIR_URL and that the deployment is up.`);
    }
    if (res.status === 402) {
      const required = await readPaymentRequired(res);
      throw paymentError(init.method ?? "GET", path, required, undefined, this.maxPriceUsdc, this.payer !== null);
    }
    if (res.status === 404 && opts.allow404) return null;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `CompliR responded ${res.status} for ${init.method ?? "GET"} ${path}`, err?.details);
    }
    return json;
  }
}

function enc(s: string): string {
  return encodeURIComponent(s.trim());
}

function paymentError(method: string, path: string, required: PaymentRequired | null | undefined, detail: string | undefined, maxPriceUsdc: number, hasPayer: boolean): ApiError {
  const accept = required?.accepts?.[0];
  const price = accept ? `${atomicToUsdc(accept.amount)} USDC` : "a small USDC fee";
  const network = accept?.network ? ` on ${accept.network}` : "";
  const head = `Payment required: ${method} ${path} costs ${price}${network} via x402.`;
  const fix = hasPayer
    ? `The configured payer wallet could not pay${detail ? ` (${detail})` : ""}. Check that the wallet holds USDC on Arc, that COMPLIR_MAX_PRICE_USDC (currently ${maxPriceUsdc}) is at least the price, and that the deployment's x402 network matches.`
    : "This MCP server has no payer wallet configured, so it cannot pay. To enable paid calls set COMPLIR_PAYER_PRIVATE_KEY in the MCP server environment to the 0x-prefixed private key of a wallet holding USDC on Arc (optionally COMPLIR_MAX_PRICE_USDC, default 0.1), then retry. For local development point COMPLIR_URL at a CompliR instance running with X402_DISABLED=1. Free alternatives: get_attestation (latest stored verdict) and shadow_report.";
  return new ApiError(402, "PAYMENT_REQUIRED", `${head} ${fix}`, required ?? undefined);
}
