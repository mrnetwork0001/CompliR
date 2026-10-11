import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetConfig } from "../config";
import { __resetPay, setPaymentSink, withX402, type PaymentEvent } from "./x402";
import { decodeHeader, encodeHeader, type PaymentPayload, type PaymentRequired } from "./types";

const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const USDC = "0x3600000000000000000000000000000000000000";
const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const FAC = "https://facilitator.test/v1/facilitator/x402";

const ENV = {
  ARC_CHAIN_ID: "5042002",
  ARC_RPC_URL: "https://rpc.testnet.arc.io",
  USDC_ADDRESS: USDC,
  X402_DISABLED: "0",
  X402_NETWORK: "eip155:5042002",
  X402_PAY_TO: PAY_TO,
  X402_FACILITATOR_URL: FAC,
  X402_PENDING_POLLS: "0",
  PUBLIC_BASE_URL: "https://complir.test",
};
const saved: Record<string, string | undefined> = {};

function setEnv(over: Record<string, string> = {}) {
  for (const [k, v] of Object.entries({ ...ENV, ...over })) process.env[k] = v;
  __resetConfig();
}

const fetchMock = vi.fn<typeof fetch>();
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function facilitatorOk(settle: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith("/verify")) return json({ isValid: true, payer: PAYER });
    if (u.endsWith("/settle")) return json({ success: true, transaction: "0xtx", payer: PAYER, network: "eip155:5042002", amount: "10000", ...settle });
    throw new Error(`unexpected fetch ${u}`);
  });
}
function calls(suffix: string) {
  return fetchMock.mock.calls.filter(([u]) => String(u).endsWith(suffix));
}
function settleBody(i = 0): PaymentPayload & Record<string, unknown> {
  const init = calls("/settle")[i][1]!;
  return JSON.parse(init.body as string).paymentPayload;
}

function payload(over: Partial<PaymentPayload["payload"]["authorization"]> = {}, accepted: Partial<PaymentPayload["accepted"]> = {}): PaymentPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    x402Version: 2,
    resource: { url: "https://complir.test/api/v1/screen" },
    accepted: {
      scheme: "exact",
      network: "eip155:5042002",
      amount: "10000",
      asset: USDC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
      ...accepted,
    },
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: "10000",
        validAfter: "0",
        validBefore: String(now + 600),
        nonce: `0x${"11".repeat(32)}`,
        ...over,
      },
    },
  };
}

const handler = vi.fn(async () => Response.json({ tier: "LOW", secret: "verdict" }, { headers: { "X-CompliR-Decision-Id": "dec_1" } }));
const wrapped = () => withX402(handler, { priceUsdc: 0.01, description: "CompliR screen: one address" });
const request = (p?: PaymentPayload, headerName = "PAYMENT-SIGNATURE") =>
  new Request("https://complir.test/api/v1/screen", {
    method: "POST",
    headers: p ? { [headerName]: encodeHeader(p), "Content-Type": "application/json" } : {},
    body: JSON.stringify({ address: PAYER }),
  });

beforeEach(() => {
  for (const k of Object.keys(ENV)) saved[k] = process.env[k];
  setEnv();
  __resetPay();
  handler.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetConfig();
  vi.unstubAllGlobals();
});

describe("withX402: 402 challenge", () => {
  it("returns a spec-shaped PaymentRequired in PAYMENT-REQUIRED header and JSON body", async () => {
    const res = await wrapped()(request(), {});
    expect(res.status).toBe(402);
    expect(res.headers.get("X-CompliR-Payment")).toBe("required");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const header = decodeHeader(res.headers.get("PAYMENT-REQUIRED")!) as PaymentRequired;
    const body = (await res.json()) as PaymentRequired;
    expect(body).toEqual(header);
    expect(header.x402Version).toBe(2);
    expect(header.error).toMatch(/PAYMENT-SIGNATURE/);
    expect(header.resource).toEqual({ url: "https://complir.test/api/v1/screen", description: "CompliR screen: one address", mimeType: "application/json" });
    expect(header.accepts).toHaveLength(1);
    expect(header.accepts[0]).toEqual({
      scheme: "exact",
      network: "eip155:5042002",
      amount: "10000",
      asset: USDC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults network to eip155:<ARC_CHAIN_ID> when X402_NETWORK is unset", async () => {
    delete process.env.X402_NETWORK;
    __resetConfig();
    const res = await wrapped()(request(), {});
    const header = decodeHeader(res.headers.get("PAYMENT-REQUIRED")!) as PaymentRequired;
    expect(header.accepts[0].network).toBe("eip155:5042002");
  });

  it("rejects a malformed payment header with 402 and no facilitator call", async () => {
    const req = new Request("https://complir.test/api/v1/screen", { method: "POST", headers: { "PAYMENT-SIGNATURE": "not-base64-json" } });
    const res = await wrapped()(req, {});
    expect(res.status).toBe(402);
    expect(((await res.json()) as PaymentRequired).error).toMatch(/invalid payment payload/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a payload that does not meet the requirements before verifying", async () => {
    const res = await wrapped()(request(payload({ value: "5000" }, { amount: "5000" })), {});
    expect(res.status).toBe(402);
    expect(((await res.json()) as PaymentRequired).error).toMatch(/does not match requirements: amount/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("503 when enabled but misconfigured (fail closed, no charge)", async () => {
    delete process.env.X402_PAY_TO;
    __resetConfig();
    const res = await wrapped()(request(), {});
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("withX402: disabled", () => {
  it("passes through and tags the response", async () => {
    setEnv({ X402_DISABLED: "1" });
    const res = await wrapped()(request(), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("X-CompliR-Payment")).toBe("disabled");
    expect(res.headers.get("X-CompliR-Decision-Id")).toBe("dec_1");
    expect(await res.json()).toEqual({ tier: "LOW", secret: "verdict" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("withX402: verify", () => {
  it("402 with the facilitator's reason when verify says invalid; handler never runs", async () => {
    fetchMock.mockResolvedValueOnce(json({ isValid: false, invalidReason: "insufficient_funds", payer: PAYER }));
    const res = await wrapped()(request(payload()), {});
    expect(res.status).toBe(402);
    const body = (await res.json()) as PaymentRequired;
    expect(body.error).toBe("payment verification failed: insufficient_funds");
    expect(body.accepts[0].amount).toBe("10000");
    expect(handler).not.toHaveBeenCalled();
    expect(calls("/settle")).toHaveLength(0);
  });

  it("502 when the facilitator is unreachable; handler never runs", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await wrapped()(request(payload()), {});
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PAYMENT_VERIFY_UNAVAILABLE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("502 when the facilitator returns a non-2xx (e.g. 401 bad seller proof)", async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 401, message: "unauthorized" }, 401));
    const res = await wrapped()(request(payload()), {});
    expect(res.status).toBe(502);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("withX402: happy path", () => {
  it("verify → handler → settle → PAYMENT-RESPONSE + sink", async () => {
    facilitatorOk();
    const events: PaymentEvent[] = [];
    setPaymentSink((e) => void events.push(e));

    const res = await wrapped()(request(payload()), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tier: "LOW", secret: "verdict" });
    expect(res.headers.get("X-CompliR-Decision-Id")).toBe("dec_1");
    expect(res.headers.get("X-CompliR-Payment")).toBe("settled");
    const receipt = decodeHeader(res.headers.get("PAYMENT-RESPONSE")!) as { success: boolean; transaction: string };
    expect(receipt).toMatchObject({ success: true, transaction: "0xtx", network: "eip155:5042002" });
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBe(res.headers.get("PAYMENT-RESPONSE"));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls("/verify")).toHaveLength(1);
    expect(calls("/settle")).toHaveLength(1);
    expect(calls("/verify")[0][0]).toBe(`${FAC}/verify`);
    const verifyBody = JSON.parse(calls("/verify")[0][1]!.body as string);
    expect(verifyBody.x402Version).toBe(2);
    expect(verifyBody.paymentRequirements.payTo).toBe(PAY_TO);
    expect(verifyBody.paymentPayload.payload.authorization.nonce).toBe(`0x${"11".repeat(32)}`);
    // Circle payment-identifier extension derived from the nonce (idempotent on the facilitator side too)
    expect(settleBody().extensions).toEqual({ "payment-identifier": { info: { required: true, id: `complir_${"11".repeat(32)}` } } });

    expect(events).toEqual([
      expect.objectContaining({ txHash: "0xtx", payer: PAYER.toLowerCase(), amountUsdc: "0.01", endpoint: "/api/v1/screen", network: "eip155:5042002" }),
    ]);
  });

  it("accepts the v1 X-PAYMENT header name as an alias", async () => {
    facilitatorOk();
    const res = await wrapped()(request(payload(), "X-PAYMENT"), {});
    expect(res.status).toBe(200);
  });

  it("does not settle when the handler returns non-2xx", async () => {
    facilitatorOk();
    handler.mockResolvedValueOnce(Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 400 }));
    const res = await wrapped()(request(payload()), {});
    expect(res.status).toBe(400);
    expect(res.headers.get("X-CompliR-Payment")).toBe("not-charged");
    expect(calls("/settle")).toHaveLength(0);
  });

  it("sink errors never affect the response", async () => {
    facilitatorOk();
    setPaymentSink(() => {
      throw new Error("ledger down");
    });
    const res = await wrapped()(request(payload()), {});
    expect(res.status).toBe(200);
  });
});

describe("withX402: settle failures never leak the verdict", () => {
  it("402 + PAYMENT-RESPONSE when settle reports failure", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/verify")) return json({ isValid: true, payer: PAYER });
      return json({ success: false, errorReason: "invalid_exact_evm_payload_signature", transaction: "", network: "eip155:5042002" });
    });
    const res = await wrapped()(request(payload()), {});
    expect(res.status).toBe(402);
    expect(res.headers.get("X-CompliR-Payment")).toBe("settle-failed");
    const text = await res.text();
    expect(text).not.toContain("verdict");
    expect(JSON.parse(text).error).toMatch(/settlement failed: invalid_exact_evm_payload_signature/);
    expect(decodeHeader(res.headers.get("PAYMENT-RESPONSE")!)).toMatchObject({ success: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("502 when settle is unreachable", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/verify")) return json({ isValid: true, payer: PAYER });
      throw new Error("timeout");
    });
    const res = await wrapped()(request(payload()), {});
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("verdict");
  });

  it("settlement_pending → 402 pending; retry with same authorization re-settles WITHOUT re-running the handler", async () => {
    let settles = 0;
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/verify")) return json({ isValid: true, payer: PAYER });
      if (u.endsWith("/settle")) {
        settles++;
        if (settles === 1)
          return json({ success: false, errorReason: "settlement_pending", transaction: "", network: "eip155:5042002", extensions: { "settlement-status": { status: "pending", paymentId: "pid-1" } } });
        return json({ success: true, transaction: "0xtx2", payer: PAYER, network: "eip155:5042002", amount: "10000" });
      }
      throw new Error("unexpected " + u);
    });
    const events: PaymentEvent[] = [];
    setPaymentSink((e) => void events.push(e));

    const first = await wrapped()(request(payload()), {});
    expect(first.status).toBe(402);
    expect(first.headers.get("X-CompliR-Payment")).toBe("pending");
    expect(await first.text()).not.toContain("verdict");

    const second = await wrapped()(request(payload()), {});
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ tier: "LOW", secret: "verdict" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(settles).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ txHash: "0xtx2", endpoint: "/api/v1/screen" });
  });
});

describe("withX402: idempotency", () => {
  it("replays the cached response on retry with the same nonce; no second settle, no second handler run", async () => {
    facilitatorOk();
    const events: PaymentEvent[] = [];
    setPaymentSink((e) => void events.push(e));
    const h = wrapped();

    const a = await h(request(payload()), {});
    const b = await h(request(payload()), {});
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers.get("X-CompliR-Payment")).toBe("replay");
    expect(await b.json()).toEqual({ tier: "LOW", secret: "verdict" });
    expect(b.headers.get("PAYMENT-RESPONSE")).toBe(a.headers.get("PAYMENT-RESPONSE"));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls("/settle")).toHaveLength(1);
    expect(calls("/verify")).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("dedupes concurrent duplicates", async () => {
    facilitatorOk();
    const h = wrapped();
    const [a, b] = await Promise.all([h(request(payload()), {}), h(request(payload()), {})]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls("/settle")).toHaveLength(1);
  });

  it("a different nonce is a new payment", async () => {
    facilitatorOk();
    const h = wrapped();
    await h(request(payload()), {});
    await h(request(payload({ nonce: `0x${"22".repeat(32)}` })), {});
    expect(handler).toHaveBeenCalledTimes(2);
    expect(calls("/settle")).toHaveLength(2);
  });

  it("expires after IDEMPOTENCY_TTL_MS", async () => {
    vi.useFakeTimers();
    try {
      facilitatorOk();
      const h = wrapped();
      await h(request(payload()), {});
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
      const res = await h(request(payload({ validBefore: String(Math.floor(Date.now() / 1000) + 600) })), {});
      expect(res.status).toBe(200);
      expect(res.headers.get("X-CompliR-Payment")).toBe("settled");
      expect(calls("/settle")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
