import { resolveProvider, type AnalystModel } from "./client";
import { modelLabel } from "../llm";
import { ANALYST_SYSTEM_PROMPT, buildAnalystUserMessage } from "./prompts";
import { AnalystOutputSchema, type AnalystOutput } from "./schema";
import { applyGuards, TIER_LIMIT_BANDS, defaultRescreenSeconds, tierChanged, type GuardedDecision } from "./guards";
import type { EvidenceBundle, Reason, ScreenRequest, Tier } from "../types";

export interface AnalyzeInput {
  req: ScreenRequest; bundle: EvidenceBundle; score: number; tier: Tier; reasons: Reason[]; priorTier?: Tier | null; now?: number;
}
export interface AnalyzeResult extends GuardedDecision {
  meta: { model: string; fallback: boolean; latencyMs: number; error?: string };
}

/** Deterministic fallback used when no API key / model failure. Still cites the top reasons. */
export function fallbackOutput(input: AnalyzeInput, now: number): AnalystOutput {
  const top = input.reasons.filter((r) => r.code !== "CLEAN").slice(0, 3);
  const cites = top.map((r) => {
    const ev = r.evidence as Record<string, unknown>;
    const ref = (ev.path as string[] | undefined)?.at(-1) ?? (ev.txs as string[] | undefined)?.[0] ?? (ev.entityId as string | undefined) ?? "";
    return `${r.code.toLowerCase().replace(/_/g, " ")} (+${r.weight}${ref ? `, ${ref}` : ""})`;
  });
  const rationale = top.length
    ? `Score ${input.score} → ${input.tier}. Driven by: ${cites.join("; ")}. Limits set to the ${input.tier} band default.`
    : `Score ${input.score} → ${input.tier}. No risk signals in sanctions, USDC blacklist, 2-hop funder graph, or payee book. Full ${input.tier} band limits apply.`;
  const edd = input.tier === "LOW" ? [] : top.slice(0, 2).map((r) => {
    const ev = r.evidence as Record<string, unknown>;
    const who = (ev.path as string[] | undefined)?.at(-1) ?? input.req.address;
    return `Please confirm the relationship with ${who} and the source of funds behind it (${r.code}).`;
  });
  return {
    recommendedLimits: { ...TIER_LIMIT_BANDS[input.tier] },
    rationale, eddRequested: edd,
    nextRescreenInSeconds: defaultRescreenSeconds(input.tier, tierChanged({ tier: input.tier, priorTier: input.priorTier, bundle: input.bundle })),
    requestDepth: null, confidence: 0.5,
  };
}

const TOOL = {
  name: "submit_decision",
  description: "Submit the Risk Analyst decision. Score and tier are fixed inputs and cannot be changed.",
  input_schema: {
    type: "object" as const,
    properties: {
      recommendedLimits: { type: "object", properties: { maxPerTxUsdc: { type: "number" }, maxPerDayUsdc: { type: "number" } }, required: ["maxPerTxUsdc", "maxPerDayUsdc"] },
      rationale: { type: "string" },
      eddRequested: { type: "array", items: { type: "string" } },
      nextRescreenInSeconds: { type: "number" },
      requestDepth: { type: ["integer", "null"], enum: [2, null] },
      confidence: { type: "number" },
    },
    required: ["recommendedLimits", "rationale", "eddRequested", "nextRescreenInSeconds", "requestDepth", "confidence"],
  },
};

/**
 * Model step. `client` may be undefined (provider from env: LLM_PROVIDER / ANTHROPIC_API_KEY / ZEROG_API_KEY),
 * null (deterministic fallback), an LlmProvider, or a mock Anthropic client (tests). The prompt, the forced tool
 * schema, zod parsing and the guards are the same whichever provider answers; any failure → fallback with meta.error.
 */
export async function analyze(input: AnalyzeInput, client?: AnalystModel | null): Promise<AnalyzeResult> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const t0 = Date.now();
  const ctx = { req: input.req, bundle: input.bundle, tier: input.tier, reasons: input.reasons, priorTier: input.priorTier, now };
  const provider = resolveProvider(client);
  if (!provider) {
    return { ...applyGuards(ctx, fallbackOutput(input, now)), meta: { model: "fallback", fallback: true, latencyMs: Date.now() - t0 } };
  }
  const model = modelLabel(provider);
  try {
    const res = await provider.structured({
      system: ANALYST_SYSTEM_PROMPT,
      user: buildAnalystUserMessage({ ...input, now }),
      schema: TOOL.input_schema, toolName: TOOL.name, toolDescription: TOOL.description,
      maxTokens: 800, temperature: 0.2,
    });
    const parsed = AnalystOutputSchema.parse(res.data);
    return { ...applyGuards(ctx, parsed), meta: { model, fallback: false, latencyMs: Date.now() - t0 } };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ...applyGuards(ctx, fallbackOutput(input, now)), meta: { model, fallback: true, latencyMs: Date.now() - t0, error: err } };
  }
}
