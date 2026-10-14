# CompliR MCP server

`packages/mcp` (`@complir/mcp`) is a Model Context Protocol server that wraps the CompliR HTTP API so any MCP-capable agent
(Claude Desktop, Claude Code, Cursor, custom agents built on the MCP SDK) can screen a counterparty before paying it USDC on
Arc. It implements SUGGESTIONS.md §G item 40: "add CompliR in one config line".

## What it is

- A stdio MCP server (plus an optional stateless Streamable HTTP mode) built on `@modelcontextprotocol/sdk` 1.32.1.
- It calls the public API (`/api/v1/*`) with `fetch`. When `COMPLIR_PAYER_PRIVATE_KEY` is set, paid endpoints go through
  `@complir/sdk` (`packages/sdk`), which handles the x402 `402 → sign EIP-3009 → retry` flow with a viem account. Without a key
  a paid call returns a tool error that tells the agent to set the payer key or point `COMPLIR_URL` at an `X402_DISABLED=1`
  deployment.
- Results are compacted for LLM context: `evidence.funders` becomes `{ total, hop1, hop2, flagged, topPaths[≤3] }`, reason
  evidence is trimmed (short arrays/strings), while `decisionId`, `tier`, `score`, `recommendedLimits`, `reasons[].code`,
  `rationale`, the full `attestation` (so the agent can store and verify it) and `edd.url` are always present.
- The server writes only JSON-RPC to stdout; diagnostics go to stderr.

## Setup

```sh
npm install                                   # repo root, once
node packages/mcp/bin/complir-mcp.mjs --help  # Node >= 22.18 (type stripping); 22.6–22.17: node --experimental-strip-types …
```

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPLIR_URL` | `http://localhost:3000` | Deployment to call. |
| `COMPLIR_PAYER_PRIVATE_KEY` | unset | Wallet (0x private key) holding USDC on Arc; enables `screen_counterparty` / `watch_counterparty` on x402-enabled deployments. |
| `COMPLIR_MAX_PRICE_USDC` | `0.1` | Upper bound the server will sign per call. |
| `COMPLIR_MCP_HTTP_PORT` | unset | Serve Streamable HTTP on `127.0.0.1:<port>/mcp` (same as `--http <port>`). |

Client config (full snippets for Claude Desktop, Cursor and HTTP in `packages/mcp/README.md`):

```sh
claude mcp add complir -e COMPLIR_URL=https://trycomplir.xyz -e COMPLIR_PAYER_PRIVATE_KEY=0x… -- node /abs/path/complir/packages/mcp/bin/complir-mcp.mjs
```

## Tools

| Tool | Endpoint | Cost | Input | Output (compact) |
| --- | --- | --- | --- | --- |
| `screen_counterparty` | `POST /api/v1/screen` | 0.01 USDC | `address`, `name?`, `amountUsdc?`, `payeeBook?`, `depth?` | `decisionId`, `tier`, `score`, `recommendedLimits`, `reasons[{code,weight,evidence}]`, `rationale`, `eddRequested`, `edd{id,url}`, `nextRescreenAt`, `attestation`, `evidence{subject, funders{total,hop1,hop2,flagged,topPaths}}`, `payment?` |
| `watch_counterparty` | `POST /api/v1/watch` | 0.05 USDC / 30 d | `address`, `webhookUrl`, `payeeBook?` | `Watch` |
| `shadow_report` | `POST /api/v1/shadow` | free | `payeeBook`, `recentPayments?` | `summary`, `entries[≤60]`, `paymentsAtRisk` |
| `get_attestation` | `GET /api/v1/attestation/:address` | free | `address` | stored verdict + `attestation`, `signatureValid`, `expired`; `found:false` on 404 |
| `verify_attestation` | offline (`@complir/sdk`) | free | `attestation`, `expectedAttester?`, `expectedChainId?`, `ignoreExpiry?` | `valid`, `signatureValid`, `expired`, `reason`, decoded `subject`/`tier`/`score`/`decisionHash`/`validUntil` |
| `get_network_signal` | `GET /api/v1/network/:address` | free | `address` | endpoint payload, or `available:false` when the deployment returns 404 |
| `get_decision` | `GET /api/v1/decision/:id` | free | `id` | decision-log entry (verdict payload with compact evidence) |
| `list_recent_tier_changes` | `GET /api/v1/map/changes` | free | `limit?` (≤200) | `{ items[], limit }` |
| `company_status` | `GET /api/v1/company` → fallback `/numbers` + `/health` | free | none | status + counters, `baseUrl`, configured `payer` |

Resources: `complir://docs` (markdown integration notes), `complir://attestation/{address}` (JSON).
Prompt: `pay_safely` (`address`, `amountUsdc?`, `name?`) — instructs an agent to screen first, hold HIGH, cap MEDIUM at
`recommendedLimits`, forward `edd.url`, verify and store the attestation, then watch or re-screen.

Errors are returned as MCP tool errors (`isError: true`) with a `CODE: message` text, e.g.
`PAYMENT_REQUIRED: Payment required: POST /api/v1/screen costs 0.01 USDC on eip155:5042 via x402. This MCP server has no payer
wallet configured … set COMPLIR_PAYER_PRIVATE_KEY …`, `UNREACHABLE: Cannot reach CompliR at … Check COMPLIR_URL`, or the API's
own `VALIDATION_ERROR` / `NOT_FOUND` messages.

## Verification

```sh
npx tsc --noEmit                      # root typecheck includes packages/mcp
npx vitest run packages/mcp           # 10 tests: tool list, compaction, verify, 402 mapping, x402 payment, fallbacks
COMPLIR_URL=http://localhost:3000 node packages/mcp/scripts/smoke.mjs   # live stdio: tools/list + screen_counterparty
```
