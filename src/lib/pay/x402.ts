/**
 * x402 v2 payment gate for Next.js route handlers (spec §2.1: screen 0.01 USDC, watch 0.05 USDC).
 *
 * Flow (https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md):
 *   no PAYMENT-SIGNATURE  → 402 + `PAYMENT-REQUIRED` header (base64 PaymentRequired) + same object as JSON body
 *   PAYMENT-SIGNATURE     → facilitator /verify → run handler → (2xx) facilitator /settle → `PAYMENT-RESPONSE`
 * Fail closed: any verify/settle problem returns 402/502 and the handler's body is never leaked.
 * Idempotent: keyed by the EIP-3009 nonce (5 min). A retry after a settled payment replays the cached response
 * without a second /settle; a retry after `settlement_pending` re-settles without re-running the handler.
 * v1 compat: `X-PAYMENT` is accepted as an alias of `PAYMENT-SIGNATURE` (payload must still be x402Version 2),
 * and `X-PAYMENT-RESPONSE` mirrors `PAYMENT-RESPONSE`.
 * Refunds: once /settle succeeded the payer has been charged. If we then cannot deliver what they paid for
 * (`settleFirst` handler threw / non-2xx, client disconnected, response could not be built) the refund sink
 * (`setRefundSink`, src/lib/refunds) is called with the payer + amount + settle tx, and the client gets an error
 * carrying `X-CompliR-Payment: refund-queued`. Nothing is ever silently kept.
 */
import { config } from "../config";
import { FacilitatorClient, FacilitatorError } from "./facilitator";
import { atomicToUsdc, usdcToAmountString } from "./pricing";
import {
  HEADERS,
  PaymentPayloadSchema,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
} from "./types";

// ─── Options / events ────────────────────────────────────────────────────────
export interface X402Options {
  /** Price in USDC (e.g. 0.01). Converted to atomic 6dp units for the wire. */
  priceUsdc: number | string;
  description: string;
  /** Absolute resource URL. Defaults to PUBLIC_BASE_URL + request pathname. */
  resource?: string;
  mimeType?: string;
  /** Default 60 (how long the server may take before settling). */
  maxTimeoutSeconds?: number;
  /**
   * Settle *before* running the handler (default: handler first, then settle, so a failing handler never charges).
   * Use for handlers with side effects that must only happen once paid (e.g. registering a watch). A handler that
   * throws / returns non-2xx after settlement is auto-refunded via the refund sink.
   */
  settleFirst?: boolean;
}

export interface PaymentEvent {
  txHash: string;
  payer: string;
  /** Decimal USDC string, e.g. "0.01". */
  amountUsdc: string;
  /** Request pathname, e.g. "/api/v1/screen". */
  endpoint: string;
  network: string;
  /** Circle payment id when the settlement went through `settlement_pending` → status. */
  paymentId?: string;
  at: number;
  /** True when the settle response named a payer and a tx hash, i.e. an on-chain refund to `payer` is possible. */
  refundable: boolean;
}
export type PaymentSink = (event: PaymentEvent) => void | Promise<void>;

/** Emitted when a payment settled but the payer did not get what they paid for. Consumers queue an on-chain refund. */
export interface RefundNeededEvent {
  payer: string;
  /** Decimal USDC string, e.g. "0.01". */
  amountUsdc: string;
  settleTxHash: string;
  paymentId?: string;
  endpoint: string;
  network: string;
  reason: string;
  at: number;
}
export type RefundSink = (event: RefundNeededEvent) => void | Promise<void>;

let sink: PaymentSink | null = null;
let refundSink: RefundSink | null = null;
/** Register the revenue/ledger hook. Called after a successful settle; errors are logged, never surfaced. */
export function setPaymentSink(fn: PaymentSink | null): void {
  sink = fn;
}
/** Register the refund hook (src/lib/refunds `installRefundSink()`). Called when a settled payment could not be honoured. */
export function setRefundSink(fn: RefundSink | null): void {
  refundSink = fn;
}

// ─── Payment config (env-driven; pay-local extras documented in .env.example) ─
export interface PaymentConfig {
  disabled: boolean;
  network: string;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  assetName: string;
  assetVersion: string;
  facilitatorUrl: string;
  apiKey?: string;
  sellerPrivateKey?: `0x${string}`;
  publicBaseUrl: string;
  /** How many 1s status polls to run after `settlement_pending` before giving up (default 3). */
  pendingPolls: number;
}

export class X402ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "X402ConfigError";
  }
}

export function paymentConfig(): PaymentConfig {
  const c = config();
  const env = process.env;
  const disabled = c.X402_DISABLED;
  const network = c.X402_NETWORK?.trim() || `eip155:${c.ARC_CHAIN_ID}`;
  const payTo = c.X402_PAY_TO as `0x${string}` | undefined;
  const facilitatorUrl = c.X402_FACILITATOR_URL;
  if (!disabled) {
    if (!payTo) throw new X402ConfigError("X402_PAY_TO is required when x402 is enabled");
    if (!facilitatorUrl) throw new X402ConfigError("X402_FACILITATOR_URL is required when x402 is enabled");
  }
  const sellerPrivateKey = env.X402_SELLER_PRIVATE_KEY?.trim() || undefined;
  if (sellerPrivateKey && !/^0x[0-9a-fA-F]{64}$/.test(sellerPrivateKey)) throw new X402ConfigError("X402_SELLER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  return {
    disabled,
    network,
    payTo: (payTo ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
    asset: c.USDC_ADDRESS as `0x${string}`,
    assetName: env.X402_ASSET_NAME?.trim() || "USDC",
    assetVersion: env.X402_ASSET_VERSION?.trim() || "2",
    facilitatorUrl: facilitatorUrl ?? "",
    apiKey: env.X402_FACILITATOR_API_KEY?.trim() || undefined,
    sellerPrivateKey: sellerPrivateKey as `0x${string}` | undefined,
    publicBaseUrl: c.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    pendingPolls: env.X402_PENDING_POLLS !== undefined ? Math.max(0, Number(env.X402_PENDING_POLLS) || 0) : 3,
  };
}

let clientCache: { key: string; client: FacilitatorClient } | null = null;
function facilitator(pc: PaymentConfig): FacilitatorClient {
  const key = `${pc.facilitatorUrl}|${pc.apiKey ?? ""}|${pc.sellerPrivateKey ?? ""}`;
  if (clientCache?.key === key) return clientCache.client;
  const client = new FacilitatorClient({ baseUrl: pc.facilitatorUrl, apiKey: pc.apiKey, sellerPrivateKey: pc.sellerPrivateKey });
  clientCache = { key, client };
  return client;
}

// ─── Idempotency cache ───────────────────────────────────────────────────────
export const IDEMPOTENCY_TTL_MS = 5 * 60_000;

interface Snapshot {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer | null;
}
interface CacheEntry {
  expiresAt: number;
  /** In-flight processing for this nonce (dedupes concurrent duplicates). */
  inflight?: Promise<Outcome>;
  /** Terminal: payment settled; replay this response, never settle again. */
  settled?: Snapshot;
  /** Handler already ran but settlement is pending; a retry re-settles without re-running the handler. */
  handler?: Snapshot;
}
type Outcome = { kind: "settled" | "pending" | "other"; snapshot: Snapshot; handler?: Snapshot };

const cache = new Map<string, CacheEntry>();
function sweep(now: number) {
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
}
/** test helper */
export function __resetPay(): void {
  cache.clear();
  clientCache = null;
  sink = null;
  refundSink = null;
}

// ─── Middleware ──────────────────────────────────────────────────────────────
type Handler<Ctx> = (req: Request, ctx: Ctx) => Promise<Response> | Response;

export function withX402<Ctx = unknown>(handler: Handler<Ctx>, opts: X402Options): Handler<Ctx> {
  return async (req, ctx) => {
    let pc: PaymentConfig;
    try {
      pc = paymentConfig();
    } catch (e) {
      console.error("[complir/pay] misconfigured:", e);
      return jsonError(503, "PAYMENT_MISCONFIGURED", "Payments are enabled but not configured; no charge was made.");
    }

    if (pc.disabled) {
      const res = await handler(req, ctx);
      return withHeader(res, HEADERS.complir, "disabled");
    }

    const url = new URL(req.url);
    const requirements = buildRequirements(pc, opts, url);
    const resource = { url: requirements.resourceUrl, description: opts.description, mimeType: opts.mimeType ?? "application/json" };
    const required = (error: string, status = 402, extra: Record<string, string> = {}) => paymentRequiredResponse(resource, requirements.req, error, status, extra);

    const raw = req.headers.get(HEADERS.paymentSignature) ?? req.headers.get(HEADERS.v1Payment);
    if (!raw) return required(`${HEADERS.paymentSignature} header is required`);

    let payload: PaymentPayload;
    try {
      const decoded = decodeHeader(raw);
      const v = (decoded as { x402Version?: unknown })?.x402Version;
      if (v !== undefined && v !== X402_VERSION) return required(`unsupported x402Version ${String(v)}; this server speaks x402 v2`);
      payload = PaymentPayloadSchema.parse(decoded);
    } catch {
      return required("invalid payment payload: expected base64 JSON PaymentPayload (exact/EVM)");
    }

    const mismatch = matchRequirements(payload, requirements.req);
    if (mismatch) return required(`payment does not match requirements: ${mismatch}`);

    const key = `${payload.payload.authorization.from.toLowerCase()}:${payload.payload.authorization.nonce.toLowerCase()}`;
    const now = Date.now();
    sweep(now);
    const entry = cache.get(key);
    if (entry?.settled) return respond(entry.settled, { [HEADERS.complir]: "replay" });
    if (entry?.inflight) {
      const out = await entry.inflight;
      return respond(out.snapshot, { [HEADERS.complir]: out.kind === "settled" ? "replay" : "retry" });
    }

    const run = process_(pc, requirements.req, resource, payload, url, entry?.handler, () => handler(req, ctx), { settleFirst: opts.settleFirst === true, signal: req.signal });
    const next: CacheEntry = { expiresAt: now + IDEMPOTENCY_TTL_MS, inflight: run, handler: entry?.handler };
    cache.set(key, next);
    const out = await run;
    next.inflight = undefined;
    if (out.kind === "settled") next.settled = out.snapshot;
    else if (out.kind === "pending") next.handler = out.handler;
    else cache.delete(key);
    return respond(out.snapshot);
  };
}

async function process_(
  pc: PaymentConfig,
  req: PaymentRequirements,
  resource: { url: string; description: string; mimeType: string },
  payload: PaymentPayload,
  url: URL,
  cachedHandler: Snapshot | undefined,
  run: () => Promise<Response> | Response,
  mode: { settleFirst: boolean; signal?: AbortSignal | null },
): Promise<Outcome> {
  const fac = facilitator(pc);
  const required = (error: string, status = 402, extra: Record<string, string> = {}) => paymentRequiredResponse(resource, req, error, status, extra);
  const other = async (res: Response): Promise<Outcome> => ({ kind: "other", snapshot: await snapshot(res) });

  // 1. verify (fail closed)
  try {
    const v = await fac.verify(payload, req);
    if (!v.isValid) return other(required(`payment verification failed: ${v.invalidReason ?? "invalid"}`));
  } catch (e) {
    return other(facilitatorFailure("verify", e));
  }

  // 2. run the paid handler (or reuse the result from a pending retry); with `settleFirst` this moves to step 5
  let handlerSnap = cachedHandler;
  if (!handlerSnap && !mode.settleFirst) {
    try {
      handlerSnap = await snapshot(await run());
    } catch (e) {
      console.error("[complir/pay] handler threw before settlement; not charging:", e);
      return other(jsonError(500, "INTERNAL_ERROR", "Internal error; no charge was made.", { [HEADERS.complir]: "not-charged" }));
    }
    if (handlerSnap.status < 200 || handlerSnap.status >= 300) {
      // Handler refused (validation error, paused, ...): never charge for a non-2xx.
      return { kind: "other", snapshot: addHeaders(handlerSnap, { [HEADERS.complir]: "not-charged" }) };
    }
  }

  // 3. settle (fail closed; never leak the verdict on failure)
  const settlePayload = withPaymentIdentifier(payload);
  let settle: SettleResponse;
  try {
    settle = await fac.settle(settlePayload, req);
  } catch (e) {
    return { kind: "pending", snapshot: await snapshot(facilitatorFailure("settle", e)), handler: handlerSnap };
  }

  const paymentId = ((settle.extensions?.["settlement-status"] ?? {}) as { paymentId?: string }).paymentId;
  if (!settle.success && settle.errorReason === "settlement_pending") {
    const resolved = paymentId ? await pollStatus(fac, paymentId, req, pc.pendingPolls) : null;
    if (resolved?.status === "completed") {
      settle = { ...settle, success: true, transaction: resolved.transaction ?? "", payer: resolved.payer ?? settle.payer, amount: resolved.amount ?? settle.amount };
    } else if (resolved?.status === "failed") {
      settle = { ...settle, errorReason: "settlement_failed" };
    } else {
      const res = required(`settlement pending (paymentId ${paymentId ?? "unknown"}); retry with the SAME signed authorization to converge on this payment`, 402, {
        [HEADERS.paymentResponse]: encodeHeader(settle),
        [HEADERS.v1PaymentResponse]: encodeHeader(settle),
        [HEADERS.complir]: "pending",
      });
      return { kind: "pending", snapshot: await snapshot(res), handler: handlerSnap };
    }
  }

  if (!settle.success) {
    const res = required(`settlement failed: ${settle.errorReason ?? "unknown"}`, 402, {
      [HEADERS.paymentResponse]: encodeHeader(settle),
      [HEADERS.v1PaymentResponse]: encodeHeader(settle),
      [HEADERS.complir]: "settle-failed",
    });
    return { kind: "other", snapshot: await snapshot(res) };
  }

  // 4. paid: record it (sink) — from here on the payer has been charged and every failure path refunds
  const amountUsdc = atomicToUsdc(settle.amount ?? payload.payload.authorization.value);
  const event: PaymentEvent = {
    txHash: settle.transaction,
    payer: (settle.payer ?? payload.payload.authorization.from).toLowerCase(),
    amountUsdc,
    endpoint: url.pathname,
    network: settle.network || req.network,
    paymentId,
    at: Date.now(),
    refundable: Boolean(settle.transaction && (settle.payer ?? payload.payload.authorization.from)),
  };
  if (sink) {
    try {
      await sink(event);
    } catch (e) {
      console.error("[complir/pay] payment sink failed (payment already settled):", e);
    }
  }
  const refund = async (reason: string): Promise<Outcome> => {
    await needRefund(event, reason);
    const res = jsonError(502, "PAID_BUT_UNDELIVERED", `Payment settled (${settle.transaction}) but the response could not be delivered: ${reason}. A refund of ${amountUsdc} USDC to ${event.payer} has been queued; see /report.`, {
      [HEADERS.paymentResponse]: encodeHeader(settle),
      [HEADERS.v1PaymentResponse]: encodeHeader(settle),
      [HEADERS.complir]: "refund-queued",
    });
    // Terminal: the nonce is spent and refunded; a retry replays this error instead of re-running anything.
    return { kind: "settled", snapshot: await snapshot(res) };
  };

  // 5. settleFirst: run the handler now; any failure after this point is a refund, never a silent keep
  if (!handlerSnap) {
    try {
      handlerSnap = await snapshot(await run());
    } catch (e) {
      console.error("[complir/pay] handler threw after settlement; refunding:", e);
      return refund(`handler error: ${(e as Error)?.message ?? String(e)}`);
    }
    if (handlerSnap.status < 200 || handlerSnap.status >= 300) {
      await needRefund(event, `handler returned ${handlerSnap.status} after settlement`);
      const encoded = encodeHeader(settle);
      return { kind: "settled", snapshot: addHeaders(handlerSnap, { [HEADERS.paymentResponse]: encoded, [HEADERS.v1PaymentResponse]: encoded, [HEADERS.complir]: "refund-queued" }) };
    }
  }

  // 6. deliver: attach the receipt. A client that is already gone cannot receive it → refund.
  if (mode.signal?.aborted) return refund("client disconnected before the response was delivered");
  try {
    const encoded = encodeHeader(settle);
    const final = addHeaders(handlerSnap, {
      [HEADERS.paymentResponse]: encoded,
      [HEADERS.v1PaymentResponse]: encoded,
      [HEADERS.complir]: "settled",
    });
    return { kind: "settled", snapshot: final };
  } catch (e) {
    console.error("[complir/pay] could not build the paid response; refunding:", e);
    return refund(`response could not be built: ${(e as Error)?.message ?? String(e)}`);
  }
}

async function needRefund(event: PaymentEvent, reason: string): Promise<void> {
  const ev: RefundNeededEvent = { payer: event.payer, amountUsdc: event.amountUsdc, settleTxHash: event.txHash, paymentId: event.paymentId, endpoint: event.endpoint, network: event.network, reason, at: Date.now() };
  if (!refundSink) {
    console.error("[complir/pay] REFUND NEEDED but no refund sink is installed (call installRefundSink()):", ev);
    return;
  }
  try {
    await refundSink(ev);
  } catch (e) {
    console.error("[complir/pay] refund sink failed; refund NOT queued:", ev, e);
  }
}

async function pollStatus(fac: FacilitatorClient, paymentId: string, req: PaymentRequirements, polls: number) {
  for (let i = 0; i < polls; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const s = await fac.status(paymentId, { network: req.network, payTo: req.payTo });
      if (s.status === "completed" || s.status === "failed") return s;
    } catch (e) {
      console.warn("[complir/pay] status poll failed:", e);
    }
  }
  return null;
}

// ─── Requirements ────────────────────────────────────────────────────────────
function buildRequirements(pc: PaymentConfig, opts: X402Options, url: URL): { req: PaymentRequirements; resourceUrl: string } {
  const resourceUrl = opts.resource ?? `${pc.publicBaseUrl}${url.pathname}`;
  const req: PaymentRequirements = {
    scheme: "exact",
    network: pc.network,
    amount: usdcToAmountString(opts.priceUsdc),
    asset: pc.asset,
    payTo: pc.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
    // exact/EVM eip3009: EIP-712 domain of the token (USDC on Arc: name "USDC", version "2").
    extra: { assetTransferMethod: "eip3009", name: pc.assetName, version: pc.assetVersion },
  };
  return { req, resourceUrl };
}

/** Returns a reason string if the client's accepted requirements / authorization don't satisfy ours. */
export function matchRequirements(payload: PaymentPayload, req: PaymentRequirements): string | null {
  const a = payload.accepted;
  const auth = payload.payload.authorization;
  const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  if (a.scheme !== req.scheme) return `scheme ${a.scheme} != ${req.scheme}`;
  if (a.network !== req.network) return `network ${a.network} != ${req.network}`;
  if (!eq(a.asset, req.asset)) return `asset ${a.asset} != ${req.asset}`;
  if (!eq(a.payTo, req.payTo)) return `payTo ${a.payTo} != ${req.payTo}`;
  if (BigInt(a.amount) < BigInt(req.amount)) return `amount ${a.amount} < ${req.amount}`;
  if (!eq(auth.to, req.payTo)) return `authorization.to ${auth.to} != payTo ${req.payTo}`;
  if (BigInt(auth.value) < BigInt(req.amount)) return `authorization.value ${auth.value} < ${req.amount}`;
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(auth.validBefore) <= BigInt(now)) return "authorization expired (validBefore <= now)";
  if (BigInt(auth.validAfter) > BigInt(now)) return "authorization not yet valid (validAfter > now)";
  return null;
}

/**
 * Circle `payment-identifier` extension: retries with the same id converge on one payment. Derived from the
 * EIP-3009 nonce so a client retry with the same authorization is idempotent on the facilitator too.
 * https://developers.circle.com/api-reference/facilitator-service/settle-payment
 */
export function withPaymentIdentifier(payload: PaymentPayload): PaymentPayload {
  if (payload.extensions && "payment-identifier" in payload.extensions) return payload;
  const id = `complir_${payload.payload.authorization.nonce.slice(2)}`; // 8 + 64 = 72 chars, [A-Za-z0-9_-]
  return { ...payload, extensions: { ...(payload.extensions ?? {}), "payment-identifier": { info: { required: true, id } } } };
}

// ─── Responses ───────────────────────────────────────────────────────────────
export function buildPaymentRequired(resource: { url: string; description: string; mimeType: string }, req: PaymentRequirements, error?: string): PaymentRequired {
  return { x402Version: X402_VERSION, ...(error ? { error } : {}), resource, accepts: [req] };
}

function paymentRequiredResponse(
  resource: { url: string; description: string; mimeType: string },
  req: PaymentRequirements,
  error: string,
  status: number,
  extra: Record<string, string>,
): Response {
  const body = buildPaymentRequired(resource, req, error);
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    [HEADERS.paymentRequired]: encodeHeader(body),
    [HEADERS.complir]: "required",
  });
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

function facilitatorFailure(step: "verify" | "settle", e: unknown): Response {
  const fe = e instanceof FacilitatorError ? e : null;
  console.error(`[complir/pay] facilitator ${step} failed:`, fe ? `${fe.kind} ${fe.status ?? ""} ${fe.message}` : e, fe?.body ?? "");
  const code = step === "verify" ? "PAYMENT_VERIFY_UNAVAILABLE" : "PAYMENT_SETTLE_UNAVAILABLE";
  const msg =
    step === "verify"
      ? "Payment facilitator unavailable; no charge was made. Retry later."
      : "Payment settlement could not be confirmed. Retry with the SAME signed authorization; you will not be charged twice.";
  return jsonError(502, code, msg, { [HEADERS.complir]: step === "verify" ? "verify-unavailable" : "settle-unavailable" });
}

function jsonError(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

async function snapshot(res: Response): Promise<Snapshot> {
  const nobody = res.status === 204 || res.status === 304;
  const body = nobody ? null : await res.arrayBuffer();
  return { status: res.status, headers: [...res.headers.entries()], body };
}
function addHeaders(s: Snapshot, extra: Record<string, string>): Snapshot {
  const h = new Headers(s.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return { ...s, headers: [...h.entries()] };
}
function respond(s: Snapshot, extra: Record<string, string> = {}): Response {
  const h = new Headers(s.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(s.body, { status: s.status, headers: h });
}
async function withHeader(res: Response, name: string, value: string): Promise<Response> {
  try {
    res.headers.set(name, value);
    return res;
  } catch {
    return respond(await snapshot(res), { [name]: value });
  }
}
