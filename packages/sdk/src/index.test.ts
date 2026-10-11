import { describe, expect, it, vi } from "vitest";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CompliR, CompliRPaymentError, type Attestation, type PaymentRequired } from "./index";
import { buildAttestationTypedData, signAttestation } from "@/lib/attest/eip712";

const BUYER_KEY = `0x${"11".repeat(32)}` as const;
const buyer = privateKeyToAccount(BUYER_KEY);
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const USDC = "0x3600000000000000000000000000000000000000";

const required: PaymentRequired = {
  x402Version: 2,
  error: "PAYMENT-SIGNATURE header is required",
  resource: { url: "https://complir.test/api/v1/screen", description: "CompliR screen", mimeType: "application/json" },
  accepts: [{ scheme: "exact", network: "eip155:5042002", amount: "10000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" } }],
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const challenge = () => new Response(JSON.stringify(required), { status: 402, headers: { "PAYMENT-REQUIRED": b64(required), "Content-Type": "application/json" } });
const verdict = { address: "0xabc", score: 5, tier: "LOW", recommendedLimits: { maxPerTxUsdc: 1000, maxPerDayUsdc: 5000 }, decisionId: "dec_1" };

describe("CompliR SDK x402 flow", () => {
  it("402 → signs EIP-3009 authorization → retries with PAYMENT-SIGNATURE → returns verdict + receipt", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      const h = new Headers(init.headers);
      if (!h.get("PAYMENT-SIGNATURE")) return challenge();
      const payload = JSON.parse(Buffer.from(h.get("PAYMENT-SIGNATURE")!, "base64").toString("utf8"));
      expect(payload.x402Version).toBe(2);
      expect(payload.accepted).toEqual(required.accepts[0]);
      expect(payload.resource).toEqual(required.resource);
      const a = payload.payload.authorization;
      expect(a).toMatchObject({ from: buyer.address, to: PAY_TO, value: "10000", validAfter: "0" });
      expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
      expect(Number(a.validBefore)).toBeGreaterThan(Math.floor(Date.now() / 1000) + 60);
      const ok = await verifyTypedData({
        address: buyer.address,
        domain: { name: "USDC", version: "2", chainId: 5042002, verifyingContract: USDC },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
        signature: payload.payload.signature,
      });
      expect(ok).toBe(true);
      const receipt = { success: true, transaction: "0xtx", network: "eip155:5042002", payer: buyer.address, amount: "10000" };
      return new Response(JSON.stringify(verdict), { status: 200, headers: { "Content-Type": "application/json", "PAYMENT-RESPONSE": b64(receipt) } });
    });

    const c = new CompliR({ baseUrl: "https://complir.test/", account: buyer, fetch: fetchMock as unknown as typeof fetch });
    const v = await c.screen("0xabc", { amountUsdc: 120 });
    expect(v).toEqual(verdict);
    expect(seen).toHaveLength(2);
    expect(seen[0].url).toBe("https://complir.test/api/v1/screen");
    expect(JSON.parse(seen[1].init.body as string)).toEqual({ address: "0xabc", amountUsdc: 120 });
    expect(c.lastPayment).toMatchObject({ success: true, transaction: "0xtx" });
  });

  it("refuses to pay above maxPriceUsdc without a second request", async () => {
    const fetchMock = vi.fn(async () => challenge());
    const c = new CompliR({ baseUrl: "https://complir.test", account: buyer, maxPriceUsdc: 0.005, fetch: fetchMock as unknown as typeof fetch });
    await expect(c.screen("0xabc")).rejects.toBeInstanceOf(CompliRPaymentError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws CompliRPaymentError with the server reason when the retry is rejected", async () => {
    const rejected = { ...required, error: "payment verification failed: insufficient_funds" };
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
      new Headers(init.headers).get("PAYMENT-SIGNATURE")
        ? new Response(JSON.stringify(rejected), { status: 402, headers: { "PAYMENT-REQUIRED": b64(rejected) } })
        : challenge(),
    );
    const c = new CompliR({ baseUrl: "https://complir.test", account: buyer, fetch: fetchMock as unknown as typeof fetch });
    const err = (await c.screen("0xabc").catch((e) => e)) as CompliRPaymentError;
    expect(err).toBeInstanceOf(CompliRPaymentError);
    expect(err.message).toMatch(/insufficient_funds/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the JSON body when PAYMENT-REQUIRED header is absent (v1-style servers)", async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
      new Headers(init.headers).get("PAYMENT-SIGNATURE")
        ? new Response(JSON.stringify(verdict), { status: 200 })
        : new Response(JSON.stringify(required), { status: 402, headers: { "Content-Type": "application/json" } }),
    );
    const c = new CompliR({ baseUrl: "https://complir.test", account: buyer, fetch: fetchMock as unknown as typeof fetch });
    expect(await c.screen("0xabc")).toEqual(verdict);
  });

  it("free endpoints pass straight through", async () => {
    const fetchMock = vi.fn(async () => new Response("null", { status: 404 }));
    const c = new CompliR({ baseUrl: "https://complir.test", account: buyer, fetch: fetchMock as unknown as typeof fetch });
    expect(await c.attestation("0xabc")).toBeNull();
  });
});

describe("CompliR.verifyAttestation (offline)", () => {
  const ATTESTER_KEY = `0x${"22".repeat(32)}` as const;
  const attester = privateKeyToAccount(ATTESTER_KEY);
  const now = 1_800_000_000;
  const td = buildAttestationTypedData({
    subject: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    tier: "LOW",
    score: 5,
    decisionHash: `0x${"ab".repeat(32)}`,
    issuedAt: now,
    chainId: 5042002,
    verifyingContract: PAY_TO,
  });

  it("accepts an attestation signed by the server's eip712 module", async () => {
    const att = (await signAttestation(td, ATTESTER_KEY)) as unknown as Attestation;
    expect(await CompliR.verifyAttestation(att, { now, expectedAttester: attester.address.toLowerCase() as `0x${string}`, expectedChainId: 5042002 })).toBe(true);
  });
  it("rejects tampering, expiry, and wrong attester", async () => {
    const att = (await signAttestation(td, ATTESTER_KEY)) as unknown as Attestation;
    const tampered = { ...att, typedData: { ...att.typedData, message: { ...att.typedData.message, score: 90 } } };
    expect(await CompliR.verifyAttestation(tampered, { now })).toBe(false);
    expect(await CompliR.verifyAttestation(att, { now: att.validUntil + 1 })).toBe(false);
    expect(await CompliR.verifyAttestation(att, { now: att.validUntil + 1, ignoreExpiry: true })).toBe(true);
    expect(await CompliR.verifyAttestation(att, { now, expectedAttester: PAY_TO })).toBe(false);
    expect(await CompliR.verifyAttestation({ ...att, attester: PAY_TO }, { now })).toBe(false);
  });
});
