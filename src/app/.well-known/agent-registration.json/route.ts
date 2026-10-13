/** GET /.well-known/agent-registration.json - ERC-8004 registration metadata (see docs/ERC8004.md). */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";

export async function GET(): Promise<Response> {
  const c = config();
  const file = path.join(process.cwd(), "scripts", "erc8004", "agent.json");
  const raw = await readFile(file, "utf8").catch(() => "{}");
  const body = raw
    .replaceAll("{{PUBLIC_BASE_URL}}", c.PUBLIC_BASE_URL)
    .replaceAll("{{CHAIN_ID}}", String(c.ARC_CHAIN_ID))
    .replaceAll("{{IDENTITY_REGISTRY}}", process.env.ERC8004_IDENTITY_REGISTRY ?? "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432")
    .replaceAll("{{AGENT_ID}}", process.env.ERC8004_AGENT_ID ?? "");
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
}
