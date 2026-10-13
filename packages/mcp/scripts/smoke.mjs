#!/usr/bin/env node
/**
 * Live smoke: spawn the stdio server, list tools, screen one address, read the docs resource.
 *   COMPLIR_URL=http://localhost:3000 node packages/mcp/scripts/smoke.mjs [address]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "bin", "complir-mcp.mjs");
const address = process.argv[2] ?? "0x000000000000000000000000000000000000dead";

const transport = new StdioClientTransport({ command: process.execPath, args: [bin], env: { ...process.env }, stderr: "inherit" });
const client = new Client({ name: "complir-smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools/list:", tools.tools.map((t) => t.name).join(", "));

const prompts = await client.listPrompts();
console.log("prompts/list:", prompts.prompts.map((p) => p.name).join(", "));

const docs = await client.readResource({ uri: "complir://docs" });
console.log("resources/read complir://docs:", `${docs.contents[0].text.split("\n")[0]} (${docs.contents[0].text.length} chars)`);

const t0 = Date.now();
const res = await client.callTool({ name: "screen_counterparty", arguments: { address, amountUsdc: 25 } });
const text = res.content.find((c) => c.type === "text")?.text ?? "";
console.log(`tools/call screen_counterparty (${Date.now() - t0} ms, isError=${Boolean(res.isError)}, ${text.length} chars):`);
try {
  const v = JSON.parse(text);
  console.log(JSON.stringify({ decisionId: v.decisionId, tier: v.tier, score: v.score, recommendedLimits: v.recommendedLimits, reasons: v.reasons?.map((r) => r.code), edd: v.edd, signature: v.attestation?.signature?.slice(0, 20) + "…", funders: v.evidence?.funders && { total: v.evidence.funders.total, flagged: v.evidence.funders.flagged, topPaths: v.evidence.funders.topPaths.length } }, null, 2));
} catch {
  console.log(text);
}

await client.close();
