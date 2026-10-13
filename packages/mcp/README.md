# @complir/mcp

MCP (Model Context Protocol) server that exposes [CompliR](../../README.md), the counterparty risk oracle on Arc, as tools an
agent can call before it pays someone USDC. One config line gives Claude Desktop, Claude Code, Cursor or any MCP client
`screen_counterparty`, `watch_counterparty`, `shadow_report`, attestation lookup and offline verification, decision replay
and Trust Map signals.

- Transport: **stdio** (default) or **Streamable HTTP** (`--http [port]`, endpoint `/mcp`, stateless).
- Paid endpoints (`screen` 0.01 USDC, `watch` 0.05 USDC / 30 days) are paid through x402 by `@complir/sdk` when
  `COMPLIR_PAYER_PRIVATE_KEY` is set; without a key the tool returns a clear error telling the agent what to configure.
- Tool results are compacted for context windows: the full 2-hop funder graph becomes counts + the top 3 paths, and reason
  evidence is trimmed; `decisionId`, `tier`, `score`, `recommendedLimits`, `reasons[].code`, `rationale`, the full
  `attestation` (typedData + signature) and `edd.url` are always present.

## Requirements

Node >= 22.18 (or 24+). The server runs the TypeScript sources directly with Node's built-in type stripping; on Node 22.6–22.17
run it as `node --experimental-strip-types packages/mcp/bin/complir-mcp.mjs`. Install the repo's dependencies once
(`npm install` at the repo root).

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMPLIR_URL` | `http://localhost:3000` | CompliR deployment to talk to. |
| `COMPLIR_PAYER_PRIVATE_KEY` | unset | 0x-prefixed private key of a wallet holding USDC on Arc. Enables `screen_counterparty` and `watch_counterparty` against an x402-enabled deployment. Keep it out of shell history: put it in the MCP client's `env` block. |
| `COMPLIR_MAX_PRICE_USDC` | `0.1` | The server refuses to sign an x402 payment above this amount per call. |
| `COMPLIR_MCP_HTTP_PORT` | unset | If set (or `--http [port]` is passed), serve Streamable HTTP on `127.0.0.1:<port>/mcp` instead of stdio. |

Against a local CompliR started with `X402_DISABLED=1` (the default in `.env.local`) no payer key is needed.

## Client configuration

Replace `/abs/path/to/complir` with the repository path.

**Claude Code**

```sh
claude mcp add complir -e COMPLIR_URL=http://localhost:3000 -- node /abs/path/to/complir/packages/mcp/bin/complir-mcp.mjs
# with payments:
claude mcp add complir -e COMPLIR_URL=https://complir.example -e COMPLIR_PAYER_PRIVATE_KEY=0x… -- node /abs/path/to/complir/packages/mcp/bin/complir-mcp.mjs
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "complir": {
      "command": "node",
      "args": ["/abs/path/to/complir/packages/mcp/bin/complir-mcp.mjs"],
      "env": { "COMPLIR_URL": "https://complir.example", "COMPLIR_PAYER_PRIVATE_KEY": "0x…", "COMPLIR_MAX_PRICE_USDC": "0.1" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "complir": {
      "command": "node",
      "args": ["/abs/path/to/complir/packages/mcp/bin/complir-mcp.mjs"],
      "env": { "COMPLIR_URL": "https://complir.example" }
    }
  }
}
```

**Streamable HTTP** (for remote agents / `mcp-remote`)

```sh
COMPLIR_URL=https://complir.example node packages/mcp/bin/complir-mcp.mjs --http 3333
# MCP endpoint: http://127.0.0.1:3333/mcp   (bind it behind your own auth before exposing it)
```

## Tools

| Tool | Cost | What it does |
| --- | --- | --- |
| `screen_counterparty` | 0.01 USDC | Grade an address (+ `name`, `amountUsdc`, `payeeBook`, `depth`). Returns tier, score, `recommendedLimits`, reasons, rationale, signed attestation, `decisionId`, `edd.url`, compact evidence, x402 receipt. |
| `watch_counterparty` | 0.05 USDC / 30 d | Register `address` + `webhookUrl`; `tier.changed` events are POSTed when the tier moves. |
| `shadow_report` | free | Payee book (+ recent payments) → what CompliR would have held / limited, lookalikes, `paymentsAtRisk`. |
| `get_attestation` | free | Latest stored verdict + attestation for an address; signature verified offline (`signatureValid`, `expired`). |
| `verify_attestation` | free, offline | EIP-712 domain/types/range/expiry/signature check of any attestation; optional `expectedAttester`, `expectedChainId`. |
| `get_network_signal` | free | `GET /api/v1/network/:address` (Trust Map context). `available:false` if the deployment lacks it. |
| `get_decision` | free | Replay a hash-chained decision-log entry by `decisionId`. |
| `list_recent_tier_changes` | free | Recent tier changes from the Trust Map tailer (`limit` ≤ 200). |
| `company_status` | free | Deployment status + public numbers (`/api/v1/company`, falling back to `/api/v1/numbers` + `/api/v1/health`); reports the configured payer. |

Resources: `complir://docs` (integration notes, markdown) and `complir://attestation/{address}` (JSON).
Prompt: `pay_safely` (`address`, `amountUsdc?`, `name?`) — screen first, respect limits, forward EDD, store the attestation.

## Example conversation

> **User:** Pay 120 USDC to 0x<payee> for the October invoice from Lela Design.
>
> **Agent:** Before sending I will screen the payee with CompliR.
> *calls `screen_counterparty` { address: "0x…beef", amountUsdc: 120, name: "Lela Design", payeeBook: [...] }*
>
> CompliR graded 0x…beef **MEDIUM** (score 44, decision `dec_01J…`). Reasons: `FRESH_WALLET`, `NO_HISTORY`. Recommended limits:
> 100 USDC per transaction, 300 USDC per day. An Enhanced Due Diligence request is open at `https://complir.example/edd/edd_…`.
>
> *calls `verify_attestation` { attestation: …, expectedAttester: "0x…" }* → `valid: true`
>
> I will send **100 USDC** now (the per-transaction limit) and hold the remaining 20 USDC until Lela Design answers the EDD
> questions (link forwarded). The attestation, signature and `decisionId` are stored with the payment record.
> *calls `watch_counterparty` { address: "0x…beef", webhookUrl: "https://treasury.example/complir" }* so a tier change
> reaches us before the next invoice.

## Development

```sh
npx vitest run packages/mcp          # unit tests (fetch mocked, in-memory MCP transport)
npx tsc --noEmit -p packages/mcp     # typecheck
COMPLIR_URL=http://localhost:3000 node packages/mcp/scripts/smoke.mjs   # live: tools/list + screen over stdio
```

Source layout: `src/api.ts` (HTTP + x402 via the SDK, error mapping), `src/compact.ts` (verdict compaction),
`src/server.ts` (tools / resources / prompt), `src/cli.ts` (stdio + Streamable HTTP), `bin/complir-mcp.mjs` (launcher).
