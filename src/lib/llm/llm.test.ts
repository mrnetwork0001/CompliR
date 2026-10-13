import { describe, it, expect, vi } from "vitest";
import { selectProvider, resolveModel, modelLabel, isLlmProvider, DEFAULT_ANTHROPIC_MODEL, type StructuredArgs } from "./provider";
import { zeroGProvider, ZeroGError, resolveZeroGFormat, extractJsonObject, ZEROG_DEFAULT_MODEL } from "./zerog";
import { anthropicProvider } from "./anthropic";

const SCHEMA = { type: "object" as const, properties: { a: { type: "number" }, b: { type: "string" } }, required: ["a", "b"] };
const ARGS: StructuredArgs = { system: "sys", user: "usr", schema: SCHEMA, toolName: "submit_thing", toolDescription: "d", maxTokens: 100, temperature: 0 };

type Reply = { status?: number; headers?: Record<string, string>; body: unknown } | Error;
/** fetch stub that replays `replies` in order and records every request */
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const r = replies[Math.min(calls.length, replies.length - 1)];
    calls.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})), body: JSON.parse(String(init?.body)) });
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const anthropicToolReply = (input: unknown, name = "submit_thing") => ({ body: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "tool_use", id: "tu_1", name, input }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } } });
const anthropicTextReply = (text: string) => ({ body: { id: "msg_2", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } });
const openAIToolReply = (args: string | object) => ({ body: { id: "cmpl", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "submit_thing", arguments: typeof args === "string" ? args : JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] } });
const openAITextReply = (content: string) => ({ body: { id: "cmpl", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] } });

describe("selectProvider — env matrix", () => {
  const cases: [Record<string, string | undefined>, string, string][] = [
    [{}, "none", "fallback"],
    [{ ANTHROPIC_API_KEY: "sk-ant" }, "anthropic", DEFAULT_ANTHROPIC_MODEL],
    [{ ZEROG_API_KEY: "sk-0g" }, "0g", ZEROG_DEFAULT_MODEL],
    [{ ANTHROPIC_API_KEY: "sk-ant", ZEROG_API_KEY: "sk-0g" }, "anthropic", DEFAULT_ANTHROPIC_MODEL],
    [{ ANTHROPIC_API_KEY: "sk-ant", ZEROG_API_KEY: "sk-0g", LLM_PROVIDER: "0g" }, "0g", ZEROG_DEFAULT_MODEL],
    [{ ANTHROPIC_API_KEY: "sk-ant", ZEROG_API_KEY: "sk-0g", LLM_PROVIDER: "anthropic" }, "anthropic", DEFAULT_ANTHROPIC_MODEL],
    [{ ANTHROPIC_API_KEY: "sk-ant", ZEROG_API_KEY: "sk-0g", LLM_PROVIDER: "none" }, "none", "fallback"],
    [{ LLM_PROVIDER: "0g" }, "none", "fallback"], // explicit but no key → fallback, never throws
    [{ LLM_PROVIDER: "anthropic", ZEROG_API_KEY: "sk-0g" }, "none", "fallback"],
    [{ LLM_PROVIDER: "bogus", ANTHROPIC_API_KEY: "sk-ant" }, "none", "fallback"],
    [{ ZEROG_API_KEY: "sk-0g", ANALYST_MODEL: "claude-opus-5" }, "0g", "claude-opus-5"],
    [{ ZEROG_API_KEY: "sk-0g", ANALYST_MODEL: "claude-opus-5", ZEROG_MODEL: "glm-5.3" }, "0g", "glm-5.3"],
    [{ ZEROG_API_KEY: "sk-0g", ANALYST_MODEL: "claude-opus-5", ZEROG_MODEL: "glm-5.3", LLM_MODEL: "claude-sonnet-5" }, "0g", "claude-sonnet-5"],
    [{ ANTHROPIC_API_KEY: "sk-ant", ANALYST_MODEL: "claude-x", LLM_MODEL: "claude-y" }, "anthropic", "claude-y"],
    [{ ANTHROPIC_API_KEY: "sk-ant", ANALYST_MODEL: "claude-x", ZEROG_MODEL: "glm-5.3" }, "anthropic", "claude-x"], // ZEROG_MODEL never leaks into anthropic
    [{ ANTHROPIC_API_KEY: "   ", ZEROG_API_KEY: "sk-0g" }, "0g", ZEROG_DEFAULT_MODEL], // blank = unset
  ];
  for (const [env, name, model] of cases) {
    it(`${JSON.stringify(env)} → ${name}:${model}`, () => {
      const sel = selectProvider(env);
      expect(sel.name).toBe(name);
      expect(sel.model).toBe(model);
      expect(sel.reason).toBeTruthy();
      if (name === "none") expect(sel.provider).toBeNull();
      else { expect(isLlmProvider(sel.provider)).toBe(true); expect(modelLabel(sel.provider!)).toBe(`${name}:${model}`); }
    });
  }
  it("resolveModel precedence", () => {
    expect(resolveModel("0g", {})).toBe(ZEROG_DEFAULT_MODEL);
    expect(resolveModel("anthropic", {})).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(resolveModel("0g", { ANALYST_MODEL: "a", ZEROG_MODEL: "z", LLM_MODEL: "l" })).toBe("l");
  });
  it("format auto: claude-* → anthropic messages, anything else → openai chat completions", () => {
    expect(resolveZeroGFormat("claude-sonnet-5")).toBe("anthropic");
    expect(resolveZeroGFormat("glm-5.3")).toBe("openai");
    expect(resolveZeroGFormat("glm-5.3", "anthropic")).toBe("anthropic");
  });
});

describe("zeroGProvider — anthropic messages format (claude-* on the router)", () => {
  it("forces the tool, sends the router auth headers, returns the tool input", async () => {
    const { f, calls } = fakeFetch([anthropicToolReply({ a: 1, b: "x" })]);
    const p = zeroGProvider({ apiKey: "sk-test", model: "claude-sonnet-5", fetchImpl: f });
    const r = await p.structured(ARGS);
    expect(r.data).toEqual({ a: 1, b: "x" });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://router-api.0g.ai/v1/messages");
    expect(calls[0].headers.authorization).toBe("Bearer sk-test");
    expect(calls[0].headers["x-api-key"]).toBe("sk-test");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].body).toMatchObject({ model: "claude-sonnet-5", system: "sys", max_tokens: 100, temperature: 0, tool_choice: { type: "tool", name: "submit_thing" }, messages: [{ role: "user", content: "usr" }] });
    expect((calls[0].body.tools as { input_schema: unknown }[])[0].input_schema).toEqual(SCHEMA);
  });
  it("strips a trailing /v1 from ZEROG_BASE_URL", async () => {
    const { f, calls } = fakeFetch([anthropicToolReply({ a: 1, b: "x" })]);
    await zeroGProvider({ apiKey: "k", model: "claude-sonnet-5", baseUrl: "https://gw.example/v1/", fetchImpl: f }).structured(ARGS);
    expect(calls[0].url).toBe("https://gw.example/v1/messages");
  });
  it("prose instead of a tool call → ONE repair turn, then the repaired JSON is returned", async () => {
    const { f, calls } = fakeFetch([anthropicTextReply("Sure! Here is my analysis in words, no JSON."), anthropicTextReply('```json\n{"a": 2, "b": "repaired"}\n```')]);
    const r = await zeroGProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl: f }).structured(ARGS);
    expect(r.data).toEqual({ a: 2, b: "repaired" });
    expect(calls).toHaveLength(2);
    const msgs = calls[1].body.messages as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content).toMatch(/Sure! Here is my analysis/);
    expect(msgs[2].content).toMatch(/ONLY a JSON object matching this schema/);
    expect(msgs[2].content).toContain('"required":["a","b"]');
    expect(calls[1].body.tool_choice).toEqual({ type: "tool", name: "submit_thing" });
  });
  it("two misses → ZeroGError no_structured_output (caller falls back)", async () => {
    const { f, calls } = fakeFetch([anthropicTextReply("nope"), anthropicTextReply("still nope")]);
    await expect(zeroGProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl: f }).structured(ARGS)).rejects.toMatchObject({ name: "ZeroGError", code: "no_structured_output" });
    expect(calls).toHaveLength(2);
  });
});

describe("zeroGProvider — openai chat completions format (open-weight models)", () => {
  it("parses tool_calls[0].function.arguments (JSON string)", async () => {
    const { f, calls } = fakeFetch([openAIToolReply({ a: 3, b: "y" })]);
    const r = await zeroGProvider({ apiKey: "k", model: "glm-5.3", fetchImpl: f }).structured(ARGS);
    expect(r.data).toEqual({ a: 3, b: "y" });
    expect(calls[0].url).toBe("https://router-api.0g.ai/v1/chat/completions");
    expect(calls[0].headers["anthropic-version"]).toBeUndefined();
    expect(calls[0].body).toMatchObject({ model: "glm-5.3", tool_choice: { type: "function", function: { name: "submit_thing" } }, messages: [{ role: "system", content: "sys" }, { role: "user", content: "usr" }] });
    expect((calls[0].body.tools as { function: { parameters: unknown } }[])[0].function.parameters).toEqual(SCHEMA);
  });
  it("malformed arguments → repair turn with the raw text, then JSON found in plain content", async () => {
    const { f, calls } = fakeFetch([openAIToolReply('{"a": 1, "b": '), openAITextReply('Here you go: {"a": 1, "b": "ok"} hope this helps')]);
    const r = await zeroGProvider({ apiKey: "k", model: "glm-5.3", fetchImpl: f }).structured(ARGS);
    expect(r.data).toEqual({ a: 1, b: "ok" });
    const msgs = calls[1].body.messages as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(msgs[2].content).toBe('{"a": 1, "b":'); // trimmed
  });
  it("extractJsonObject: fences, surrounding prose, non-objects", () => {
    expect(extractJsonObject('```json\n{"x":1}\n```')).toEqual({ x: 1 });
    expect(extractJsonObject('text {"x":{"y":[1,2]}} more')).toEqual({ x: { y: [1, 2] } });
    expect(extractJsonObject("[1,2]")).toBeUndefined();
    expect(extractJsonObject("")).toBeUndefined();
  });
});

describe("zeroGProvider — errors, retries, timeouts", () => {
  it("402 insufficient_balance → ZeroGError with status/code/request id, no retry", async () => {
    const { f, calls } = fakeFetch([{ status: 402, body: { error: { message: "Insufficient balance to process request", type: "payment_error", code: "insufficient_balance" }, request_id: "req_1" } }]);
    const err = await zeroGProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl: f }).structured(ARGS).catch((e) => e);
    expect(err).toBeInstanceOf(ZeroGError);
    expect(err).toMatchObject({ status: 402, code: "insufficient_balance", requestId: "req_1", retryable: false });
    expect(err.message).toBe("0g 402 insufficient_balance: Insufficient balance to process request (request req_1)");
    expect(calls).toHaveLength(1);
  });
  it("401 invalid_api_key and 503 no_available_provider are not retried", async () => {
    for (const [status, code] of [[401, "invalid_api_key"], [503, "no_available_provider"]] as const) {
      const { f, calls } = fakeFetch([{ status, body: { error: { message: "m", type: "t", code } } }]);
      await expect(zeroGProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl: f }).structured(ARGS)).rejects.toMatchObject({ status, code });
      expect(calls).toHaveLength(1);
    }
  });
  it("429 → waits Retry-After (capped) and retries once; 502 retries once", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    const a = fakeFetch([{ status: 429, headers: { "retry-after": "2" }, body: { error: { message: "slow down", type: "rate_limit_error", code: "rate_limit_exceeded" } } }, anthropicToolReply({ a: 1, b: "x" })]);
    const r = await zeroGProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl: a.f, sleep }).structured(ARGS);
    expect(r.data).toEqual({ a: 1, b: "x" });
    expect(a.calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    const b = fakeFetch([{ status: 502, body: { error: { message: "provider", type: "server_error", code: "provider_error" } } }, anthropicToolReply({ a: 1, b: "x" })]);
    await zeroGProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl: b.f, sleep }).structured(ARGS);
    expect(b.calls).toHaveLength(2);
    const c = fakeFetch([{ status: 429, headers: { "retry-after": "60" }, body: { error: { code: "rate_limit_exceeded", message: "x" } } }]);
    await expect(zeroGProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl: c.f, sleep }).structured(ARGS)).rejects.toMatchObject({ status: 429 });
    expect(c.calls).toHaveLength(2); // one retry, capped wait
    expect(sleeps.at(-1)).toBe(5000);
  });
  it("timeout → ZeroGError code timeout, not retried", async () => {
    const f = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => { init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)); })) as unknown as typeof fetch;
    const err = await zeroGProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl: f, timeoutMs: 20 }).structured(ARGS).catch((e) => e);
    expect(err).toMatchObject({ name: "ZeroGError", code: "timeout" });
    expect(err.message).toMatch(/timeout after 20 ms/);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("network error → retried once, then surfaced", async () => {
    const { f, calls } = fakeFetch([new Error("ECONNRESET"), new Error("ECONNRESET")]);
    await expect(zeroGProvider({ apiKey: "k", model: "claude-sonnet-5", fetchImpl: f }).structured(ARGS)).rejects.toMatchObject({ code: "network" });
    expect(calls).toHaveLength(2);
  });
  it("missing key is a construction-time error", () => {
    expect(() => zeroGProvider({ apiKey: "", model: "claude-sonnet-5" })).toThrow(/ZEROG_API_KEY/);
  });
});

describe("anthropicProvider", () => {
  it("sends the forced tool-use request the analyst always sent and returns the tool input", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: "thinking…" }, { type: "tool_use", id: "t", name: "submit_thing", input: { a: 9, b: "z" } }] }));
    const p = anthropicProvider({ model: "claude-test", client: { messages: { create } } as never });
    const r = await p.structured(ARGS);
    expect(r.data).toEqual({ a: 9, b: "z" });
    expect(modelLabel(p)).toBe("anthropic:claude-test");
    expect((create.mock.calls as unknown[][])[0][0]).toMatchObject({ model: "claude-test", max_tokens: 100, temperature: 0, system: "sys", tool_choice: { type: "tool", name: "submit_thing" }, tools: [{ name: "submit_thing", description: "d", input_schema: SCHEMA }], messages: [{ role: "user", content: "usr" }] });
  });
  it("no tool_use block → throws (caller falls back)", async () => {
    const p = anthropicProvider({ model: "m", client: { messages: { create: async () => ({ content: [{ type: "text", text: "no" }] }) } } as never });
    await expect(p.structured(ARGS)).rejects.toThrow(/no tool_use block/);
  });
});
