import { describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FacilitatorClient, FacilitatorError, SELLER_PROOF_TYPES, buildSellerProof, chainIdFromCaip2 } from "./facilitator";
import type { PaymentPayload, PaymentRequirements } from "./types";

const SELLER_KEY = `0x${"42".repeat(32)}` as const;
const seller = privateKeyToAccount(SELLER_KEY);
const req: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:5042002",
  amount: "10000",
  asset: "0x3600000000000000000000000000000000000000",
  payTo: seller.address,
  maxTimeoutSeconds: 60,
};
const payload: PaymentPayload = {
  x402Version: 2,
  accepted: req,
  payload: {
    signature: `0x${"ab".repeat(65)}`,
    authorization: { from: seller.address, to: seller.address, value: "10000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"01".repeat(32)}` },
  },
};
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe("FacilitatorClient auth", () => {
  it("sends Authorization: Bearer when an API key is configured", async () => {
    const fetchMock = vi.fn(async () => ok({ isValid: true, payer: seller.address }));
    const c = new FacilitatorClient({ baseUrl: "https://api.circle.com/v1/facilitator/x402/", apiKey: "TEST_KEY", fetch: fetchMock as unknown as typeof fetch });
    const v = await c.verify(payload, req);
    expect(v.isValid).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.circle.com/v1/facilitator/x402/verify");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TEST_KEY");
    expect((init.headers as Record<string, string>)["Facilitator-Seller-Proof"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
  });

  it("sends a Facilitator-Seller-Proof bound to the body, signed by the payTo key", async () => {
    const fetchMock = vi.fn(async () => ok({ success: true, transaction: "0xtx", payer: seller.address, network: req.network, amount: "10000" }));
    const c = new FacilitatorClient({ baseUrl: "https://api.circle.com/v1/facilitator/x402", sellerPrivateKey: SELLER_KEY, fetch: fetchMock as unknown as typeof fetch });
    const s = await c.settle(payload, req);
    expect(s.success).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const proof = (init.headers as Record<string, string>)["Facilitator-Seller-Proof"];
    const env = JSON.parse(Buffer.from(proof, "base64url").toString("utf8"));
    expect(env).toMatchObject({ version: 1, network: req.network, payTo: seller.address });
    expect(env.expiresAt - env.issuedAt).toBe(300);
    const valid = await verifyTypedData({
      address: seller.address,
      domain: { name: "Circle Facilitator Seller Request", version: "1", chainId: 5042002 },
      types: SELLER_PROOF_TYPES,
      primaryType: "SellerRequest",
      message: {
        purpose: "settle",
        method: "POST",
        bodyHash: keccak256(toBytes(init.body as string)),
        network: req.network,
        payTo: seller.address,
        nonce: env.nonce,
        issuedAt: BigInt(env.issuedAt),
        expiresAt: BigInt(env.expiresAt),
      },
      signature: env.signature,
    });
    expect(valid).toBe(true);
  });

  it("buildSellerProof hashes an empty body for GET status calls", async () => {
    const proof = await buildSellerProof({ account: seller, purpose: "status", method: "get", body: "", network: req.network, payTo: seller.address, now: 1_700_000_000, nonce: `0x${"07".repeat(32)}` });
    const env = JSON.parse(Buffer.from(proof, "base64url").toString("utf8"));
    expect(env.issuedAt).toBe(1_700_000_000);
    expect(env.expiresAt).toBe(1_700_000_300);
    expect(env.nonce).toBe(`0x${"07".repeat(32)}`);
  });
});

describe("FacilitatorClient errors", () => {
  it("times out", async () => {
    const fetchMock = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const c = new FacilitatorClient({ baseUrl: "https://f.test", timeoutMs: 10, fetch: fetchMock as unknown as typeof fetch });
    await expect(c.verify(payload, req)).rejects.toMatchObject({ name: "FacilitatorError", kind: "timeout" });
  });
  it("wraps non-2xx as http errors with the body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 403, message: "registration_required" }), { status: 403 }));
    const c = new FacilitatorClient({ baseUrl: "https://f.test", fetch: fetchMock as unknown as typeof fetch });
    const err = (await c.settle(payload, req).catch((e) => e)) as FacilitatorError;
    expect(err).toBeInstanceOf(FacilitatorError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(403);
    expect(err.body).toMatchObject({ message: "registration_required" });
  });
  it("rejects malformed responses", async () => {
    const fetchMock = vi.fn(async () => ok({ nope: true }));
    const c = new FacilitatorClient({ baseUrl: "https://f.test", fetch: fetchMock as unknown as typeof fetch });
    await expect(c.verify(payload, req)).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("parses CAIP-2", () => {
    expect(chainIdFromCaip2("eip155:5042")).toBe(5042);
    expect(() => chainIdFromCaip2("arc-mainnet")).toThrow();
  });
});
