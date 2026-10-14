/** GET /llms.txt - machine-readable integration guide for AI coding agents (same text as /docs/agent-prompt). */
import { INTEGRATION_PROMPT } from "@/lib/integration/prompt";

export const dynamic = "force-static";
export function GET(): Response {
  const head = "# CompliR\n\n> Counterparty-risk oracle for USDC on Arc mainnet. Signed, graded verdicts before money moves.\n\n## Integration prompt\n\n";
  return new Response(head + INTEGRATION_PROMPT + "\n", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
