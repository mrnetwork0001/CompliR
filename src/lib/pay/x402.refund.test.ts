/**
 * Refund hooks in the x402 gate: a payment that settled but was not honoured must reach the refund sink.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetConfig } from "../config";
import { __resetPay, setPaymentSink, setRefundSink, withX402, type PaymentEvent, type RefundNeededEvent } from "./x402";
import { encodeHeader, type PaymentPayload } from "./types";

const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const USDC = "0x3600000000000000000000000000000000000000";
const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const TX = `0x${"ab".repeat(32)}`;
const ENV = {
  ARC_CHAIN_ID: "5042", ARC_RPC_URL: "https://rpc.example.invalid", USDC_ADDRESS: USDC, X402_DISABLED: "0", X402_NETWORK: "eip155:5042",
  X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: "https://facilitator.test/v1/facilitator/x402", X402_PENDING_POLLS: "0", PUBLIC_BASE_URL: "https://complir.test",
};
const saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function facilitatorOk() {
  fetchMock.mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith("/verify")) return json({ isValid: true, payer: PAYER });
    if (u.endsWith("/settle")) return json({ success: true, transaction: TX, payer: PAYER, network: "eip155:5042", amount: "10000" });
    throw new Error(`unexpected fetch ${u}`);
  });
}
function payload(nonce = `0x${"11".repeat(32)}`): PaymentPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    x402Version: 2, resource: { url: "https://complir.test/api/v1/screen" },
    accepted: { scheme: "exact", network: "eip155:5042", amount: "10000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } },
    payload: { signature: `0x${"ab".repeat(65)}`, authorization: { from: PAYER, to: PAY_TO, value: "10000", validAfter: "0", validBefore: String(now + 600), nonce } },
  };
}
const request = (p: PaymentPayload, init: RequestInit = {}) =>
  new Request("https://complir.test/api/v1/screen", { method: "POST", headers: { "PAYMENT-SIGNATURE": encodeHeader(p), "Content-Type": "application/json" }, body: "{}", ...init });

const refunds: RefundNeededEvent[] = [];
const payments: PaymentEvent[] = [];
beforeEach(() => {
  for (const k of Object.keys(ENV)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  __resetConfig(); __resetPay();
  refunds.length = 0; payments.length = 0;
  setRefundSink(async (e) => { refunds.push(e); });
  setPaymentSink(async (e) => { payments.push(e); });
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetConfig(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("withX402 refunds", () => {
  it("settleFirst: handler throws after settlement → refund enqueued, payment recorded, client told", async () => {
    facilitatorOk();
    const handler = vi.fn(async () => { throw new Error("RPC timeout"); });
    const res = await withX402(handler, { priceUsdc: 0.01, description: "screen", settleFirst: true })(request(payload()), {});
    expect(res.status).toBe(502);
    expect(res.headers.get("X-CompliR-Payment")).toBe("refund-queued");
    expect((await res.json()).error.code).toBe("PAID_BUT_UNDELIVERED");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ txHash: TX, payer: PAYER.toLowerCase(), amountUsdc: "0.01", refundable: true });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ payer: PAYER.toLowerCase(), amountUsdc: "0.01", settleTxHash: TX, endpoint: "/api/v1/screen", network: "eip155:5042" });
    expect(refunds[0].reason).toMatch(/handler error: RPC timeout/);
  });

  it("settleFirst: handler returns 500 after settlement → refund enqueued, handler body returned with refund-queued", async () => {
    facilitatorOk();
    const handler = vi.fn(async () => Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }));
    const res = await withX402(handler, { priceUsdc: 0.01, description: "screen", settleFirst: true })(request(payload()), {});
    expect(res.status).toBe(500);
    expect(res.headers.get("X-CompliR-Payment")).toBe("refund-queued");
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(refunds).toHaveLength(1);
    expect(refunds[0].reason).toMatch(/returned 500 after settlement/);
  });

  it("settleFirst: happy path → no refund, response settled; a retry replays without re-running the handler", async () => {
    facilitatorOk();
    const handler = vi.fn(async () => Response.json({ tier: "LOW" }));
    const gate = withX402(handler, { priceUsdc: 0.01, description: "screen", settleFirst: true });
    const res = await gate(request(payload()), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("X-CompliR-Payment")).toBe("settled");
    expect(refunds).toHaveLength(0);
    const again = await gate(request(payload()), {});
    expect(again.headers.get("X-CompliR-Payment")).toBe("replay");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/settle"))).toHaveLength(1);
  });

  it("default order: handler failure before settlement never charges and never refunds", async () => {
    facilitatorOk();
    const handler = vi.fn(async () => { throw new Error("boom"); });
    const res = await withX402(handler, { priceUsdc: 0.01, description: "screen" })(request(payload()), {});
    expect(res.status).toBe(500);
    expect(res.headers.get("X-CompliR-Payment")).toBe("not-charged");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/settle"))).toHaveLength(0);
    expect(refunds).toHaveLength(0);
    expect(payments).toHaveLength(0);
  });

  it("client disconnected before the paid response could be delivered → refund enqueued, retry replays the refund notice", async () => {
    facilitatorOk();
    const ac = new AbortController();
    const handler = vi.fn(async () => { ac.abort(); return Response.json({ tier: "LOW", secret: "verdict" }); });
    const gate = withX402(handler, { priceUsdc: 0.01, description: "screen" });
    const res = await gate(request(payload(), { signal: ac.signal }), {});
    expect(res.status).toBe(502);
    expect(res.headers.get("X-CompliR-Payment")).toBe("refund-queued");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].reason).toMatch(/disconnected/);
    const again = await gate(request(payload()), {});
    expect(again.headers.get("X-CompliR-Payment")).toBe("replay");
    expect(await again.text()).not.toContain("verdict");
    expect(refunds).toHaveLength(1);
  });

  it("logs loudly but still answers when no refund sink is installed", async () => {
    facilitatorOk();
    setRefundSink(null);
    const handler = vi.fn(async () => { throw new Error("x"); });
    const res = await withX402(handler, { priceUsdc: 0.01, description: "screen", settleFirst: true })(request(payload()), {});
    expect(res.status).toBe(502);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/REFUND NEEDED/), expect.anything());
  });
});
