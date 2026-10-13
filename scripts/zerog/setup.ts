/**
 * 0G Compute Router check-up for CompliR (docs/LLM_PROVIDERS.md).
 *
 *   node --env-file=.env.local scripts/zerog/setup.ts              # config + catalog + live providers for the chosen model (free, no key needed)
 *   node --env-file=.env.local scripts/zerog/setup.ts --models     # the whole catalog (125 models on 2026-10-13)
 *   node --env-file=.env.local scripts/zerog/setup.ts --balance    # balance + 7-day usage (needs ZEROG_MANAGEMENT_KEY, an mk-… key with account:read)
 *   node --env-file=.env.local scripts/zerog/setup.ts --verify     # ONE forced-tool round trip through the router — SPENDS a few hundred tokens
 *
 * The Router is a hosted gateway: there is no wallet key, no ledger contract and no `--fund` here. Deposits are an
 * on-chain transaction you sign in the pc.0g.ai dashboard (Dashboard → Deposit → 0G Payment Layer), see the printed
 * steps. Self-contained on purpose (fetch + node builtins) so plain `node` can run it.
 *
 * Sources: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/quickstart
 *          https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/authentication
 *          https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/account/deposits
 *          https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/errors
 */
const args = new Set(process.argv.slice(2));
const env = process.env;
const base = (env.ZEROG_BASE_URL ?? "https://router-api.0g.ai").replace(/\/+$/, "").replace(/\/v1$/, "");
const apiKey = env.ZEROG_API_KEY?.trim() || "";
const mgmtKey = env.ZEROG_MANAGEMENT_KEY?.trim() || "";
const model = env.LLM_MODEL?.trim() || env.ZEROG_MODEL?.trim() || env.ANALYST_MODEL?.trim() || "claude-sonnet-5";
const format = (env.ZEROG_FORMAT?.trim() || "auto") === "auto" ? (/^claude[-_]/i.test(model) ? "anthropic" : "openai") : env.ZEROG_FORMAT!.trim();
const provider = (env.LLM_PROVIDER ?? "").trim() || (env.ANTHROPIC_API_KEY?.trim() ? "anthropic (default: ANTHROPIC_API_KEY set)" : apiKey ? "0g (default: only ZEROG_API_KEY set)" : "none (no key)");

type Model = { id: string; name?: string; supported_formats?: string[]; supported_parameters?: string[]; context_length?: number; max_completion_tokens?: number; verifiability?: string; provider_count?: number; pricing_usd?: { prompt?: string; completion?: string } };
type Prov = { provider_identity?: string; address?: string; is_healthy?: boolean; latency?: number | null; uptime?: number; trust_mode?: string; pricing_usd?: { prompt?: string; completion?: string } };

const usdPerM = (s?: string) => (s == null ? "?" : (Number(s) * 1e6).toFixed(2));
async function getJson<T>(path: string, key?: string): Promise<T> {
  const res = await fetch(base + path, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function main() {
  console.log(`CompliR × 0G Compute Router\n  base URL          ${base}\n  LLM_PROVIDER      ${provider}\n  model             ${model}  (format ${format} → ${format === "anthropic" ? "/v1/messages" : "/v1/chat/completions"})\n  ZEROG_API_KEY     ${apiKey ? apiKey.slice(0, 6) + "…" + apiKey.slice(-4) : "(not set)"}\n  ZEROG_MANAGEMENT_KEY ${mgmtKey ? "set" : "(not set — balance/usage skipped)"}\n`);

  const catalog = await getJson<{ data: Model[] }>("/v1/models");
  const all = catalog.data;
  const show = args.has("--models") ? all : all.filter((m) => /^claude/i.test(m.id));
  console.log(`${args.has("--models") ? "Catalog" : "Claude models on the router"} (${show.length} of ${all.length}; GET ${base}/v1/models, no auth):`);
  for (const m of show) {
    console.log(`  ${m.id.padEnd(30)} fmt=${(m.supported_formats ?? []).join("/").padEnd(16)} providers=${String(m.provider_count ?? 0).padEnd(2)} tools=${(m.supported_parameters ?? []).includes("tools") ? "y" : "n"} tee=${(m.verifiability ?? "none").padEnd(7)} $${usdPerM(m.pricing_usd?.prompt)}/$${usdPerM(m.pricing_usd?.completion)} per M in/out`);
  }

  const chosen = all.find((m) => m.id === model);
  console.log("");
  if (!chosen) {
    console.log(`!! model "${model}" is NOT in the catalog — set LLM_MODEL to one of the ids above (ANALYST_MODEL=claude-sonnet-5-5 is an Anthropic id, not a router id).`);
  } else {
    const fmts = chosen.supported_formats ?? [];
    console.log(`Chosen model ${model}: formats ${fmts.join("/")}, ctx ${chosen.context_length}, max out ${chosen.max_completion_tokens}, tools=${(chosen.supported_parameters ?? []).includes("tools")}, verifiability=${chosen.verifiability ?? "none (relayed upstream, not TEE-attested)"}`);
    if (!fmts.includes(format)) console.log(`!! format "${format}" is not advertised for ${model} (supported: ${fmts.join("/")}) — set ZEROG_FORMAT=${fmts[0]}`);
    if (!(chosen.supported_parameters ?? []).includes("tools")) console.log(`!! ${model} does not advertise tool calling; the analyst/operator force a tool call and will fall back to deterministic output.`);
    const provs = await getJson<{ data: Prov[] }>(`/v1/providers?model=${encodeURIComponent(model)}`);
    if (!provs.data.length) console.log(`!! no live providers for ${model} right now → requests return 503 no_available_provider (pick another id).`);
    else for (const p of provs.data) console.log(`  provider ${String(p.provider_identity ?? p.address ?? "?").padEnd(14)} healthy=${p.is_healthy} latency=${p.latency ?? "?"}ms uptime=${p.uptime ?? "?"} trust=${p.trust_mode ?? "?"} $${usdPerM(p.pricing_usd?.prompt)}/$${usdPerM(p.pricing_usd?.completion)}`);
    const lat = Math.max(0, ...provs.data.map((p) => p.latency ?? 0));
    if (lat > 8000) console.log(`  note: provider latency ${lat} ms > 8 s — keep LLM_TIMEOUT_MS at 30000 (0g default) or higher.`);
  }

  if (args.has("--balance") || mgmtKey) {
    if (!mgmtKey) console.log("\n--balance needs ZEROG_MANAGEMENT_KEY (pc.0g.ai → Dashboard → API Keys → management key, scope account:read).");
    else {
      try {
        const bal = await getJson<{ address?: string; deposit_balance?: string; total_balance?: string }>("/v1/account/balance", mgmtKey);
        const og = (n?: string) => (n == null ? "?" : (Number(n) / 1e18).toFixed(4));
        console.log(`\nBalance (GET /v1/account/balance): wallet ${bal.address ?? "?"} · deposit ${og(bal.deposit_balance)} 0G · total ${og(bal.total_balance)} 0G (1e18 neuron = 1 0G)`);
        const end = new Date(), start = new Date(Date.now() - 7 * 86400e3);
        const st = await getJson<Record<string, unknown>>(`/v1/account/usage/stats?start_date=${start.toISOString().slice(0, 10)}&end_date=${end.toISOString().slice(0, 10)}`, mgmtKey);
        console.log(`Usage last 7 days (GET /v1/account/usage/stats): ${JSON.stringify(st)}`);
      } catch (e) { console.log(`\nbalance/usage failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  if (args.has("--verify")) {
    if (!apiKey) { console.log("\n--verify needs ZEROG_API_KEY."); process.exitCode = 1; return; }
    const tool = { name: "submit_check", description: "Report the check.", schema: { type: "object", properties: { ok: { type: "boolean" }, echo: { type: "string" } }, required: ["ok", "echo"] } };
    const system = "You are a connectivity check. Call the submit_check tool with ok=true and echo=the word the user sends. Nothing else.";
    const user = "complir";
    const body = format === "anthropic"
      ? { model, max_tokens: 64, temperature: 0, system, tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }], tool_choice: { type: "tool", name: tool.name }, messages: [{ role: "user", content: user }] }
      : { model, max_tokens: 64, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }], tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }], tool_choice: { type: "function", function: { name: tool.name } } };
    const path = format === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
    const t0 = Date.now();
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, ...(format === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(env.LLM_TIMEOUT_MS) || 60_000) });
    const text = await res.text();
    console.log(`\nPOST ${path} → HTTP ${res.status} in ${Date.now() - t0} ms  (x-request-id ${res.headers.get("x-request-id") ?? "?"}; rate limit ${res.headers.get("x-ratelimit-remaining-requests") ?? "?"}/${res.headers.get("x-ratelimit-limit-requests") ?? "?"} left this minute)`);
    let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok) { console.log(JSON.stringify(json, null, 2)); process.exitCode = 1; return; }
    const j = json as Record<string, unknown>;
    const content = Array.isArray(j.content) ? (j.content as { type: string; name?: string; input?: unknown }[]) : [];
    const toolUse = content.find((b) => b.type === "tool_use")?.input;
    const choice = Array.isArray(j.choices) ? (j.choices as { message?: { tool_calls?: { function?: { arguments?: string } }[]; content?: string } }[])[0] : undefined;
    const fnArgs = choice?.message?.tool_calls?.[0]?.function?.arguments;
    const out = toolUse ?? (fnArgs ? JSON.parse(fnArgs) : choice?.message?.content);
    console.log(`structured output: ${JSON.stringify(out)}`);
    console.log(`usage: ${JSON.stringify(j.usage ?? null)}  trace: ${JSON.stringify(j.x_0g_trace ?? j._0g ?? null)}`);
    const ok = out && typeof out === "object" && (out as { ok?: unknown }).ok === true && String((out as { echo?: unknown }).echo ?? "").toLowerCase().includes("complir");
    console.log(ok ? "\nOK — the router answers a forced tool call in the shape the analyst/operator expect. Set LLM_PROVIDER=0g to use it." : "\n!! unexpected shape — check the model/format above; the app would fall back to deterministic output for this response.");
    if (!ok) process.exitCode = 1;
  } else {
    console.log(`\nNext: deposit & key (once) at https://pc.0g.ai → Dashboard → Deposit (0G tokens into the 0G Payment Layer contract, Router mode)
      then Dashboard → API Keys → Create (sk-… shown once) → ZEROG_API_KEY=sk-… in .env.local
      then: node --env-file=.env.local scripts/zerog/setup.ts --verify   (one paid round trip, ~300 tokens)
      then: LLM_PROVIDER=0g  (and LLM_MODEL=${model})`);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
