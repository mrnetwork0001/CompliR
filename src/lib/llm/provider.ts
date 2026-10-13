/**
 * LLM provider seam. The Risk Analyst (src/lib/analyst) and the Operator (src/lib/operator) ask a provider for ONE
 * structured object (a forced tool call against a JSON schema); everything else - prompts, zod parsing, guards,
 * deterministic fallback - stays in the caller and is identical whichever provider answers.
 *
 *   anthropic  - api.anthropic.com through @anthropic-ai/sdk (the original path; ANTHROPIC_API_KEY)
 *   0g         - 0G Compute Router, https://router-api.0g.ai (ZEROG_API_KEY, `sk-…` from pc.0g.ai). Claude models
 *                are served there over the Anthropic Messages format (/v1/messages); open-weight models over
 *                OpenAI chat completions (/v1/chat/completions). See docs/LLM_PROVIDERS.md.
 *   none       - no model; callers use their deterministic fallback (meta.fallback = true), exactly as before.
 */
import { anthropicProvider } from "./anthropic";
import { zeroGProvider, ZEROG_DEFAULT_BASE_URL, ZEROG_DEFAULT_MODEL, type ZeroGFormat } from "./zerog";

/** Subset of JSON Schema the two call sites use (the tool `input_schema`). */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [k: string]: unknown;
}

export interface StructuredArgs {
  system: string;
  user: string;
  schema: JsonSchema;
  /** tool / function name the model is forced to call (submit_decision, submit_plan) */
  toolName: string;
  toolDescription?: string;
  maxTokens?: number;
  temperature?: number;
  /** per-call budget; providers also carry a default */
  timeoutMs?: number;
}

export interface StructuredResult {
  /** the tool input as the model produced it - NOT validated; callers zod-parse and guard it */
  data: unknown;
  /** provider response for the decision log / debugging */
  raw?: unknown;
  latencyMs: number;
}

export interface LlmProvider {
  /** "anthropic" | "0g" | … - prefixed onto meta.model as `${name}:${model}` */
  readonly name: string;
  readonly model: string;
  structured(args: StructuredArgs): Promise<StructuredResult>;
}

export type ProviderName = "anthropic" | "0g" | "none";

export interface ProviderSelection {
  name: ProviderName;
  /** null when name === "none" */
  provider: LlmProvider | null;
  model: string;
  /** why this provider was chosen (for status pages / logs) */
  reason: string;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
export const DEFAULT_TIMEOUT_MS = 8_000;
/** Relayed Claude providers on the 0G router report 4–11 s latency, so the 0G default is wider than Anthropic's. */
export const ZEROG_DEFAULT_TIMEOUT_MS = 30_000;

export function isLlmProvider(x: unknown): x is LlmProvider {
  return !!x && typeof x === "object" && typeof (x as LlmProvider).structured === "function" && typeof (x as LlmProvider).name === "string";
}

/** `${provider}:${model}` - what goes into meta.model so the decision log says who answered. */
export function modelLabel(p: LlmProvider): string {
  return `${p.name}:${p.model}`;
}

type Env = Record<string, string | undefined>;
const val = (env: Env, k: string): string | undefined => {
  const v = env[k]?.trim();
  return v ? v : undefined;
};
const num = (env: Env, k: string): number | undefined => {
  const v = Number(val(env, k));
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

/** Model precedence: LLM_MODEL › (0g only: ZEROG_MODEL) › ANALYST_MODEL › provider default. */
export function resolveModel(name: Exclude<ProviderName, "none">, env: Env = process.env): string {
  const explicit = val(env, "LLM_MODEL") ?? (name === "0g" ? val(env, "ZEROG_MODEL") : undefined) ?? val(env, "ANALYST_MODEL");
  if (explicit) return explicit;
  return name === "0g" ? ZEROG_DEFAULT_MODEL : DEFAULT_ANTHROPIC_MODEL;
}

/**
 * Pick the provider from the environment.
 *   LLM_PROVIDER=anthropic | 0g | none   (explicit)
 *   unset → anthropic if ANTHROPIC_API_KEY, else 0g if ZEROG_API_KEY, else none.
 * An explicit choice whose key is missing resolves to "none" (deterministic fallback) and says why - never throws.
 */
export function selectProvider(env: Env = process.env): ProviderSelection {
  const want = (val(env, "LLM_PROVIDER") ?? "").toLowerCase();
  const anthropicKey = val(env, "ANTHROPIC_API_KEY");
  const zeroGKey = val(env, "ZEROG_API_KEY");
  const timeout = num(env, "LLM_TIMEOUT_MS");

  const none = (reason: string): ProviderSelection => ({ name: "none", provider: null, model: "fallback", reason });
  const anthropic = (reason: string): ProviderSelection => {
    const model = resolveModel("anthropic", env);
    return { name: "anthropic", model, reason, provider: anthropicProvider({ apiKey: anthropicKey!, model, timeoutMs: timeout ?? DEFAULT_TIMEOUT_MS }) };
  };
  const zeroG = (reason: string): ProviderSelection => {
    const model = resolveModel("0g", env);
    const fmt = (val(env, "ZEROG_FORMAT") ?? "auto").toLowerCase();
    const format: ZeroGFormat = fmt === "anthropic" || fmt === "openai" ? fmt : "auto";
    return {
      name: "0g", model, reason,
      provider: zeroGProvider({ apiKey: zeroGKey!, model, baseUrl: val(env, "ZEROG_BASE_URL") ?? ZEROG_DEFAULT_BASE_URL, format, timeoutMs: timeout ?? ZEROG_DEFAULT_TIMEOUT_MS }),
    };
  };

  switch (want) {
    case "none":
    case "off":
    case "fallback":
      return none("LLM_PROVIDER=none");
    case "anthropic":
      return anthropicKey ? anthropic("LLM_PROVIDER=anthropic") : none("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
    case "0g":
    case "zerog":
    case "0g-compute":
      return zeroGKey ? zeroG("LLM_PROVIDER=0g") : none("LLM_PROVIDER=0g but ZEROG_API_KEY is not set");
    case "":
      if (anthropicKey) return anthropic("ANTHROPIC_API_KEY set (default)");
      if (zeroGKey) return zeroG("ZEROG_API_KEY set, no ANTHROPIC_API_KEY");
      return none("no ANTHROPIC_API_KEY / ZEROG_API_KEY");
    default:
      return none(`unknown LLM_PROVIDER "${want}" (use anthropic | 0g | none)`);
  }
}
