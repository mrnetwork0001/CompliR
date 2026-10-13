/**
 * Provider parity: the analyst and the operator must produce the SAME guarded output whether the structured object
 * comes from Anthropic (mock SDK client) or from the 0G router (mock fetch, Anthropic-messages and OpenAI formats),
 * and the same fallback when either provider fails.
 */
import "../__tests__/setup";
import { describe, it, expect, vi } from "vitest";
import { analyze, type AnalyzeInput } from "../analyst/analyze";
import { decideOperations, candidateActions } from "../operator/decide";
import { NOW, snap } from "../operator/fixtures";
import { anthropicProvider } from "./anthropic";
import { zeroGProvider } from "./zerog";
import type { EvidenceBundle, Reason, ScreenRequest } from "../types";
import type { LlmProvider } from "./provider";

const SUBJECT = "0x00000000000000000000000000000000000c0ffe" as const;
const FUNDER = "0x000000000000000000000000000000000000f00d" as const;
const TX = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const req: ScreenRequest = { address: SUBJECT, amountUsdc: 250, clientId: "c1" };
const bundle: EvidenceBundle = {
  subject: { address: SUBJECT, firstSeen: NOW - 2 * 86400, txCount: 3, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] },
  funders: [{ hop: 1, path: [{ from: FUNDER, to: SUBJECT, txHash: TX, amountUsdc: "250.000000", timestamp: NOW - 86400 }], facts: { address: FUNDER, firstSeen: NOW - 86400, txCount: 1, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] } }],
  lookalikes: [], payeeChanged: null, concentration: null, priorTier: null, collectedAt: NOW, depth: 1,
};
const reasons: Reason[] = [{ code: "FRESH_WALLET" as Reason["code"], weight: 25, evidence: { firstSeen: NOW - 2 * 86400 } }];
const input: AnalyzeInput = { req, bundle, score: 25, tier: "MEDIUM", reasons, priorTier: null, now: NOW };

/** a deliberately out-of-band model answer: every guard has to fire identically on both paths */
const analystAnswer = {
  recommendedLimits: { maxPerTxUsdc: 999_999, maxPerDayUsdc: 999_999 },
  rationale: "Fresh wallet funded by " + FUNDER + " in " + TX + "; also invented hash 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef should be stripped. " + "word ".repeat(150),
  eddRequested: ["Who controls " + FUNDER + " and what was the " + TX + " transfer for?"],
  nextRescreenInSeconds: 1, requestDepth: null, confidence: 7,
};

function anthropicMock(answer: unknown, fail?: string): LlmProvider {
  const create = vi.fn(async () => { if (fail) throw new Error(fail); return { content: [{ type: "tool_use", id: "t", name: "x", input: answer }] }; });
  return anthropicProvider({ model: "claude-test", client: { messages: { create } } as never });
}
function zeroGMock(answer: unknown, format: "anthropic" | "openai", fail?: { status: number; code: string }): LlmProvider {
  const f = vi.fn(async () => {
    if (fail) return new Response(JSON.stringify({ error: { message: "m", type: "t", code: fail.code } }), { status: fail.status });
    const body = format === "anthropic"
      ? { content: [{ type: "tool_use", id: "t", name: "x", input: answer }] }
      : { choices: [{ message: { role: "assistant", tool_calls: [{ function: { name: "x", arguments: JSON.stringify(answer) } }] } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return zeroGProvider({ apiKey: "sk-test", model: format === "anthropic" ? "claude-sonnet-5" : "glm-5.3", fetchImpl: f });
}
const strip = <T extends { meta: { latencyMs: number; model: string } }>(r: T) => ({ ...r, meta: { ...r.meta, latencyMs: 0, model: "" } });

describe("provider parity - Risk Analyst", () => {
  it("identical guarded decision through anthropic, 0g/anthropic-format and 0g/openai-format", async () => {
    const a = await analyze(input, anthropicMock(analystAnswer));
    const z1 = await analyze(input, zeroGMock(analystAnswer, "anthropic"));
    const z2 = await analyze(input, zeroGMock(analystAnswer, "openai"));
    expect(a.meta).toMatchObject({ model: "anthropic:claude-test", fallback: false });
    expect(z1.meta).toMatchObject({ model: "0g:claude-sonnet-5", fallback: false });
    expect(z2.meta).toMatchObject({ model: "0g:glm-5.3", fallback: false });
    expect(strip(z1)).toEqual(strip(a));
    expect(strip(z2)).toEqual(strip(a));
    // and the guards really did their job on both
    expect(a.guardTriggered).toBe(true);
    expect(a.decision.recommendedLimits.maxPerTxUsdc).toBeLessThan(999_999);
    expect(a.decision.rationale).not.toContain("0xdeadbeef");
    expect(a.decision.rationale).toContain(TX);
    expect(a.confidence).toBeLessThanOrEqual(1);
  });
  it("identical deterministic fallback when either provider fails (meta.error differs, decision does not)", async () => {
    const a = await analyze(input, anthropicMock(null, "overloaded"));
    const z = await analyze(input, zeroGMock(null, "anthropic", { status: 402, code: "insufficient_balance" }));
    const none = await analyze(input, null);
    expect(a.meta).toMatchObject({ model: "anthropic:claude-test", fallback: true, error: "overloaded" });
    expect(z.meta).toMatchObject({ model: "0g:claude-sonnet-5", fallback: true, error: "0g 402 insufficient_balance: m" });
    expect(none.meta).toMatchObject({ model: "fallback", fallback: true });
    const d = (r: Awaited<ReturnType<typeof analyze>>) => ({ decision: r.decision, confidence: r.confidence, guardNotes: r.guardNotes });
    expect(d(z)).toEqual(d(a));
    expect(d(none)).toEqual(d(a));
  });
});

describe("provider parity - Operator", () => {
  const s = snap();
  const { candidates } = candidateActions(s, { now: NOW });
  const payouts = candidates.find((c) => c.type === "RUN_PAYOUTS")!;
  const planAnswer = { actionIds: [payouts.id, "c99", "WITHDRAW_ALL"], rationale: "Pay the pending invoices; drain nothing. " + "x ".repeat(200), nextCheckInSeconds: 5 };
  it("identical guarded plan through every provider", async () => {
    const a = await decideOperations(s, { now: NOW, client: anthropicMock(planAnswer) });
    const z1 = await decideOperations(s, { now: NOW, client: zeroGMock(planAnswer, "anthropic") });
    const z2 = await decideOperations(s, { now: NOW, client: zeroGMock(planAnswer, "openai") });
    expect(a.meta.model).toBe("anthropic:claude-test");
    expect(z1.meta.model).toBe("0g:claude-sonnet-5");
    expect(z2.meta.model).toBe("0g:glm-5.3");
    expect(strip(z1)).toEqual(strip(a));
    expect(strip(z2)).toEqual(strip(a));
    expect(a.chosen.map((c) => c.type)).toEqual(["RUN_PAYOUTS"]);
    expect(a.nextCheckInSeconds).toBe(900);
    expect(a.meta.guardNotes.join(" ")).toMatch(/dropped unlisted action id "c99"/);
    expect(a.rationale.endsWith("[...]")).toBe(true);
  });
  it("identical deterministic plan when either provider fails", async () => {
    const a = await decideOperations(s, { now: NOW, client: anthropicMock(null, "rate limited") });
    const z = await decideOperations(s, { now: NOW, client: zeroGMock(null, "openai", { status: 503, code: "no_available_provider" }) });
    expect(a.meta).toMatchObject({ fallback: true, error: "rate limited" });
    expect(z.meta).toMatchObject({ fallback: true, error: "0g 503 no_available_provider: m" });
    const d = (p: Awaited<ReturnType<typeof decideOperations>>) => ({ chosen: p.chosen, rationale: p.rationale, nextCheckInSeconds: p.nextCheckInSeconds });
    expect(d(z)).toEqual(d(a));
  });
  it("env-selected provider: LLM_PROVIDER=0g with a key routes the operator to the router", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "tool_use", id: "t", name: "submit_plan", input: { actionIds: [payouts.id], rationale: "ok", nextCheckInSeconds: 1800 } }] }), { status: 200 }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = f as unknown as typeof fetch;
    process.env.LLM_PROVIDER = "0g"; process.env.ZEROG_API_KEY = "sk-test";
    try {
      const p = await decideOperations(s, { now: NOW });
      expect(p.meta).toMatchObject({ model: "0g:claude-sonnet-5", fallback: false });
      expect(p.chosen.map((c) => c.type)).toEqual(["RUN_PAYOUTS"]);
      expect(f).toHaveBeenCalledTimes(1);
      expect(String((f.mock.calls[0] as unknown[])[0])).toBe("https://router-api.0g.ai/v1/messages");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.LLM_PROVIDER; delete process.env.ZEROG_API_KEY;
    }
  });
});
