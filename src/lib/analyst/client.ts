/**
 * Model access for the analyst and the operator. Since the provider seam (src/lib/llm) the model is chosen from the
 * environment — LLM_PROVIDER=anthropic | 0g | none (see docs/LLM_PROVIDERS.md) — and both callers only ever call
 * `provider.structured(...)`. Config is read defensively: config() validates the whole environment (Arc RPC etc.) and
 * throws when incomplete; the analyst must never throw, so we fall back to raw env for the keys we need.
 *
 * `AnalystClient` (Pick<Anthropic, "messages">) is kept so existing tests can keep injecting a mock Anthropic client;
 * `resolveProvider()` wraps such a client in the anthropic provider.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { anthropicProvider, isLlmProvider, resolveModel, selectProvider, type LlmProvider } from "../llm";

export const DEFAULT_ANALYST_MODEL = "claude-sonnet-5-5";
export const ANALYST_TIMEOUT_MS = 8_000;
export const ANALYST_MAX_RETRIES = 1;

/** The slice of the Anthropic SDK the analyst used directly; tests inject a mock of this shape. */
export type AnalystClient = Pick<Anthropic, "messages">;
/** What callers may inject: a raw Anthropic-shaped client, a provider, or null (= deterministic fallback). */
export type AnalystModel = AnalystClient | LlmProvider;

export interface AnalystConfig {
  apiKey: string | undefined;
  /** model for the anthropic path: LLM_MODEL › ANALYST_MODEL › default */
  model: string;
}

export function analystConfig(): AnalystConfig {
  let apiKey: string | undefined;
  try {
    apiKey = config().ANTHROPIC_API_KEY;
  } catch {
    apiKey = process.env.ANTHROPIC_API_KEY || undefined;
  }
  return { apiKey, model: resolveModel("anthropic") };
}

export function createAnalystClient(apiKey: string): AnalystClient {
  return new Anthropic({ apiKey, timeout: ANALYST_TIMEOUT_MS, maxRetries: ANALYST_MAX_RETRIES });
}

/**
 * undefined → provider from env (selectProvider); null → no model (fallback);
 * an LlmProvider → as is; an Anthropic-shaped client → wrapped in the anthropic provider with the configured model.
 */
export function resolveProvider(client?: AnalystModel | null): LlmProvider | null {
  if (client === null) return null;
  if (client === undefined) return selectProvider().provider;
  if (isLlmProvider(client)) return client;
  return anthropicProvider({ client, model: analystConfig().model, timeoutMs: ANALYST_TIMEOUT_MS, maxRetries: ANALYST_MAX_RETRIES });
}
