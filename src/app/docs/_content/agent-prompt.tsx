import Link from "next/link";
import { Code } from "../_components/Doc";
import { INTEGRATION_PROMPT } from "@/lib/integration/prompt";
import type { DocPage } from "./types";

export const agentPrompt: DocPage = {
  slug: "agent-prompt",
  title: "Integrate with your AI agent",
  description: "A copy-paste prompt that makes your coding agent add CompliR screening to your codebase.",
  lead: (
    <>
      <strong>Copy one prompt into Claude Code, Cursor or Codex and let it wire CompliR into your app.</strong> It finds every place your code sends or
      receives USDC, adds one screening module, applies a clear policy (block HIGH, cap MEDIUM, pass LOW), adds tests, and proves it against a real sanctioned wallet.
    </>
  ),
  sections: [
    {
      id: "prompt",
      title: "The prompt",
      body: (
        <>
          <p>Paste it as-is. The agent reports the money flows it found before it edits anything. The same text is served at <a href="/llms.txt">/llms.txt</a> for tools that read it automatically.</p>
          <Code code={INTEGRATION_PROMPT} lang="prompt" />
        </>
      ),
    },
    {
      id: "what-you-get",
      title: "What you get",
      body: (
        <ul>
          <li>One new module with <code>checkAddress(address, {"{"}amountUsdc, direction{"}"})</code>, called from each payment point in a few lines.</li>
          <li>Env switches: <code>COMPLIR_URL</code> (empty disables it), <code>COMPLIR_FAIL_MODE</code> (open or closed), optional payer key for paid screens.</li>
          <li>The CompliR <code>decisionId</code> stored with each payment, replayable at <Link href="/ledger">/ledger</Link>.</li>
          <li>Tests for block, cap, pass, disabled and outage paths, plus a live check against a real OFAC-listed wallet.</li>
        </ul>
      ),
    },
    {
      id: "where",
      title: "Where it usually goes",
      body: (
        <ul>
          <li><strong>Withdrawals to a user-typed address</strong>: the most important point; block HIGH, cap MEDIUM.</li>
          <li><strong>Payouts</strong> to contractors, vendors, creators: screen the payee before releasing funds.</li>
          <li><strong>Signups</strong> that register a wallet: screen once and watch for changes.</li>
          <li><strong>Inbound x402 or checkout payers</strong>: refuse or refund money from flagged wallets.</li>
        </ul>
      ),
    },
  ],
};
