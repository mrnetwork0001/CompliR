import Link from "next/link";
import { Code, Kv, Note } from "../_components/Doc";
import type { DocPage } from "./types";

const CHECK = `POST /api/v1/check                       # free · same-origin unmetered · 20/min per IP otherwise
{ "address": "0x098b716b8aaf21512996dc57eb0615e2383e2f96", "source": "address" }   // source: address | link | invoice; name?, amountUsdc?, full?

→ 200
{
  "address": "0x098b…2f96", "tier": "HIGH", "score": 100,
  "headline": "Don't pay.",
  "advice": "This wallet is on the OFAC sanctions list and Circle has blocked it on USDC.",
  "limits": { "maxPerTxUsdc": 0, "maxPerDayUsdc": 0 },
  "reasons": ["SANCTIONS_DIRECT", "USDC_BLACKLISTED"],        // strongest first, CLEAN omitted
  "decisionId": "dec_…", "attestation": { … }, "screenedAt": "…",
  "shareUrl": "https://trycomplir.xyz/a/0x098b716b8aaf21512996dc57eb0615e2383e2f96"
}`;

const HISTORY = `GET /api/v1/address/0x098b716b8aaf21512996dc57eb0615e2383e2f96        # free · never runs the pipeline
{
  "address": "0x098b…2f96",
  "latest": { "decisionId", "tier", "score", "screenedAt", "headline", "attester", "registryTx", "validUntil", "expired" },
  "verdicts": [ { "decisionId", "screenedAt", "tier", "score", "reasonCodes", "requester": "own|outside|unknown", "attester", "registryTx", "validUntil", "tierChanged" }, … ],
  "tierChanges": [ { "at", "from", "to", "decisionId", "via": "verdict|watch" } ],
  "openEdd": [ { "id", "url", "createdAt", "questions" } ],
  "counts": { "verdicts", "high", "medium", "low", "outsideRequests" },
  "firstSeenAt", "anonymised": true, "generatedAt"
}`;

export const checkPages: DocPage = {
  slug: "check-pages",
  title: "Check & address pages",
  description: "The consumer face: /check turns an address, a payment link or an invoice PDF into a plain-language verdict, and /a/<address> is the public, shareable history of every verdict for that address.",
  lead: (
    <>
      <strong>Most people who need the oracle are not integrators; they are about to pay someone.</strong> <Link href="/check">/check</Link> takes whatever they have
      (an address, an EIP-681 or CompliR payment link, an invoice PDF), runs the same pipeline every API client gets, and answers in three sentences. The answer lives at{" "}
      <code>/a/&lt;address&gt;</code>, a public page anyone can open, share and re-check.
    </>
  ),
  sections: [
    {
      id: "plain-language",
      title: "Plain-language rules",
      body: (
        <>
          <p>The headline comes from the tier, the advice from the strongest one or two reasons. No model is involved; the mapping is deterministic and tested.</p>
          <Kv
            rows={[
              { k: "HIGH", v: <>“Don&apos;t pay.” + the top reasons, e.g. “This wallet is on the OFAC sanctions list and Circle has blocked it on USDC.” (SANCTIONS_DIRECT + USDC_BLACKLISTED merge into one sentence)</> },
              { k: "MEDIUM", v: <>“Pay up to <i>N</i> USDC.” where <i>N</i> is the analyst&apos;s <code>maxPerTxUsdc</code>, + the top reasons, e.g. “Its funders two hops back include a sanctioned wallet.”</> },
              { k: "LOW", v: <>“Safe to pay.” + “No sanctions, no blocklist, normal history.” or the mild reasons seen, followed by “Nothing serious.”</> },
              { k: "Ranking", v: "reasons sorted by weight, CLEAN never counts; the sanctions list is named OFAC when a hit's datasets include an OFAC/SDN source, otherwise “a sanctions list”" },
            ]}
          />
        </>
      ),
    },
    {
      id: "inputs",
      title: "Inputs: address, link, invoice",
      body: (
        <>
          <Kv
            rows={[
              { k: "Address", v: "0x + 40 hex characters; lowercased" },
              { k: "Payment link", v: <>EIP-681 <code>ethereum:0x…@5042?value=…</code> (native) or <code>ethereum:&lt;token&gt;@5042/transfer?address=0x…&amp;uint256=…</code> (ERC-20: recipient from <code>address=</code>, amount from <code>uint256=</code> at 6 dp); a CompliR <code>https://…/pay/&lt;id&gt;</code> link (address from the query/path, else the id is resolved via <code>/api/v1/pay/&lt;id&gt;</code> when that module answers); any URL carrying an address in path, query or hash</> },
              { k: "Invoice (PDF)", v: <><code>POST /api/v1/check/invoice</code> (multipart <code>file</code>, ≤ 5 MB, ≤ 20 pages) extracts the text server-side and returns every address, a best-effort vendor name (a “From:” / “Vendor:” / “Payee:” line, else the first name-like line) and the total. Nothing is stored. The browser keeps a vendor → address list in <code>localStorage</code>; the same vendor with a different address raises “Address changed”.</> },
            ]}
          />
          <Code lang="http" code={CHECK} />
          <p>
            Checks run under the internal client id <code>check</code>, so they are attested and ledgered like any screen but never counted as outside traction. Pass{" "}
            <code>full: true</code> to also receive the complete <code>verdict</code> (evidence, funder graph, rationale); the developer view on the address page does.
          </p>
        </>
      ),
    },
    {
      id: "address-page",
      title: "Address page & history",
      body: (
        <>
          <p>
            <code>/a/&lt;address&gt;</code> shows the latest headline, advice, limits and tier chip; counters; guarantee / bond and inbound CCTP flags when another module attached them;
            open due diligence; the network signal from <code>/api/v1/network/&lt;address&gt;</code>; then every verdict ever issued (date, tier, score, who asked as a class, attester,
            registry transaction), tier changes, and a collapsible developer view with the full <code>VerdictView</code>. “Re-check now” runs a fresh same-origin check and refreshes the page.
          </p>
          <Code lang="http" code={HISTORY} />
          <Note>
            Requesters are shown as <code>own</code> (CompliR&apos;s own UI and workers), <code>outside</code> (a paying integrator) or <code>unknown</code>; a client id never leaves the store.
            The former <code>/explorer</code> redirects here: <code>/explorer</code> → <code>/check</code>, <code>/explorer?address=0x…</code> → <code>/a/0x…</code>.
          </Note>
        </>
      ),
    },
  ],
};
