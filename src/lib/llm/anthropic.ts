/**
 * Anthropic provider: the original forced-tool-use call, byte-for-byte the request the analyst and operator sent
 * before the provider seam existed (system + one user message, tools=[schema], tool_choice={type:"tool"}).
 * Tests inject a mock `client` of shape Pick<Anthropic, "messages">.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, StructuredArgs, StructuredResult } from "./provider";

export type AnthropicLikeClient = Pick<Anthropic, "messages">;

export interface AnthropicProviderOptions {
  model: string;
  apiKey?: string;
  /** injected client (tests) — wins over apiKey */
  client?: AnthropicLikeClient;
  timeoutMs?: number;
  maxRetries?: number;
  /** override the API host (e.g. an Anthropic-compatible gateway); default api.anthropic.com */
  baseURL?: string;
  /** reported as provider name; default "anthropic" */
  name?: string;
}

export const ANTHROPIC_DEFAULT_TIMEOUT_MS = 8_000;
export const ANTHROPIC_DEFAULT_MAX_RETRIES = 1;

export function anthropicProvider(opts: AnthropicProviderOptions): LlmProvider {
  if (!opts.client && !opts.apiKey) throw new Error("anthropicProvider: apiKey or client required");
  let cached: AnthropicLikeClient | null = opts.client ?? null;
  const client = (): AnthropicLikeClient => {
    if (!cached) {
      cached = new Anthropic({
        apiKey: opts.apiKey, baseURL: opts.baseURL,
        timeout: opts.timeoutMs ?? ANTHROPIC_DEFAULT_TIMEOUT_MS,
        maxRetries: opts.maxRetries ?? ANTHROPIC_DEFAULT_MAX_RETRIES,
      });
    }
    return cached;
  };
  return {
    name: opts.name ?? "anthropic",
    model: opts.model,
    async structured(args: StructuredArgs): Promise<StructuredResult> {
      const t0 = Date.now();
      const res = await client().messages.create({
        model: opts.model,
        max_tokens: args.maxTokens ?? 800,
        temperature: args.temperature ?? 0.2,
        system: args.system,
        tools: [{ name: args.toolName, description: args.toolDescription ?? "", input_schema: args.schema as Anthropic.Tool["input_schema"] }],
        tool_choice: { type: "tool", name: args.toolName },
        messages: [{ role: "user", content: args.user }],
      });
      const block = res.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use") throw new Error("no tool_use block");
      return { data: block.input, raw: res, latencyMs: Date.now() - t0 };
    },
  };
}
