import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { privateKeyToAccount } from "viem/accounts";
import { ATTESTATION_TYPES, type Attestation } from "../../sdk/src/index";
import { Api } from "./api";
import { createServer, TOOL_NAMES } from "./server";
import { readEnv } from "./cli";

const SUBJECT = "0x000000000000000000000000000000000000dead";
const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ATTESTER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

type FetchCall = { url: string; init: RequestInit | undefined };
function mockFetch(handler: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

async function connect(fetchImpl: typeof fetch, payerPrivateKey?: string) {
  const api = new Api({ baseUrl: "http://complir.test/", maxPriceUsdc: 0.1, payerPrivateKey, fetch: fetchImpl });
  const server = createServer(api);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, api, close: () => Promise.all([client.close(), server.close()]) };
}
function textOf(res: unknown): string {
  const c = (((res as { content?: unknown }).content ?? []) as { type: string; text?: string }[]).find((x) => x.type === "text");
  return c?.text ?? "";
}

async function signedAttestation(overrides: Partial<Attestation["typedData"]["message"]> = {}): Promise<Attestation> {
  const attester = privateKeyToAccount(ATTESTER_KEY);
  const now = Math.floor(Date.now() / 1000);
  const message = { subject: SUBJECT as `0x${string}`, tier: 2, score: 37, decisionHash: `0x${"ab".repeat(32)}` as `0x${string}`, issuedAt: now - 60, validUntil: now + 86_400, ...overrides };
  const domain = { name: "CompliR" as const, version: "1" as const, chainId: 5042, verifyingContract: "0x1111111111111111111111111111111111111111" as `0x${string}` };
  const signature = await attester.signTypedData({
    domain: { ...domain, chainId: BigInt(domain.chainId) },
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message: { ...message, issuedAt: BigInt(message.issuedAt), validUntil: BigInt(message.validUntil) },
  });
  return { typedData: { domain, types: { Attestation: [...ATTESTATION_TYPES.Attestation] }, primaryType: "Attestation", message }, signature, attester: attester.address, validUntil: message.validUntil, registryTx: null };
}

function fatVerdict(att: Attestation, funderCount = 40) {
  const funders = Array.from({ length: funderCount }, (_, i) => {
    const from = `0x${(i + 1).toString(16).padStart(40, "a")}`;
    const flagged = i === 7;
    return {
      hop: i % 3 === 0 ? 2 : 1,
      path: [{ from, to: SUBJECT, txHash: `0x${i.toString(16).padStart(64, "0")}`, amountUsdc: (1000 - i * 10).toFixed(6), timestamp: 1_700_000_000 + i }],
      facts: { address: from, firstSeen: 1_690_000_000, txCount: 50 + i, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: flagged ? [{ source: "opensanctions", entityId: "Q1", caption: "Bad Actor", datasets: ["us_ofac_sdn"], score: 0.97, matchedOn: "address" }] : [] },
    };
  });
  return {
    address: SUBJECT,
    score: 37,
    tier: "MEDIUM",
    recommendedLimits: { maxPerTxUsdc: 250, maxPerDayUsdc: 1000 },
    reasons: [
      { code: "FUNDER_2HOP_SANCTIONED", weight: 25, evidence: { path: ["0xA", "0xB", "0xSDN"], txs: Array.from({ length: 30 }, (_, i) => `0x${i}`) } },
      { code: "FRESH_WALLET", weight: 12, evidence: { firstSeen: 1_700_000_000, txCount: 3 } },
    ],
    rationale: "Two-hop exposure to a sanctioned funder; limit and request source-of-funds.",
    eddRequested: ["Confirm source of funds for 0xB"],
    nextRescreenAt: "2026-10-14T03:00:00Z",
    attestation: att,
    decisionId: "dec_01JTESTTESTTESTTESTTESTTEST",
    screenedAt: "2026-10-13T03:00:00Z",
    edd: { id: "edd_01JTEST", url: "https://complir.test/edd/edd_01JTEST" },
    evidence: {
      subject: { address: SUBJECT, firstSeen: 1_700_000_000, txCount: 3, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] },
      funders,
      lookalikes: [],
      payeeChanged: null,
      concentration: null,
      priorTier: null,
      collectedAt: 1_700_000_100,
      depth: 2,
    },
  };
}

const paymentRequired = {
  x402Version: 2,
  error: "payment required",
  resource: { url: "http://complir.test/api/v1/screen", description: "CompliR screen: one address" },
  accepts: [{ scheme: "exact", network: "eip155:5042", amount: "10000", asset: "0x2222222222222222222222222222222222222222", payTo: "0x3333333333333333333333333333333333333333", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

describe("@complir/mcp", () => {
  it("lists every tool, the resources and the prompt", async () => {
    const { client, close } = await connect(mockFetch(() => json({})).fn);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools.tools) expect(t.description?.length ?? 0).toBeGreaterThan(40);
    const screen = tools.tools.find((t) => t.name === "screen_counterparty")!;
    expect(screen.inputSchema.required).toEqual(["address"]);
    expect(Object.keys(screen.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["address", "name", "amountUsdc", "payeeBook", "depth"]));

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain("complir://docs");
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((r) => r.uriTemplate)).toContain("complir://attestation/{address}");
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(["pay_safely"]);
    const prompt = await client.getPrompt({ name: "pay_safely", arguments: { address: SUBJECT, amountUsdc: "120" } });
    const text = (prompt.messages[0].content as { text: string }).text;
    expect(text).toContain("screen_counterparty");
    expect(text).toContain("recommendedLimits.maxPerTxUsdc");
    expect(text).toContain("edd.url");
    expect(text).toContain("attestation");
    await close();
  });

  it("screen_counterparty posts the request and compacts the verdict", async () => {
    const att = await signedAttestation();
    const fat = fatVerdict(att);
    const { fn, calls } = mockFetch(() => json(fat));
    const { client, close } = await connect(fn);
    const res = await client.callTool({ name: "screen_counterparty", arguments: { address: SUBJECT, amountUsdc: 120, name: "Acme Supplies", payeeBook: [{ label: "Lela", address: "0x12ab000000000000000000000000000000009f3c" }] } });
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://complir.test/api/v1/screen");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ address: SUBJECT, amountUsdc: 120, name: "Acme Supplies", payeeBook: [{ label: "Lela", address: "0x12ab000000000000000000000000000000009f3c" }] });

    const text = textOf(res);
    const out = JSON.parse(text);
    expect(res.structuredContent).toEqual(out);
    expect(out).toMatchObject({
      decisionId: "dec_01JTESTTESTTESTTESTTESTTEST",
      tier: "MEDIUM",
      score: 37,
      recommendedLimits: { maxPerTxUsdc: 250, maxPerDayUsdc: 1000 },
      rationale: fat.rationale,
      edd: { url: "https://complir.test/edd/edd_01JTEST" },
      eddRequested: ["Confirm source of funds for 0xB"],
    });
    expect(out.reasons.map((r: { code: string }) => r.code)).toEqual(["FUNDER_2HOP_SANCTIONED", "FRESH_WALLET"]);
    expect(out.attestation.signature).toBe(att.signature);
    expect(out.attestation.typedData.message.decisionHash).toBe(att.typedData.message.decisionHash);
    // funder graph → counts + top paths, sanctioned funder first
    expect(out.evidence.funders).toMatchObject({ total: 40, flagged: 1 });
    expect(out.evidence.funders.hop1 + out.evidence.funders.hop2).toBe(40);
    expect(out.evidence.funders.topPaths).toHaveLength(3);
    expect(out.evidence.funders.topPaths[0].flags).toEqual(["SANCTIONED"]);
    expect(out.evidence.funders.topPaths[0].path).toEqual([fat.evidence.funders[7].path[0].from, SUBJECT]);
    expect(out.evidence.subject).toEqual({ firstSeen: 1_700_000_000, txCount: 3, usdcBlacklisted: false, protocolBlocklisted: false, sanctionsHits: 0 });
    // reason evidence arrays are trimmed
    expect(out.reasons[0].evidence.txs).toHaveLength(5);
    expect(out.reasons[0].evidence.txs[4]).toMatch(/^…\+26 more$/);
    expect(text.length).toBeLessThan(JSON.stringify(fat).length / 4);
    await close();
  });

  it("verify_attestation accepts a valid attestation and rejects a tampered one", async () => {
    const att = await signedAttestation();
    const { client, close } = await connect(mockFetch(() => json({})).fn);
    const good = JSON.parse(textOf(await client.callTool({ name: "verify_attestation", arguments: { attestation: att, expectedAttester: att.attester, expectedChainId: 5042 } })));
    expect(good).toMatchObject({ valid: true, signatureValid: true, expired: false, reason: null, subject: SUBJECT, tier: "MEDIUM", score: 37, attester: att.attester, chainId: 5042 });

    const tampered = { ...att, typedData: { ...att.typedData, message: { ...att.typedData.message, score: 5, tier: 1 } } };
    const bad = JSON.parse(textOf(await client.callTool({ name: "verify_attestation", arguments: { attestation: tampered } })));
    expect(bad.valid).toBe(false);
    expect(bad.signatureValid).toBe(false);
    expect(bad.reason).toMatch(/invalid signature/);

    const wrongSigner = JSON.parse(textOf(await client.callTool({ name: "verify_attestation", arguments: { attestation: att, expectedAttester: "0x4444444444444444444444444444444444444444" } })));
    expect(wrongSigner.valid).toBe(false);

    const expiredAtt = await signedAttestation({ issuedAt: 1_600_000_000, validUntil: 1_600_000_100 });
    const expired = JSON.parse(textOf(await client.callTool({ name: "verify_attestation", arguments: { attestation: expiredAtt } })));
    expect(expired).toMatchObject({ valid: false, signatureValid: true, expired: true, reason: "expired" });
    await close();
  });

  it("maps a 402 without a payer key to an actionable error", async () => {
    const { fn } = mockFetch(() => json(paymentRequired, 402, { "PAYMENT-REQUIRED": b64(paymentRequired) }));
    const { client, close } = await connect(fn);
    const res = await client.callTool({ name: "screen_counterparty", arguments: { address: SUBJECT } });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/^PAYMENT_REQUIRED: Payment required: POST \/api\/v1\/screen costs 0\.01 USDC on eip155:5042/);
    expect(text).toContain("COMPLIR_PAYER_PRIVATE_KEY");
    expect(text).toContain("X402_DISABLED=1");
    await close();
  });

  it("pays through the SDK when a payer key is configured", async () => {
    const att = await signedAttestation();
    const { fn, calls } = mockFetch((_url, init, n) => {
      const headers = new Headers(init?.headers);
      if (n === 1) {
        expect(headers.get("PAYMENT-SIGNATURE")).toBeNull();
        return json(paymentRequired, 402, { "PAYMENT-REQUIRED": b64(paymentRequired) });
      }
      const payload = JSON.parse(Buffer.from(headers.get("PAYMENT-SIGNATURE")!, "base64").toString());
      expect(payload.x402Version).toBe(2);
      expect(payload.payload.authorization.value).toBe("10000");
      return json(fatVerdict(att, 2), 200, { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xsettled", network: "eip155:5042", payer: privateKeyToAccount(PAYER_KEY).address, amount: "10000" }) });
    });
    const { client, api, close } = await connect(fn, PAYER_KEY);
    expect(api.payerAddress).toBe(privateKeyToAccount(PAYER_KEY).address);
    const res = await client.callTool({ name: "screen_counterparty", arguments: { address: SUBJECT } });
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    const out = JSON.parse(textOf(res));
    expect(out.tier).toBe("MEDIUM");
    expect(out.payment).toEqual({ transaction: "0xsettled", network: "eip155:5042", amount: "10000" });
    await close();
  });

  it("refuses to pay above COMPLIR_MAX_PRICE_USDC", async () => {
    const pricey = { ...paymentRequired, accepts: [{ ...paymentRequired.accepts[0], amount: "500000" }] };
    const { fn } = mockFetch(() => json(pricey, 402, { "PAYMENT-REQUIRED": b64(pricey) }));
    const { client, close } = await connect(fn, PAYER_KEY);
    const res = await client.callTool({ name: "screen_counterparty", arguments: { address: SUBJECT } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("exceeds maxPriceUsdc");
    expect(textOf(res)).toContain("COMPLIR_MAX_PRICE_USDC");
    await close();
  });

  it("get_attestation verifies the signature; 404 is reported, not thrown", async () => {
    const att = await signedAttestation();
    const stored = { address: SUBJECT, score: 37, tier: "MEDIUM", attestation: att, decisionId: "dec_1", screenedAt: "2026-10-13T00:00:00Z", source: "store" };
    const { fn } = mockFetch((url) => (url.endsWith(`/api/v1/attestation/${SUBJECT}`) ? json(stored) : json({ error: { code: "NOT_FOUND", message: "nope" } }, 404)));
    const { client, close } = await connect(fn);
    const found = JSON.parse(textOf(await client.callTool({ name: "get_attestation", arguments: { address: SUBJECT } })));
    expect(found).toMatchObject({ tier: "MEDIUM", decisionId: "dec_1", signatureValid: true, expired: false });
    const missing = await client.callTool({ name: "get_attestation", arguments: { address: "0x1111111111111111111111111111111111111111" } });
    expect(missing.isError).toBeFalsy();
    expect(JSON.parse(textOf(missing)).found).toBe(false);
    const resource = await client.readResource({ uri: `complir://attestation/${SUBJECT}` });
    expect(JSON.parse((resource.contents[0] as { text: string }).text).decisionId).toBe("dec_1");
    await close();
  });

  it("company_status falls back to numbers + health, network tolerates 404, API errors are surfaced", async () => {
    const { fn } = mockFetch((url) => {
      if (url.endsWith("/api/v1/company")) return new Response("not found", { status: 404 });
      if (url.endsWith("/api/v1/numbers")) return json({ screenings: 12, distinctClients: 3 });
      if (url.endsWith("/api/v1/health")) return json({ ok: true, chainId: 5042 });
      if (url.includes("/api/v1/network/")) return json({ error: { code: "NOT_FOUND", message: "no" } }, 404);
      if (url.includes("/api/v1/decision/")) return json({ error: { code: "NOT_FOUND", message: "No decision dec_x" } }, 404);
      if (url.includes("/api/v1/map/changes?limit=5")) return json({ items: [{ address: SUBJECT, from: "LOW", to: "HIGH", score: 80 }], limit: 5 });
      return json({ error: { code: "INTERNAL_ERROR", message: "unexpected " + url } }, 500);
    });
    const { client, close } = await connect(fn);
    const status = JSON.parse(textOf(await client.callTool({ name: "company_status", arguments: {} })));
    expect(status).toMatchObject({ source: "numbers", payer: null, baseUrl: "http://complir.test", numbers: { screenings: 12 }, health: { chainId: 5042 } });
    const net = JSON.parse(textOf(await client.callTool({ name: "get_network_signal", arguments: { address: SUBJECT } })));
    expect(net.available).toBe(false);
    const dec = await client.callTool({ name: "get_decision", arguments: { id: "dec_x" } });
    expect(dec.isError).toBe(true);
    expect(textOf(dec)).toBe("NOT_FOUND: No decision dec_x");
    const changes = JSON.parse(textOf(await client.callTool({ name: "list_recent_tier_changes", arguments: { limit: 5 } })));
    expect(changes.items[0].to).toBe("HIGH");
    await close();
  });

  it("reports an unreachable deployment clearly and validates input before calling", async () => {
    const { fn, calls } = mockFetch(() => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const { client, close } = await connect(fn);
    const down = await client.callTool({ name: "get_attestation", arguments: { address: SUBJECT } });
    expect(down.isError).toBe(true);
    expect(textOf(down)).toMatch(/UNREACHABLE: Cannot reach CompliR at http:\/\/complir\.test .*COMPLIR_URL/);
    const invalid = await client.callTool({ name: "screen_counterparty", arguments: { address: "not-an-address" } });
    expect(invalid.isError).toBe(true);
    expect(calls).toHaveLength(1);
    await close();
  });

  it("readEnv applies defaults and validates", () => {
    expect(readEnv({})).toEqual({ baseUrl: "http://localhost:3000", payerPrivateKey: undefined, maxPriceUsdc: 0.1 });
    expect(readEnv({ COMPLIR_URL: "https://complir.example/", COMPLIR_PAYER_PRIVATE_KEY: PAYER_KEY, COMPLIR_MAX_PRICE_USDC: "0.05" })).toEqual({ baseUrl: "https://complir.example", payerPrivateKey: PAYER_KEY, maxPriceUsdc: 0.05 });
    expect(() => readEnv({ COMPLIR_MAX_PRICE_USDC: "lots" })).toThrow(/COMPLIR_MAX_PRICE_USDC/);
    expect(() => new Api({ baseUrl: "http://x", maxPriceUsdc: 0.1, payerPrivateKey: "0x1234" })).toThrow(/COMPLIR_PAYER_PRIVATE_KEY/);
  });
});
