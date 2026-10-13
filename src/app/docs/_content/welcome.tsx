import Link from "next/link";
import { Addr, Code, Kv, Status } from "../_components/Doc";
import type { DocPage } from "./types";

const QUICK_CURL = `# Screen one payee. Over x402 the first call answers 402 + PAYMENT-REQUIRED; an x402 client
# (the SDK, the MCP server) signs 0.01 USDC and retries. With X402_DISABLED=1 (local dev) it is free.
curl -s -X POST https://complir.example/api/v1/screen \\
  -H 'Content-Type: application/json' \\
  -d '{ "address": "0x000000000000000000000000000000000000dead", "amountUsdc": 120 }' | jq '{tier, score, recommendedLimits}'

# Free: the latest signed attestation for any address
curl -s https://complir.example/api/v1/attestation/0x000000000000000000000000000000000000dead`;

const QUICK_SDK = `import { CompliR } from "@complir/sdk";
import { privateKeyToAccount } from "viem/accounts";

const c = new CompliR({ baseUrl: "https://complir.example", account: privateKeyToAccount(PAYER_KEY) });

const v = await c.screen("0xPayee", { amountUsdc: 120, payeeBook: myPayees }); // 0.01 USDC via x402
if (v.tier === "HIGH") hold();
else pay(Math.min(120, v.recommendedLimits.maxPerTxUsdc));

await CompliR.verifyAttestation(v.attestation); // offline EIP-712 check, no network`;

const QUICK_SOL = `require(ICompliR(registry).isAllowed(payee, ICompliR.Tier.MEDIUM), "CompliR: payee tier too high");`;

export const welcome: DocPage = {
  slug: "welcome",
  title: "Welcome to CompliR",
  description: "What CompliR is, where everything lives, and a quickstart in curl, TypeScript and Solidity.",
  lead: (
    <>
      <strong>CompliR is a counterparty risk oracle for money moving on Arc, run end to end by an agent.</strong> One call before a payment returns a 0–100 score, a tier, a
      spending limit your policy can adopt, every reason with its evidence, and an EIP-712 attestation a contract can check. Then it keeps re-grading the address for as long as
      you watch it.
    </>
  ),
  intro: (
    <>
      <p>
        Every treasury agent checks a denylist once and pays. The list is stale the day it is carved, nobody looks past the first hop, nobody re-grades after onboarding, and no
        verdict can be verified by anyone else. CompliR replaces that single yes/no with a graded, signed, replayable verdict served over HTTP for 0.01 USDC, mirrored to a registry
        on Arc, and logged in a hash chain whose roots are anchored on-chain.
      </p>
      <p>
        The company itself is operated by an agent: it decides sweeps, payouts and prices inside hard guards written in code, signs one decision per tick, and publishes a signed
        daily report. CompliR never holds client funds. It screens; your wallet or contract pays.
      </p>
      <ul>
        <li>
          <strong>Arc</strong> - money that settles in USDC. Chain id 5042, gas paid in USDC, deterministic finality.
        </li>
        <li>
          <strong>CompliR</strong> - the risk layer that money runs on. Deterministic rules score, a guard-railed analyst explains, an attester key signs.
        </li>
        <li>
          <strong>The operator</strong> - a company with no human in the loop. Every action is a ledger entry you can replay.
        </li>
      </ul>
    </>
  ),
  sections: [
    {
      id: "where",
      title: "Where everything lives",
      body: (
        <>
          <Kv
            rows={[
              { k: "Live app", v: <Link href="/">complir - landing</Link> },
              { k: "Console", v: <><Link href="/app">/app</Link> - status, KPIs, decision ticker, today&apos;s operator decision</> },
              { k: "Company", v: <><Link href="/company">/company</Link> - the agent-run company: reserves, obligations, pricing, decisions with reasons</> },
              { k: "Trust Map", v: <><Link href="/map">/map</Link> - Arc mainnet tailed and graded as it moves</> },
              { k: "Guarded Payouts", v: <><Link href="/payouts">/payouts</Link> - a treasury agent paying through <code>GuardedTreasury</code> <Status kind="dry-run">dry-run</Status></> },
              { k: "Ledger", v: <><Link href="/ledger">/ledger</Link> - hash-chained decision log, verify and replay</> },
              { k: "Daily report", v: <><Link href="/report">/report</Link> - signed traction report, one per UTC day</> },
              {
                k: "Registry · Arc 5042",
                v: (
                  <>
                    <Addr note="AttestationRegistry · verified on Sourcify">0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d</Addr>
                    <br />
                    Also published by <a href="/api/v1/health" target="_blank" rel="noopener noreferrer">/api/v1/health</a> as <code>network.registryAddress</code>.
                  </>
                ),
              },
              {
                k: "GuardedTreasury",
                v: (
                  <>
                    <Addr note="GuardedTreasury · live · payouts gated by isAllowed(payee, MEDIUM)">0x5465f31a6155E3eCCcC35f4E5bDC0e287763B0ee</Addr>
                  </>
                ),
              },
              { k: "EIP-712 domain", v: <><Addr>CompliR v1</Addr> <span className="muted">- name <code>CompliR</code>, version <code>1</code>, chainId <code>5042</code>, verifyingContract = registry</span></> },
              { k: "USDC on Arc", v: <Addr note="ERC-20 interface, 6 dp · native gas is USDC">0x3600000000000000000000000000000000000000</Addr> },
              { k: "GitHub", v: <a href="https://github.com/mrnetwork0001/complir" target="_blank" rel="noopener noreferrer">github.com/mrnetwork0001/complir</a> },
              { k: "MCP", v: <><Link href="/docs/mcp"><code>@complir/mcp</code></Link> - <span id="mcp">screen, watch, verify and replay as agent tools</span></> },
              { k: "SDK", v: <><Link href="/docs/sdk"><code>@complir/sdk</code></Link> - TypeScript client with the x402 payment loop built in</> },
            ]}
          />
        </>
      ),
    },
    {
      id: "quickstart",
      title: "Quickstart",
      body: (
        <>
          <p>
            The same verdict, three ways in. Replace <code>https://complir.example</code> with your deployment; the hosted URL is pending and a local <code>npm run dev</code> answers
            on <code>http://localhost:3000</code> with x402 disabled.
          </p>
          <h3>curl</h3>
          <Code lang="sh" code={QUICK_CURL} />
          <h3>TypeScript</h3>
          <Code lang="ts" code={QUICK_SDK} />
          <h3>Solidity</h3>
          <p>
            Copy <code>contracts/src/ICompliR.sol</code> and add one line to your treasury. <code>isAllowed</code> is true only while a non-expired attestation at or below the tier is
            stored in the registry.
          </p>
          <Code lang="solidity" code={QUICK_SOL} />
          <p>
            Next: <Link href="/docs/how-it-works">how a screen runs</Link>, the <Link href="/docs/http-api">endpoint table</Link>, or the <Link href="/docs/mcp">MCP server</Link> for
            agents that pay.
          </p>
        </>
      ),
    },
    {
      id: "status",
      title: "What is live today",
      body: (
        <>
          <p>Everything on this site reads from the same code paths an API client hits. Where a loop is waiting on a key or a deploy, the pages say so and so do these docs.</p>
          <ul>
            <li>
              <strong>Live</strong> - screening, attestations (signed off-chain), watch and webhooks, shadow reports, badge, Trust Map tailer, hash-chained ledger, operator ticks, tip
              market, signed daily report, MCP server and SDK.
            </li>
            <li>
              <strong>Dry-run</strong> - Guarded Payouts (verdicts and ledger are real, transfers simulated), USYC sweep (plans logged), Circle wallets and Gas Station relay
              (reported as dry-run without credentials), auto-refunds without a signer.
            </li>
            <li>
              <strong>Pending</strong> - <code>AttestationRegistry</code> and <code>GuardedTreasury</code> on Arc mainnet, x402 charging (<code>X402_DISABLED=1</code> by default),
              ERC-8004 registration, the hosted URL. The <Link href="/docs/mainnet-checklist">mainnet checklist</Link> lists the exact keys that flip each.
            </li>
          </ul>
        </>
      ),
    },
  ],
};
