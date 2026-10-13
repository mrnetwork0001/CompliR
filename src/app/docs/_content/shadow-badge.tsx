import Link from "next/link";
import { Code, Kv } from "../_components/Doc";
import type { DocPage } from "./types";

const SHADOW_REQ = `POST /api/v1/shadow                         # free during the event
{
  "payeeBook": [
    { "label": "Lela Design",               "address": "0x000000000000000000000000000000000000cafe" },
    { "label": "Lela Design (new invoice)", "address": "0x0000a1b2c3d4e5f60718293a4b5c6d7e8f90cafe" }
  ],
  "recentPayments": [{ "to": "0x0000a1b2c3d4e5f60718293a4b5c6d7e8f90cafe", "amountUsdc": 80, "txHash": "0x…" }]
}

→ 200
{
  "entries": [{ "label", "address", "score", "tier", "reasonCodes": ["LOOKALIKE_OF_KNOWN_PAYEE", …], "wouldHold", "wouldLimit" }, …],
  "summary": { "screened": 2, "wouldHold": 0, "wouldLimit": 1, "lookalikes": 1 },
  "paymentsAtRisk": [{ "to": "0x0000a1b2…cafe", "amountUsdc": 80, "txHash": "0x…" }]
}`;

const BADGE = `<!-- Markdown -->
[![Screened by CompliR](https://complir.example/api/v1/badge/0xPayee.svg)](https://complir.example/api/v1/attestation/0xPayee)

<!-- HTML -->
<a href="https://complir.example/api/v1/attestation/0xPayee">
  <img src="https://complir.example/api/v1/badge/0xPayee.svg" alt="Screened by CompliR" height="20">
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
              { k: "lookalikes", v: "LOOKALIKE_OF_KNOWN_PAYEE hits against your own book (same first and last four hex characters, or ≥ 0.8 similarity)" },
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
