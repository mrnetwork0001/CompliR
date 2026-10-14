/**
 * @complir/mcp - MCP server exposing CompliR (counterparty risk oracle on Arc) as tools, resources and prompts.
 * Transport-agnostic: `createServer(api)` is connected to stdio or Streamable HTTP by `cli.ts`.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { verifyAttestation, type Attestation, type Verdict } from "../../sdk/src/index";
import { Api, ApiError } from "./api";
import { compactDecision, compactShadow, compactVerdict } from "./compact";

export const SERVER_NAME = "complir";
export const SERVER_VERSION = "0.1.0";

export const TOOL_NAMES = [
  "screen_counterparty",
  "watch_counterparty",
  "shadow_report",
  "get_attestation",
  "verify_attestation",
  "get_network_signal",
  "get_decision",
  "list_recent_tier_changes",
  "company_status",
] as const;

// ─── schemas ─────────────────────────────────────────────────────────────────
const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "0x-prefixed 20-byte EVM address").describe("EVM address: 0x + 40 hex characters");
const PayeeBookSchema = z
  .array(z.object({ label: z.string().min(1).max(80).describe("Payee display name"), address: AddressSchema }))
  .max(500)
  .describe("Your known payees (label + address). Enables lookalike / address-poisoning and payee-address-changed detection. Optional but strongly recommended.");
const AttestationSchema = z
  .object({
    typedData: z.object({
      domain: z.object({ name: z.string(), version: z.string(), chainId: z.number(), verifyingContract: z.string() }),
      types: z.object({ Attestation: z.array(z.object({ name: z.string(), type: z.string() })) }),
      primaryType: z.string(),
      message: z.object({ subject: z.string(), tier: z.number(), score: z.number(), decisionHash: z.string(), issuedAt: z.number(), validUntil: z.number() }),
    }),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    attester: AddressSchema,
    validUntil: z.number(),
    registryTx: z.string().nullable().optional(),
  })
  .describe("The `attestation` object exactly as returned by screen_counterparty / get_attestation");

// ─── helpers ─────────────────────────────────────────────────────────────────
function ok(data: unknown): CallToolResult {
  const structured = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { result: data };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: structured };
}
function fail(e: unknown): CallToolResult {
  const message = e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text", text: message }] };
}
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}
const TIER_FROM_ONCHAIN: Record<number, string> = { 1: "LOW", 2: "MEDIUM", 3: "HIGH" };

export const DOCS_TEXT = `# CompliR - counterparty risk oracle on Arc (MCP integration)

Before paying any address in USDC on Arc, call screen_counterparty. It returns a deterministic 0–100 risk score, a tier
(LOW 0–20 · MEDIUM 21–60 · HIGH 61–100), recommended per-transaction / per-day limits, reason codes with evidence, a
written rationale, a signed EIP-712 attestation (also written to the AttestationRegistry on Arc), and, for MEDIUM/HIGH,
an Enhanced Due Diligence (EDD) link you can forward to the counterparty.

Decision rule for a paying agent:
- HIGH   → do not pay. Report decisionId, reason codes and the EDD link to the human/counterparty.
- MEDIUM → pay at most min(amount, recommendedLimits.maxPerTxUsdc) and stay under maxPerDayUsdc; forward edd.url.
- LOW    → pay; still respect recommendedLimits.
Keep decisionId and attestation with your payment record: anyone can verify the signature offline (verify_attestation)
and replay the decision (get_decision). Re-screen after nextRescreenAt or register watch_counterparty for webhooks.

Pricing (x402, USDC on Arc, no API keys): screen 0.01 USDC, watch 0.05 USDC / 30 days. Everything else is free.
Paid tools need COMPLIR_PAYER_PRIVATE_KEY in the MCP server environment (a wallet holding USDC on Arc);
COMPLIR_MAX_PRICE_USDC (default 0.1) caps what the server will sign per call. COMPLIR_URL selects the deployment.

Tools: screen_counterparty, watch_counterparty, shadow_report, get_attestation, verify_attestation, get_network_signal,
get_decision, list_recent_tier_changes, company_status. Prompt: pay_safely. Resources: complir://docs,
complir://attestation/{address}.

Reason codes: SANCTIONS_DIRECT, USDC_BLACKLISTED, PROTOCOL_BLOCKLISTED, FUNDER_1HOP_SANCTIONED, FUNDER_2HOP_SANCTIONED,
FUNDER_1HOP_BLACKLISTED, FUNDER_2HOP_BLACKLISTED, FRESH_WALLET, LOOKALIKE_OF_KNOWN_PAYEE, PAYEE_ADDRESS_CHANGED,
HIGH_CONCENTRATION, PRIOR_HIGH_TIER, NO_HISTORY, CLEAN.
`;

// ─── server ──────────────────────────────────────────────────────────────────
export function createServer(api: Api): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "CompliR grades counterparties before you pay them USDC on Arc. Call screen_counterparty for every new payee (and any payee past nextRescreenAt), " +
        "never pay a HIGH tier, cap MEDIUM payments at recommendedLimits, forward edd.url when present, and keep decisionId + attestation with the payment record. " +
        "screen and watch are x402-paid (0.01 / 0.05 USDC) and require COMPLIR_PAYER_PRIVATE_KEY; the other tools are free.",
    },
  );

  // ── screen_counterparty (paid) ──
  server.registerTool(
    "screen_counterparty",
    {
      title: "Screen a counterparty before paying",
      description:
        "Grade an address you are about to pay USDC on Arc. Returns tier (LOW/MEDIUM/HIGH), score 0–100, recommendedLimits (maxPerTxUsdc, maxPerDayUsdc), reason codes with compact evidence, " +
        "rationale, a signed EIP-712 attestation, decisionId, and edd.url for MEDIUM/HIGH. Rule: HIGH → hold; MEDIUM → pay ≤ maxPerTxUsdc and forward edd.url; LOW → pay within limits. " +
        "Pass amountUsdc and your payeeBook for the best verdict. Costs 0.01 USDC via x402 (needs COMPLIR_PAYER_PRIVATE_KEY). Full funder graph is summarised to counts + top paths.",
      inputSchema: {
        address: AddressSchema.describe("The payee address you intend to pay"),
        name: z.string().min(2).max(200).optional().describe("Counterparty legal or display name (enables name-based sanctions matching)"),
        amountUsdc: z.number().nonnegative().optional().describe("Amount you intend to send, in USDC"),
        payeeBook: PayeeBookSchema.optional(),
        depth: z.union([z.literal(1), z.literal(2)]).optional().describe("Force funder-graph depth (1 or 2 hops). Default: the analyst decides."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const v = (await api.screen(args)) as Verdict;
        const out = compactVerdict(v);
        const receipt = api.lastPayment;
        if (receipt?.transaction) out.payment = { transaction: receipt.transaction, network: receipt.network, amount: receipt.amount };
        return out;
      }),
  );

  // ── watch_counterparty (paid) ──
  server.registerTool(
    "watch_counterparty",
    {
      title: "Watch a counterparty for tier changes",
      description:
        "Register an address + webhook URL with CompliR. For 30 days it is re-screened adaptively (HIGH hourly, MEDIUM daily, LOW weekly) and a `tier.changed` event (header X-CompliR-Event) " +
        "is POSTed to your webhook whenever the tier moves. Use after screening a payee you will keep paying. Costs 0.05 USDC via x402 (needs COMPLIR_PAYER_PRIVATE_KEY).",
      inputSchema: {
        address: AddressSchema.describe("Address to keep watching"),
        webhookUrl: z.string().url().describe("HTTPS endpoint that receives tier.changed events"),
        payeeBook: PayeeBookSchema.optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => run(() => api.watch(args)),
  );

  // ── shadow_report (free) ──
  server.registerTool(
    "shadow_report",
    {
      title: "Shadow report over a payee book",
      description:
        "Free retrospective: give your payee book (and optionally recent payments) and learn what CompliR would have held (HIGH), limited (MEDIUM), which payees look like address-poisoning lookalikes, " +
        "and which recent payments went to non-LOW recipients (paymentsAtRisk). Screens up to 50 unique addresses at depth 1. Good first step before wiring screen_counterparty into a payment flow.",
      inputSchema: {
        payeeBook: PayeeBookSchema,
        recentPayments: z
          .array(z.object({ to: AddressSchema, amountUsdc: z.number().nonnegative(), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional() }))
          .max(1000)
          .optional()
          .describe("Payments you already made; each is joined with the recipient's verdict"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(async () => compactShadow(await api.shadow(args))),
  );

  // ── get_attestation (free) ──
  server.registerTool(
    "get_attestation",
    {
      title: "Latest attestation for an address",
      description:
        "Free, always answers. Returns the CompliR verdict for an address: tier, score, reasons, recommendedLimits, rationale, eddRequested, edd, nextRescreenAt, decisionId and the signed EIP-712 attestation (validUntil, registryTx). " +
        "A never-seen address is screened on demand (source: \"fresh\", ~20-60 s); an expired verdict is returned with expired: true while CompliR re-screens it in the background. " +
        "The signature is verified offline before returning (signatureValid). Prefer this over screen_counterparty unless you need amount-aware limits or a payee-book lookalike check.",
      inputSchema: { address: AddressSchema },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ address }) =>
      run(async () => {
        const res = (await api.attestation(address)) as (Record<string, unknown> & { attestation?: Attestation }) | null;
        if (!res) return { address, found: false, note: "No attestation for this address on this deployment." };
        const att = res.attestation;
        const now = Math.floor(Date.now() / 1000);
        const signatureValid = att ? await verifyAttestation(att, { ignoreExpiry: true }) : false;
        return { ...res, signatureValid, expired: att ? att.validUntil <= now : null };
      }),
  );

  // ── verify_attestation (offline) ──
  server.registerTool(
    "verify_attestation",
    {
      title: "Verify an attestation offline",
      description:
        "Offline, no network: checks a CompliR attestation's EIP-712 domain, types, field ranges, expiry and signature. Returns valid:true/false with the decoded subject, tier, score and validUntil. " +
        "Use before trusting an attestation someone else forwarded to you, or to re-check a stored one at payment time. Pass expectedAttester (from company_status / /api/v1/health) to pin the signer.",
      inputSchema: {
        attestation: AttestationSchema,
        expectedAttester: AddressSchema.optional().describe("Pin the attester address (recommended)"),
        expectedChainId: z.number().int().optional().describe("Pin the EIP-712 domain chainId (Arc mainnet = 5042)"),
        ignoreExpiry: z.boolean().optional().describe("Verify the signature even if validUntil has passed"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ attestation, expectedAttester, expectedChainId, ignoreExpiry }) =>
      run(async () => {
        const att = attestation as unknown as Attestation;
        const now = Math.floor(Date.now() / 1000);
        const expired = att.validUntil <= now;
        const valid = await verifyAttestation(att, { expectedAttester: expectedAttester as `0x${string}` | undefined, expectedChainId, ignoreExpiry });
        const signatureValid = valid || (expired && !ignoreExpiry ? await verifyAttestation(att, { expectedAttester: expectedAttester as `0x${string}` | undefined, expectedChainId, ignoreExpiry: true }) : false);
        const m = att.typedData?.message;
        return {
          valid,
          signatureValid,
          expired,
          reason: valid ? null : expired && signatureValid ? "expired" : "invalid signature, domain, types or field ranges",
          subject: m?.subject ?? null,
          tier: m ? (TIER_FROM_ONCHAIN[m.tier] ?? null) : null,
          score: m?.score ?? null,
          decisionHash: m?.decisionHash ?? null,
          validUntil: att.validUntil,
          attester: att.attester,
          chainId: att.typedData?.domain?.chainId ?? null,
        };
      }),
  );

  // ── get_network_signal (free; endpoint may not exist yet) ──
  server.registerTool(
    "get_network_signal",
    {
      title: "Network signal for an address",
      description:
        "Free. Arc Trust Map view of one address: how it sits in the funder network (shared funders, neighbours' tiers, concentration). Complements screen_counterparty when you want context on who else " +
        "a payee is connected to. Returns available:false if this deployment does not expose the network endpoint.",
      inputSchema: { address: AddressSchema },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ address }) =>
      run(async () => {
        const res = await api.network(address);
        if (res === null) return { address, available: false, note: "GET /api/v1/network/:address is not available on this deployment (404)." };
        return { address, available: true, ...(res as Record<string, unknown>) };
      }),
  );

  // ── get_decision (free) ──
  server.registerTool(
    "get_decision",
    {
      title: "Replay a decision-log entry",
      description:
        "Free. Fetch one hash-chained decision-log entry by decisionId (dec_…): kind, subject, payload (the verdict, evidence summarised), prevHash/hash and the Merkle anchor tx on Arc. " +
        "Use to audit or prove why a payment was held/limited.",
      inputSchema: { id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).describe("decisionId, e.g. dec_01J…") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => run(async () => compactDecision(await api.decision(id))),
  );

  // ── list_recent_tier_changes (free) ──
  server.registerTool(
    "list_recent_tier_changes",
    {
      title: "Recent tier changes on the Arc Trust Map",
      description: "Free. Most recent tier changes observed by the Trust Map tailer on Arc mainnet (address, from → to, score, block, time). Use to spot payees whose risk recently moved.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Max items (default 25)") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) => run(() => api.mapChanges(limit ?? 25)),
  );

  // ── company_status (free) ──
  server.registerTool(
    "company_status",
    {
      title: "CompliR status and public numbers",
      description:
        "Free. Operational status of the CompliR deployment this server talks to: chain, attester / registry addresses, x402 prices and whether payments are enabled, plus public counters " +
        "(screenings, clients, watches). Falls back to /api/v1/numbers + /api/v1/health when /api/v1/company is unavailable. Also reports whether this MCP server has a payer wallet.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const company = await api.company();
        const base = { baseUrl: api.baseUrl, payer: api.payerAddress ? { address: api.payerAddress, maxPriceUsdc: api.maxPriceUsdc } : null };
        if (company !== null) return { ...base, source: "company", ...(company as Record<string, unknown>) };
        const [numbers, health] = await Promise.all([api.numbers(), api.health().catch(() => null)]);
        return { ...base, source: "numbers", numbers, health };
      }),
  );

  // ── resources ──
  server.registerResource("docs", "complir://docs", { title: "CompliR integration notes", description: "How an agent should use CompliR before paying", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: DOCS_TEXT }],
  }));
  server.registerResource(
    "attestation",
    new ResourceTemplate("complir://attestation/{address}", { list: undefined }),
    { title: "Latest attestation for an address", description: "JSON: tier, score, decisionId, signed EIP-712 attestation", mimeType: "application/json" },
    async (uri, { address }) => {
      const addr = String(address);
      const res = await api.attestation(addr);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(res ?? { address: addr, found: false }) }] };
    },
  );

  // ── prompt ──
  server.registerPrompt(
    "pay_safely",
    {
      title: "Pay a counterparty safely",
      description: "Step-by-step instructions for an agent about to pay an address: screen first, respect limits, forward EDD, store the attestation.",
      argsSchema: {
        address: z.string().describe("Payee address"),
        amountUsdc: z.string().optional().describe("Amount in USDC you intend to send"),
        name: z.string().optional().describe("Counterparty name, if known"),
      },
    },
    ({ address, amountUsdc, name }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `You are about to pay ${amountUsdc ? `${amountUsdc} USDC` : "USDC"} to ${address}${name ? ` (${name})` : ""} on Arc. Follow this procedure exactly:\n\n` +
              `1. Call screen_counterparty with address=${address}${amountUsdc ? `, amountUsdc=${amountUsdc}` : ""}${name ? `, name="${name}"` : ""} and your payee book if you have one. ` +
              `If the tool reports PAYMENT_REQUIRED, stop and tell the operator to set COMPLIR_PAYER_PRIVATE_KEY; do not pay unscreened.\n` +
              `2. Decide from the verdict:\n` +
              `   - tier HIGH: do NOT pay. Report decisionId, score, reasons[].code and rationale to the human.\n` +
              `   - tier MEDIUM: pay at most min(amount, recommendedLimits.maxPerTxUsdc) and keep today's total to this payee under recommendedLimits.maxPerDayUsdc. ` +
              `Forward edd.url (the Enhanced Due Diligence link) and eddRequested questions to the counterparty; hold the remainder until they answer.\n` +
              `   - tier LOW: pay, still within recommendedLimits.\n` +
              `3. Before sending, call verify_attestation on the returned attestation (pin expectedAttester to the deployment's attester from company_status). Refuse if valid=false.\n` +
              `4. Store decisionId, attestation (typedData + signature), registryTx and screenedAt alongside the payment record so the decision can be audited with get_decision.\n` +
              `5. If you will pay this address again, call watch_counterparty with your webhook so tier changes reach you; otherwise re-screen after nextRescreenAt.\n` +
              `Report back: tier, score, the amount you will send (or that you are holding), and the decisionId.`,
          },
        },
      ],
    }),
  );

  return server;
}
