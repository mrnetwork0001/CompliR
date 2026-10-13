/**
 * 0G Compute Router provider (https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview).
 *
 * Plain `fetch`, no SDK: the Router is a hosted gateway that takes an `sk-…` API key (created at pc.0g.ai after a
 * wallet deposit of 0G tokens) and bills the unified on-chain balance per token. No wallet signing happens here.
 *
 *   format "anthropic" → POST {base}/v1/messages          (Anthropic Messages shape; the only format the claude-* models
 *                                                           on the Router advertise: supported_formats: ["anthropic"])
 *   format "openai"    → POST {base}/v1/chat/completions   (OpenAI shape; open-weight models - glm-*, qwen*, deepseek-*)
 *   format "auto"      → "anthropic" for claude-* model ids, "openai" otherwise
 *
 * Both paths force one tool call against the caller's JSON schema and return its arguments. If the model answers in
 * prose / malformed JSON instead, ONE repair turn asks for "only JSON matching the schema"; a second miss throws.
 * zod validation stays with the caller. 429 (honouring Retry-After, capped) and 502 are retried once; 400/401/402/403/
 * 503 are not (see router/errors). Every failure is a ZeroGError with status / code / request id for the decision log.
 */
import type { JsonSchema, LlmProvider, StructuredArgs, StructuredResult } from "./provider";

export const ZEROG_DEFAULT_BASE_URL = "https://router-api.0g.ai";
/** Cheapest Claude on the Router with live providers on 2026-10-13 ($1.90 / $9.50 per M tokens, 2 providers). */
export const ZEROG_DEFAULT_MODEL = "claude-sonnet-5";
export const ZEROG_ANTHROPIC_VERSION = "2023-06-01";
export const ZEROG_RETRY_AFTER_CAP_MS = 5_000;

export type ZeroGFormat = "anthropic" | "openai" | "auto";

export interface ZeroGProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  format?: ZeroGFormat;
  timeoutMs?: number;
  /** retries for 429 / 502 / network errors (default 1) */
  maxRetries?: number;
  /** injected for tests */
  fetchImpl?: typeof fetch;
  /** injected for tests (default: real sleep) */
  sleep?: (ms: number) => Promise<void>;
}

export class ZeroGError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  constructor(message: string, info: { status?: number; code?: string; requestId?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = "ZeroGError";
    this.status = info.status;
    this.code = info.code;
    this.requestId = info.requestId;
    this.retryable = info.retryable ?? false;
  }
}

export function resolveZeroGFormat(model: string, format: ZeroGFormat = "auto"): Exclude<ZeroGFormat, "auto"> {
  if (format !== "auto") return format;
  return /^claude[-_]/i.test(model) ? "anthropic" : "openai";
}

// ─── response parsing ────────────────────────────────────────────────────────
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Strip ``` fences, then take the outermost {...}. Returns undefined when nothing parses to an object. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const t = text.replace(/```(?:json)?/gi, "").trim();
  const candidates = [t];
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) candidates.push(t.slice(a, b + 1));
  for (const c of candidates) {
    try { const v = JSON.parse(c); if (isObj(v)) return v; } catch { /* try next */ }
  }
  return undefined;
}

interface Extracted { data?: Record<string, unknown>; text: string }

/** Anthropic Messages response → forced tool input, else the text blocks. */
export function extractAnthropic(res: unknown, toolName: string): Extracted {
  const content = isObj(res) && Array.isArray(res.content) ? (res.content as unknown[]) : [];
  const tool = content.find((b) => isObj(b) && b.type === "tool_use" && (b.name === toolName || !b.name)) ?? content.find((b) => isObj(b) && b.type === "tool_use");
  if (isObj(tool) && isObj(tool.input)) return { data: tool.input, text: "" };
  const text = content.filter((b): b is Record<string, unknown> => isObj(b) && b.type === "text").map((b) => String(b.text ?? "")).join("\n");
  return { data: extractJsonObject(text), text };
}

/** OpenAI chat completion → forced tool_call arguments, else message content. */
export function extractOpenAI(res: unknown, toolName: string): Extracted {
  const choice = isObj(res) && Array.isArray(res.choices) ? (res.choices[0] as unknown) : undefined;
  const msg = isObj(choice) && isObj(choice.message) ? choice.message : undefined;
  const calls = msg && Array.isArray(msg.tool_calls) ? (msg.tool_calls as unknown[]) : [];
  const call = calls.find((c) => isObj(c) && isObj(c.function) && c.function.name === toolName) ?? calls[0];
  if (isObj(call) && isObj(call.function)) {
    const args = call.function.arguments;
    if (isObj(args)) return { data: args, text: "" };
    if (typeof args === "string") { const parsed = extractJsonObject(args); if (parsed) return { data: parsed, text: args }; return { text: args }; }
  }
  const text = typeof msg?.content === "string" ? msg.content : Array.isArray(msg?.content) ? (msg!.content as unknown[]).map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("\n") : "";
  return { data: extractJsonObject(text), text };
}

// ─── request bodies ──────────────────────────────────────────────────────────
type Turn = { role: "assistant" | "user"; content: string };

function repairInstruction(args: StructuredArgs): string {
  return `Your previous reply was not a valid ${args.toolName} call. Call the ${args.toolName} tool, or return ONLY a JSON object matching this schema - no prose, no code fences:\n${JSON.stringify(args.schema)}`;
}

function anthropicBody(model: string, args: StructuredArgs, extra: Turn[]): Record<string, unknown> {
  return {
    model,
    max_tokens: args.maxTokens ?? 800,
    temperature: args.temperature ?? 0.2,
    system: args.system,
    tools: [{ name: args.toolName, description: args.toolDescription ?? "", input_schema: args.schema }],
    tool_choice: { type: "tool", name: args.toolName },
    messages: [{ role: "user", content: args.user }, ...extra],
  };
}

function openAIBody(model: string, args: StructuredArgs, extra: Turn[]): Record<string, unknown> {
  return {
    model,
    max_tokens: args.maxTokens ?? 800,
    temperature: args.temperature ?? 0.2,
    messages: [{ role: "system", content: args.system }, { role: "user", content: args.user }, ...extra],
    tools: [{ type: "function", function: { name: args.toolName, description: args.toolDescription ?? "", parameters: args.schema as JsonSchema } }],
    tool_choice: { type: "function", function: { name: args.toolName } },
  };
}

// ─── transport ───────────────────────────────────────────────────────────────
function errorFromBody(status: number, body: unknown, requestIdHeader: string | null): ZeroGError {
  const err = isObj(body) && isObj(body.error) ? body.error : undefined;
  const code = typeof err?.code === "string" ? err.code : undefined;
  const message = typeof err?.message === "string" ? err.message : typeof body === "string" ? body.slice(0, 200) : `HTTP ${status}`;
  const requestId = (isObj(body) && typeof body.request_id === "string" ? body.request_id : undefined) ?? requestIdHeader ?? undefined;
  const retryable = status === 429 || status === 502 || status >= 500 && status !== 503;
  return new ZeroGError(`0g ${status}${code ? ` ${code}` : ""}: ${message}${requestId ? ` (request ${requestId})` : ""}`, { status, code, requestId, retryable });
}

export function zeroGProvider(opts: ZeroGProviderOptions): LlmProvider {
  if (!opts.apiKey) throw new Error("zeroGProvider: apiKey required (ZEROG_API_KEY, an sk-… key from pc.0g.ai)");
  const base = (opts.baseUrl ?? ZEROG_DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/, "");
  const format = resolveZeroGFormat(opts.model, opts.format);
  const path = format === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 1;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // docs: Authorization: Bearer sk-…; the gateway also reads x-api-key (Anthropic SDK convention) - send both.
    authorization: `Bearer ${opts.apiKey}`,
    "x-api-key": opts.apiKey,
    ...(format === "anthropic" ? { "anthropic-version": ZEROG_ANTHROPIC_VERSION } : {}),
  };

  async function post(body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await f(base + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        const err = new ZeroGError(timedOut ? `0g timeout after ${timeoutMs} ms (${path})` : `0g network error: ${e instanceof Error ? e.message : String(e)}${(e as { cause?: { message?: string; code?: string } })?.cause ? ` (cause: ${(e as { cause?: { code?: string; message?: string } }).cause?.code ?? ""} ${(e as { cause?: { code?: string; message?: string } }).cause?.message ?? ""})` : ""}`, { code: timedOut ? "timeout" : "network", retryable: !timedOut });
        if (err.retryable && attempt < maxRetries) { attempt++; continue; }
        throw err;
      }
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      if (res.ok) return parsed;
      const err = errorFromBody(res.status, parsed, res.headers.get("x-request-id"));
      if (err.retryable && attempt < maxRetries) {
        attempt++;
        const ra = Number(res.headers.get("retry-after"));
        if (res.status === 429) await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000, ZEROG_RETRY_AFTER_CAP_MS));
        continue;
      }
      throw err;
    }
  }

  const extract = format === "anthropic" ? extractAnthropic : extractOpenAI;
  const build = format === "anthropic" ? anthropicBody : openAIBody;

  return {
    name: "0g",
    model: opts.model,
    async structured(args: StructuredArgs): Promise<StructuredResult> {
      const t0 = Date.now();
      const timeoutMs = args.timeoutMs ?? opts.timeoutMs ?? 30_000;
      const first = await post(build(opts.model, args, []), timeoutMs);
      const got = extract(first, args.toolName);
      if (got.data) return { data: got.data, raw: first, latencyMs: Date.now() - t0 };
      // one repair turn: show the model what it said, ask for JSON only
      const repair: Turn[] = [{ role: "assistant", content: got.text.trim() || "(empty response)" }, { role: "user", content: repairInstruction(args) }];
      const second = await post(build(opts.model, args, repair), timeoutMs);
      const again = extract(second, args.toolName);
      if (again.data) return { data: again.data, raw: { first, repaired: second }, latencyMs: Date.now() - t0 };
      throw new ZeroGError(`0g ${opts.model}: no ${args.toolName} tool call or JSON object in response (after one repair attempt)`, { code: "no_structured_output" });
    },
  };
}
