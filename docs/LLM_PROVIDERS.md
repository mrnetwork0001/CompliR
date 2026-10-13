# LLM providers: Anthropic or 0G Compute

The Risk Analyst (`src/lib/analyst`) and the Operator (`src/lib/operator/decide.ts`) ask a model for exactly one
structured object (a forced tool call against a JSON schema). Since the provider seam in `src/lib/llm/` that call goes
through `LlmProvider.structured(...)`, and the model behind it is chosen by environment:

| `LLM_PROVIDER` | backend | key | request |
|---|---|---|---|
| `anthropic` | api.anthropic.com via `@anthropic-ai/sdk` (unchanged original path) | `ANTHROPIC_API_KEY` | Messages API, `tools` + `tool_choice: {type:"tool"}` |
| `0g` | **0G Compute Router** `https://router-api.0g.ai` (plain `fetch`, no SDK) | `ZEROG_API_KEY` (`sk-…` from pc.0g.ai) | `/v1/messages` (Anthropic format) for `claude-*`, `/v1/chat/completions` (OpenAI format) otherwise |
| `none` | no model | — | deterministic fallback, `meta.fallback = true` (exactly what happened before without a key) |

Unset → `anthropic` if `ANTHROPIC_API_KEY` is set, else `0g` if `ZEROG_API_KEY` is set, else `none`. An explicit choice
whose key is missing resolves to `none` with a reason (never throws). Prompts, tool schemas, zod parsing, every guard
(`applyGuards`, `applyPlanGuards`, `validateAction`) and the fallback-on-any-failure rule are identical on every
provider — `src/lib/llm/parity.test.ts` asserts byte-identical guarded output across Anthropic, 0G/Anthropic-format
and 0G/OpenAI-format. The only visible difference is `meta.model`, now prefixed: `anthropic:claude-sonnet-5-5`,
`0g:claude-sonnet-5`, or `fallback`.

## Research findings (verified live 2026-10-13)

**Two ways in.** 0G Compute has a *Direct* path (wallet-signed requests through the
[`@0gfoundation/0g-compute-ts-sdk`](https://github.com/0gfoundation/0g-compute-ts-sdk) broker — `createZGComputeNetworkBroker(wallet)`,
`ledger.depositFund`, per-provider sub-accounts with a 3 0G minimum ledger / 1 0G per provider,
`getRequestHeaders(provider)` per request, optional `processResponse` TEE check; `@0glabs/0g-serving-broker` 0.7.8 is a
deprecated re-export of it) and a *Router* path: a hosted, OpenAI/Anthropic-compatible gateway with server-side API keys
and one unified on-chain balance
([overview](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/overview),
[Router vs Direct](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/comparison),
[inference/SDK](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/inference)). The docs recommend the
Router for server-side apps and agents; CompliR uses it. No wallet key, ledger contract or signing lives in the app.
The SDK (0.9.0, ~20 deps incl. express/axios/circomlibjs) was therefore **not** installed.

**Claude models are really there — relayed, not attested.** `GET https://router-api.0g.ai/v1/models` (no auth) lists
125 models. Ten are Claude, all `owned_by: "0G Foundation"`, with `supported_formats: ["anthropic"]` and the description
"Served over the Anthropic Messages format … tool use … supported":

| id | $/M in / out | live providers (`/v1/providers?model=`) |
|---|---|---|
| `claude-sonnet-5` | 1.90 / 9.50 | 2 (latency 4.4 s, 9.5 s) — **default** |
| `claude-opus-5` | 5 / 25 | 2 |
| `claude-opus-4-8` (also openai format) | 5 / 25 | 3 |
| `claude-opus-5.5` (also openai format) | 4 / 20 | 2 |
| `claude-fable-5` | 10 / 50 | 1 |
| `claude-fable-5.1`, `claude-opus-4.6`, `claude-opus-4.7`, `claude-sonnet-4.5`, `claude-sonnet-4.6` | 10/50, 5/25, 5/25, 3/15, 3/15 | **0** at check time → `503 no_available_provider` |

Caveats to be honest about: the Claude entries carry **no `verifiability`** field (every open-weight model shows
`TeeML`/`TeeTLS`), providers are `anonymous1`/`anonymous2` with `trust_mode: standard`, and the docs describe
`provider_identity` as "the operator-declared name of the upstream channel (for example `aliyun` or `openrouter`)… a
routing label, not an attested property" ([models](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/models)).
So a Claude request is relayed by an anonymous operator to Anthropic (or a reseller): you get Claude output and pay
Anthropic-list-like prices in 0G, but there is no TEE proof of which model ran and the relay sees the prompt (evidence
bundles, company snapshot). The router itself "stores only billing metadata, not request or response bodies"
([FAQ](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/faq)). Note that pc.0g.ai's Claude Code
snippet maps `claude-sonnet-5` → `0gm-1.0-35b-a3b` (an open model) by default — the Claude ids are a separate, pricier
catalog tier. No official 0G doc or blog names Anthropic models; only the live catalog does. Model availability and
provider count change without notice — `scripts/zerog/setup.ts` prints the current state.

**Auth** ([authentication](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/authentication)):
create the key at pc.0g.ai → Dashboard → API Keys (shown once); `Authorization: Bearer sk-…`. The gateway also accepts
`x-api-key` (both bogus-key probes returned `invalid_api_key` from the key validator, not "missing API key"); the provider
sends both. `mk-…` management keys (scopes `account:read`, `keys:*`) are for balance/usage, never billed. Never ship keys
to browsers; anyone with an `sk-` key can spend the deposit.

**Request format.** OpenAI chat completions are "fully compatible" incl. `tools`/`tool_choice` and
`response_format: {type:"json_object"}` for models that advertise them; `tools` on a model without the flag → 400
([chat completions](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/chat-completions)).
The Anthropic Messages endpoint `/v1/messages` exists (401 "missing API key" without a key, same validator as
`/v1/chat/completions`) and is what pc.0g.ai's Claude Code snippet targets (`ANTHROPIC_BASE_URL=https://router-api.0g.ai`,
`ANTHROPIC_AUTH_TOKEN=<key>`). Claude entries advertise `tools`, `tool_choice`, `system`, `temperature`, `max_tokens`;
`response_format` is not in their list, so the provider uses forced tool calls (the same thing the Anthropic path does)
and only falls back to JSON-in-text parsing plus one repair turn. Each response carries `x_0g_trace` (request id,
provider, billing in neuron) and `X-RateLimit-*` headers.

**Billing** ([deposits](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/account/deposits)):
deposit 0G tokens once into the 0G Payment Layer (mainnet contract `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32`, testnet
`0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939`) from the pc.0g.ai dashboard — "a normal on-chain transaction signed by your
wallet", usable within seconds; pc.0g.ai also offers a USD/Stripe mode. Cost = `input × prompt_price + output ×
completion_price`, prices in neuron per token (1e18 neuron = 1 0G) with a USD column in the catalog; no router markup.
Balance `GET /v1/account/balance` and usage `GET /v1/account/usage/{stats,history}` need an `mk-` key. Zero balance →
`402 insufficient_balance`. An analyst call is ~2–3k input + ≤800 output tokens → about $0.01 on `claude-sonnet-5`.
The Direct-path "Advanced" sub-account balances are separate from the Router balance.

**Rate limits** ([rate limits](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/rate-limits)):
per-account, thresholds undisclosed ("depend on your account state"); the unauthenticated catalog call showed
`X-RateLimit-Limit-Requests: 2000`/min. 429 carries `Retry-After`; honour it. Per-key RPM/TPM is "coming soon".

**Errors** ([errors](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/errors)): OpenAI-shaped
`{error:{message,type,code},request_id}`. 400/401 `invalid_api_key`/`api_key_revoked`, 402 `insufficient_balance`, 429
`rate_limit_exceeded`, 502 `provider_error` (retry may help), 503 `no_available_provider` (pick another model). The
provider retries 429 (sleeping `Retry-After`, capped 5 s) and 502/network once; everything else surfaces immediately as
`ZeroGError{status, code, requestId}` → the caller's deterministic fallback with `meta.error`.

## Setup

1. https://pc.0g.ai → connect a wallet (MetaMask / WalletConnect) or sign in with Google/X/Discord via Privy (embedded
   wallet) → Dashboard → **Deposit** (Router mode). Your existing credits: if they are on compute-marketplace.0g.ai /
   "Advanced" sub-accounts they do **not** fund the Router — withdraw there and deposit to the Router balance.
2. Dashboard → **API Keys** → Create → copy the `sk-…` once.
3. `.env.local`:
   ```
   LLM_PROVIDER=0g
   ZEROG_API_KEY=sk-…
   LLM_MODEL=claude-sonnet-5          # or claude-opus-5 / claude-opus-4-8 …; see `setup.ts`
   # optional: ZEROG_MANAGEMENT_KEY=mk-…  LLM_TIMEOUT_MS=30000  ZEROG_FORMAT=auto  ZEROG_BASE_URL=https://router-api.0g.ai
   ```
   `ANALYST_MODEL=claude-sonnet-5-5` in the Anthropic block is **not** a router id; `LLM_MODEL`/`ZEROG_MODEL` take
   precedence over it when the 0G provider is active (precedence: `LLM_MODEL` › `ZEROG_MODEL` › `ANALYST_MODEL` › default).
4. `node --env-file=.env.local scripts/zerog/setup.ts` — prints the Claude catalog, checks the chosen model/format/tool
   support, lists its live providers + latency; `--models` full catalog; `--balance` with an `mk-` key.
   `--verify` makes ONE paid forced-tool round trip (~300 tokens) and confirms the response shape the analyst expects.
5. Restart the app. `/company` and the console strip show "decided by 0g:claude-sonnet-5"; the decision log keeps
   `meta.model` and, on failures, `meta.error` (`0g 402 insufficient_balance: … (request req_…)`).

To go back: `LLM_PROVIDER=anthropic` (+ `ANTHROPIC_API_KEY`) or `LLM_PROVIDER=none`.

## Implementation notes

- `src/lib/llm/provider.ts` — `LlmProvider`, `selectProvider(env)`, `resolveModel`, `modelLabel`.
- `src/lib/llm/anthropic.ts` — the original SDK call, unchanged request shape; accepts an injected mock client.
- `src/lib/llm/zerog.ts` — fetch + `AbortSignal.timeout`; Anthropic-messages or OpenAI body from the same args; extracts
  the forced tool input, else JSON in text; one repair turn ("return ONLY a JSON object matching this schema"); typed errors.
- `src/lib/analyst/client.ts` — `resolveProvider(client?)`: `undefined` → env, `null` → fallback, provider → as is,
  Anthropic-shaped mock → wrapped. Existing tests inject mocks unchanged.
- Timeouts: 8 s Anthropic (as before), 30 s 0G (relayed Claude providers report 4–11 s). `LLM_TIMEOUT_MS` overrides both.
- Not verifiable without a funded key (no key was available while building): an actual paid round trip, the exact
  `/v1/messages` tool_use response bytes, and today's rate-limit threshold. `setup.ts --verify` is the check to run first.
