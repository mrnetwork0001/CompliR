import Link from "next/link";
import { Code, Kv } from "../_components/Doc";
import type { DocPage } from "./types";

const SHADOW_REQ = `POST /api/v1/shadow                         # free during the event
{
  "payeeBook": [                                   // the same book /shadow offers as its example - all real addresses
    { "label": "Ronin Bridge exploiter (Lazarus Group - sanctioned)", "address": "0x098b716b8aaf21512996dc57eb0615e2383e2f96" },
    { "label": "CompliR treasury wallet",                            "address": "0xc742ada2872a042dd36d2e706907b4036968960c" },
    { "label": "GuardedTreasury contract",                           "address": "0x3b13186a1e4b1108ea5cb2f8853d84a2aed71cc5" },
    { "label": "CompliR treasury wallet (new invoice - lookalike)",  "address": "0xc7420000000000000000000000000000000a960c" }
  ],
  "recentPayments": [
    { "to": "0x098b716b8aaf21512996dc57eb0615e2383e2f96", "amountUsdc": 150 },
    { "to": "0xc742ada2872a042dd36d2e706907b4036968960c", "amountUsdc": 10 }
  ]
}

→ 200
{
  "entries": [{ "label", "address", "score", "tier", "reasonCodes": ["SANCTIONS_DIRECT", "USDC_BLACKLISTED", …], "wouldHold", "wouldLimit" }, …],
  "summary": { "screened": 4, "wouldHold": …, "wouldLimit": …, "lookalikes": … },   // whatever the live pipeline returns today
  "paymentsAtRisk": [{ "to": "0x098b…2f96", "amountUsdc": 150 }]                      // the 150 USDC to the sanctioned wallet
}`;

const BADGE = `<!-- Markdown -->
[![Screened by CompliR](https://trycomplir.xyz/api/v1/badge/0xPayee.svg)](https://trycomplir.xyz/api/v1/attestation/0xPayee)

<!-- HTML -->
<a href="https://trycomplir.xyz/api/v1/attestation/0xPayee">
  <img src="https://trycomplir.xyz/api/v1/badge/0xPayee.svg" alt="Screened by CompliR" height="20">
</a>`;

export const shadowBadge: DocPage = {
  slug: "shadow-badge",
  title: "Shadow report & badge",
  description: "The shadow report that grades an existing payee book, and the SVG badge that links any address to its live attestation.",
  lead: (
    <>
      <strong>Shadow mode answers one question for a sceptic: what would CompliR have held that you already paid?</strong> Paste a payee book and recent payments, get the holds,
      limits, lookalikes and payments at risk. The badge is the other way round: one image that says an address was screened and links to the proof.
    </>
  ),
  sections: [
    {
      id: "shadow",
      title: "Shadow report",
      body: (
        <>
          <Code lang="http" code={SHADOW_REQ} />
          <Kv
            rows={[
              { k: "Input", v: "payeeBook 1–500 entries (label, address) · recentPayments ≤ 1,000 (to, amountUsdc, txHash?)" },
              { k: "Targets", v: "book addresses first, then payment recipients not in the book; de-duplicated; at most 50 unique addresses screened, 4 in flight, depth 1" },
              { k: "wouldHold", v: "tier HIGH" },
              { k: "wouldLimit", v: "tier MEDIUM" },
              { k: "lookalikes", v: "LOOKALIKE_OF_KNOWN_PAYEE hits against your own book (same first and last four hex characters, or ≥ 0.8 similarity); the example book carries one lookalike of our own treasury wallet" },
              { k: "paymentsAtRisk", v: "every recent payment whose recipient is not LOW" },
              { k: "Page", v: <><Link href="/shadow">/shadow</Link> accepts CSV <code>label,address</code> or JSON lines and has “Copy report as Markdown” for a Discord paste</> },
            ]}
          />
          <p>
            Shadow screens go through the real pipeline (attested, ledgered) under the internal client id <code>shadow</code>, so they never count as traction. The MCP tool{" "}
            <code>shadow_report</code> wraps the same endpoint.
          </p>
        </>
      ),
    },
    {
      id: "badge",
      title: "Badge",
      body: (
        <>
          <p>
            <code>GET /api/v1/badge/:address.svg</code> renders &quot;Screened by CompliR · TIER · valid until &lt;date&gt;&quot; from the latest stored attestation. It never runs the
            pipeline: an address that was never screened gets a grey &quot;unknown&quot; badge; an attestation past <code>validUntil</code> reads &quot;expired&quot;. Responses carry{" "}
            <code>Cache-Control: max-age=60</code> so receipts and READMEs can hot-link it. Build a snippet at <Link href="/badge">/badge</Link>.
          </p>
          <Code lang="html" code={BADGE} />
          <p>
            Link the badge to <code>/api/v1/attestation/:address</code> so a reader can verify the EIP-712 signature behind it rather than trust the picture.
          </p>
        </>
      ),
    },
  ],
};
