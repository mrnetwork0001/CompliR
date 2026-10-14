import Link from "next/link";
import { Code, Kv, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const CLAUDE_CODE = `# Claude Code - free local deployment (X402_DISABLED=1)
claude mcp add complir -e COMPLIR_URL=http://localhost:3000 -- node /abs/path/to/complir/packages/mcp/bin/complir-mcp.mjs

# with payments on an x402-enabled deployment
claude mcp add complir -e COMPLIR_URL=https://trycomplir.xyz -e COMPLIR_PAYER_PRIVATE_KEY=0x… \\
  -- node /abs/path/to/complir/packages/mcp/bin/complir-mcp.mjs`;

const DESKTOP = `// Claude Desktop (claude_desktop_config.json) · Cursor (.cursor/mcp.json) - same shape
{
  "mcpServers": {
    "complir": {
      "command": "node",
      "args": ["/abs/path/to/complir/packages/mcp/bin/complir-mcp.mjs"],
      "env": { "COMPLIR_URL": "https://trycomplir.xyz", "COMPLIR_PAYER_PRIVATE_KEY": "0x…", "COMPLIR_MAX_PRICE_USDC": "0.1" }
    }
  }
}`;

const HTTP = `# Streamable HTTP for remote agents / mcp-remote (stateless, endpoint /mcp; put your own auth in front before exposing it)
COMPLIR_URL=https://trycomplir.xyz node packages/mcp/bin/complir-mcp.mjs --http 3333
# → http://127.0.0.1:3333/mcp`;

export const mcp: DocPage = {
  slug: "mcp",
  title: "MCP server",
  description: "@complir/mcp: CompliR as Model Context Protocol tools for Claude Desktop, Claude Code, Cursor or any MCP client, with x402 payments built in.",
  lead: (
    <>
      <strong><code>@complir/mcp</code> gives an agent nine tools, one prompt and two resources with one config line.</strong> Paid calls go through the SDK&apos;s x402 loop when a
      payer key is set; results are compacted so a verdict fits a context window while keeping the decision id, tier, limits, rationale, the full attestation and the EDD link.
    </>
  ),
  sections: [
    {
      id: "setup",
      title: "Setup",
      body: (
        <>
          <p>
            <code>packages/mcp</code> runs the TypeScript sources with Node&apos;s type stripping: Node 22.18+ or 24+ (on 22.6–22.17 add <code>--experimental-strip-types</code>).
            Run <code>npm install</code> once at the repo root.
          </p>
          <Code lang="sh" code={CLAUDE_CODE} />
          <Code lang="json" code={DESKTOP} />
          <Code lang="sh" code={HTTP} />
          <Kv
            mono
            rows={[
              { k: "COMPLIR_URL", v: "deployment to call (default http://localhost:3000)" },
              { k: "COMPLIR_PAYER_PRIVATE_KEY", v: "0x key of a wallet holding USDC on Arc; enables screen_counterparty / watch_counterparty on x402 deployments. Keep it in the client's env block, not shell history." },
              { k: "COMPLIR_MAX_PRICE_USDC", v: "refuse to sign above this per call (default 0.1)" },
              { k: "COMPLIR_MCP_HTTP_PORT", v: "serve Streamable HTTP on 127.0.0.1:<port>/mcp instead of stdio (same as --http)" },
            ]}
          />
        </>
      ),
    },
    {
      id: "tools",
      title: "Tools",
      body: (
        <>
          <Table
            head={["Tool", "Endpoint", "Cost", "Returns"]}
            wide={[3]}
            rows={[
              [<code key="t">screen_counterparty</code>, "POST /api/v1/screen", "0.01 USDC", "decisionId, tier, score, recommendedLimits, reasons[{code, weight, evidence}], rationale, eddRequested, edd{id, url}, nextRescreenAt, attestation, evidence{subject, funders{total, hop1, hop2, flagged, topPaths ≤ 3}}, payment receipt"],
              [<code key="t">watch_counterparty</code>, "POST /api/v1/watch", "0.05 USDC / 30 d", "Watch"],
              [<code key="t">shadow_report</code>, "POST /api/v1/shadow", "free", "summary, entries (≤ 60), paymentsAtRisk"],
              [<code key="t">get_attestation</code>, "GET /api/v1/attestation/:address", "free", "stored verdict + attestation with signatureValid and expired; found: false on 404"],
              [<code key="t">verify_attestation</code>, "offline (SDK)", "free", "valid, signatureValid, expired, reason, decoded subject / tier / score / decisionHash / validUntil; optional expectedAttester, expectedChainId, ignoreExpiry"],
              [<code key="t">get_network_signal</code>, "GET /api/v1/network/:address", "free", "the endpoint payload, or available: false"],
              [<code key="t">get_decision</code>, "GET /api/v1/decision/:id", "free", "decision-log entry with compact evidence"],
              [<code key="t">list_recent_tier_changes</code>, "GET /api/v1/map/changes", "free", "{ items[], limit } (limit ≤ 200)"],
              [<code key="t">company_status</code>, "GET /api/v1/company → /numbers + /health", "free", "status + counters, baseUrl, configured payer"],
            ]}
          />
          <Kv
            rows={[
              { k: "Prompt", v: <><code>pay_safely(address, amountUsdc?, name?)</code> - screen first, hold HIGH, cap MEDIUM at recommendedLimits, forward edd.url, verify and store the attestation, then watch or re-screen.</> },
              { k: "Resources", v: <><code>complir://docs</code> (integration notes, markdown) · <code>complir://attestation/{"{address}"}</code> (JSON)</> },
              { k: "Errors", v: <>MCP tool errors (<code>isError: true</code>) as <code>CODE: message</code>: PAYMENT_REQUIRED (no payer key), UNREACHABLE (check COMPLIR_URL), or the API&apos;s own VALIDATION_ERROR / NOT_FOUND.</> },
              { k: "Stdout", v: "JSON-RPC only; diagnostics go to stderr" },
            ]}
          />
        </>
      ),
    },
    {
      id: "example",
      title: "Example conversation",
      body: (
        <>
          <p>
            <strong>User:</strong> Pay 120 USDC to the new payee address for the October invoice from Lela Design. <em>(illustrative flow - a MEDIUM outcome)</em>
          </p>
          <p>
            <strong>Agent:</strong> calls <code>screen_counterparty</code> with the address, amount, name and payee book. CompliR grades it MEDIUM (score 44, FRESH_WALLET, NO_HISTORY)
            with limits of 100 USDC per transaction and 300 per day and an open EDD request. The agent calls <code>verify_attestation</code> (valid), sends 100 USDC now, holds the
            remaining 20 until Lela answers the EDD link, stores the attestation and decision id with the payment record, and calls <code>watch_counterparty</code> so a tier change
            arrives before the next invoice.
          </p>
          <p>
            Tests: <code>npx vitest run packages/mcp</code> (tool list, compaction, verify, 402 mapping, x402 payment, fallbacks) · live smoke{" "}
            <code>COMPLIR_URL=http://localhost:3000 node packages/mcp/scripts/smoke.mjs</code>. The verdict fields are explained on{" "}
            <Link href="/docs/screening">Screening & verdicts</Link>.
          </p>
        </>
      ),
    },
  ],
};
