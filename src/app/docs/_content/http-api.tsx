import Link from "next/link";
import { Code, Kv, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const ERR = `{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": { … } } }

INVALID_JSON 400 · VALIDATION_ERROR 400 · NOT_FOUND 404 · NOT_IMPLEMENTED 501 · SERVICE_PAUSED 503 · INTERNAL_ERROR 500
x402: PAYMENT_MISCONFIGURED 503 · PAYMENT_VERIFY_UNAVAILABLE 502 · PAYMENT_SETTLE_UNAVAILABLE 502 · PAID_BUT_UNDELIVERED 502
Every response carries X-CompliR-Version: v1 and Cache-Control: no-store (badge, map and company set their own max-age).`;

const free = <span className="badge badgeLOW">free</span>;
const price = (p: string) => <strong>{p}</strong>;

export const httpApi: DocPage = {
  slug: "http-api",
  title: "HTTP API",
  description: "Every public endpoint with its price and auth, the error shape, and the x402 headers and status codes.",
  lead: (
    <>
      <strong>Two endpoints are paid, everything else is free and public; there are no API keys.</strong> Paid calls are settled per request over x402 with Circle&apos;s
      facilitator on Arc. Internal ticks are protected by a bearer secret and are listed so you can run them yourself.
    </>
  ),
  sections: [
    {
      id: "endpoints",
      title: "Endpoints",
      body: (
        <>
          <Table
            head={["Method", "Path", "Price", "What it does"]}
            wide={[3]}
            rows={[
              [<code key="m">POST</code>, <code key="p">/api/v1/screen</code>, price("0.01 USDC"), "Full grade of one address (+ name, amountUsdc, payeeBook, clientId, depth). Verdict + signed attestation. Header X-CompliR-Decision-Id. Same-origin browser calls are free."],
              [<code key="m">POST</code>, <code key="p">/api/v1/watch</code>, price("0.05 USDC / 30 d"), "Register address + webhookUrl (+ clientId, payeeBook). Adaptive re-screening; tier.changed webhooks. Header X-CompliR-Watch-Id. Settled after the handler succeeds."],
              [<code key="m">POST</code>, <code key="p">/api/v1/tips</code>, price("0.05 USDC stake"), "Submit a staked tip about an address. Settled first; same-origin creates a demo tip."],
              [<code key="m">POST</code>, <code key="p">/api/v1/shadow</code>, free, "Payee book + recent payments → wouldHold / wouldLimit / lookalikes / paymentsAtRisk. ≤ 50 addresses, 4 in flight, depth 1."],
              [<code key="m">GET</code>, <code key="p">/api/v1/attestation/:address</code>, free, "Latest stored verdict + attestation (source: store); screens once if never seen (source: fresh)."],
              [<code key="m">GET</code>, <code key="p">/api/v1/badge/:address.svg</code>, free, "Screened-by-CompliR SVG from the store; grey unknown / expired; Cache-Control max-age=60."],
              [<code key="m">GET</code>, <code key="p">/api/v1/decision/:id</code>, free, "One replayable decision-log entry: payload, prevHash, hash, anchorTx."],
              [<code key="m">GET</code>, <code key="p">/api/v1/ledger?limit=50</code>, free, "Most recent ledger entries, newest first."],
              [<code key="m">GET</code>, <code key="p">/api/v1/ledger/verify</code>, free, "Re-walks the hash chain; { ok, brokenAt, length }."],
              [<code key="m">GET</code>, <code key="p">/api/v1/network/:address</code>, free, "Anonymised network signal: heldElsewhere, concentrationHint, recent blocklist events."],
              [<code key="m">GET</code>, <code key="p">/api/v1/network/events?limit=50</code>, free, "Last USDC blocklist events the reactor saw and what it did."],
              [<code key="m">GET</code>, <code key="p">/api/v1/map?limit=150</code>, free, "Trust Map snapshot: nodes, edges, header stats; cached 10 s."],
              [<code key="m">GET</code>, <code key="p">/api/v1/map/changes?limit=</code>, free, "Recent tier changes from the Trust Map tailer (≤ 200)."],
              [<code key="m">GET</code>, <code key="p">/api/v1/map/:address</code>, free, "One Trust Map node with its edges."],
              [<code key="m">GET</code>, <code key="p">/api/v1/feed?limit=25</code>, free, "Anonymised recent screenings (masked addresses)."],
              [<code key="m">GET</code>, <code key="p">/api/v1/numbers</code>, free, "Public counters; own wallets and internal client ids excluded."],
              [<code key="m">GET</code>, <code key="p">/api/v1/company</code>, free, "Company snapshot + last ten operator decisions; cached 30 s."],
              [<code key="m">GET</code>, <code key="p">/api/v1/payouts</code>, free, "Invoices, totals, mode, policy and missingForLive. POST adds a demo invoice (same-origin only)."],
              [<code key="m">GET</code>, <code key="p">/api/v1/report</code>, free, "Latest signed daily report (+ archive); ?format=md. /api/v1/report/:date[.md] for one day; 404 until the first report."],
              [<code key="m">GET</code>, <code key="p">/api/v1/tips · /api/v1/tips/:id</code>, free, "Tip market totals, leaderboard, items (anonymised) · one tip."],
              [<code key="m">GET</code>, <code key="p">/api/v1/edd/:id</code>, free, "Public view of an EDD request: questions, status, re-screen outcome. Never the answers."],
              [<code key="m">POST</code>, <code key="p">/api/v1/edd/:id/answer</code>, free, "The counterparty answers once; answers stored privately, keccak logged, subject re-screened. Second submission → 409."],
              [<code key="m">GET</code>, <code key="p">/api/v1/health</code>, free, "Liveness, chain id, explorer URL, USDC and registry addresses, x402 prices, signer mode, demo addresses."],
            ]}
          />
          <p>
            Prices are the operator&apos;s current prices (<Link href="/docs/operator">bounds</Link>), read per request; <code>/api/v1/health</code> reports the config defaults.
            With <code>X402_DISABLED=1</code> (this deployment today) every endpoint is free and responses carry <code>X-CompliR-Payment: disabled</code>.
          </p>
        </>
      ),
    },
    {
      id: "internal",
      title: "Internal ticks",
      body: (
        <>
          <p>
            <code>POST|GET /api/internal/&lt;worker&gt;</code> with <code>Authorization: Bearer $CRON_SECRET</code> runs one tick and returns its summary. Vercel crons call these
            (see <Link href="/docs/self-hosting">Self-hosting</Link>); the <code>worker/*.ts</code> loops call the same functions.
          </p>
          <Kv
            mono
            rows={[
              { k: "watcher", v: "due re-screens + webhooks + anchor-if-due" },
              { k: "trustmap", v: "tail Arc, grade recipients ≥ 25 USDC" },
              { k: "treasury", v: "guarded payouts tick" },
              { k: "operator", v: "one operator decision" },
              { k: "events", v: "blocklist reactor tick · POST { simulate } = drill" },
              { k: "refunds", v: "process the refund queue · POST manual refund / requeue" },
              { k: "tips", v: "verify + pay tips · POST { review, decision } human override" },
              { k: "usyc", v: "revenue sweep plan (dry-run unless USYC_MODE=live)" },
              { k: "report", v: "generate + sign a daily report (?date=, &force=1)" },
              { k: "circle", v: "Circle wallet status · POST { provision: true }" },
            ]}
          />
        </>
      ),
    },
    {
      id: "errors",
      title: "Error shape",
      body: <Code lang="json" code={ERR} />,
    },
    {
      id: "x402-headers",
      title: "x402 headers and statuses",
      body: (
        <>
          <Table
            head={["Header", "Direction", "Meaning"]}
            wide={[2]}
            rows={[
              [<code key="h">PAYMENT-REQUIRED</code>, "response (402)", "base64 PaymentRequired: { x402Version: 2, error?, resource, accepts: [requirements] }; the same object is the JSON body"],
              [<code key="h">PAYMENT-SIGNATURE</code>, "request", "base64 PaymentPayload: { x402Version: 2, resource, accepted, payload: { signature, authorization } }. X-PAYMENT is accepted as a v1-named alias (payload must still be v2)."],
              [<code key="h">PAYMENT-RESPONSE</code>, "response", "base64 settle receipt: { success, transaction, network, payer, amount, errorReason? }. Mirrored as X-PAYMENT-RESPONSE."],
              [<code key="h">X-CompliR-Payment</code>, "response", "CompliR's one-word state: disabled · required · settled · replay · retry · pending · settle-failed · verify-unavailable · settle-unavailable · not-charged · refund-queued"],
            ]}
          />
          <Table
            head={["Status", "X-CompliR-Payment", "When"]}
            wide={[2]}
            rows={[
              ["402", "required", "no PAYMENT-SIGNATURE, bad payload, wrong x402Version, requirements mismatch (scheme, network, asset, payTo, amount, validity), or facilitator /verify said invalid"],
              ["402", "pending", "settlement_pending after status polls; retry with the SAME signed authorization to converge on the one payment"],
              ["402", "settle-failed", "facilitator reported a failed settlement; not charged"],
              ["200", "settled", "paid and delivered; receipt in PAYMENT-RESPONSE"],
              ["200", "replay", "same nonce within 5 min after a settled payment: cached response, no second settle"],
              ["200", "retry", "same nonce while the first attempt is still in flight"],
              ["4xx", "not-charged", "the handler refused (validation, paused) before settlement"],
              ["500", "not-charged", "handler threw before settlement"],
              ["502", "verify-unavailable", "facilitator /verify unreachable; no charge"],
              ["502", "settle-unavailable", "facilitator /settle unreachable after the handler ran; retry with the same authorization, you will not be charged twice"],
              ["502", "refund-queued", "settled but undelivered: PAID_BUT_UNDELIVERED, refund queued to the payer"],
              ["503", "-", "PAYMENT_MISCONFIGURED: x402 enabled but X402_PAY_TO / facilitator URL missing; no charge"],
            ]}
          />
          <p>
            Full flow, requirements and the facilitator in <Link href="/docs/x402">x402 payments</Link>.
          </p>
        </>
      ),
    },
  ],
};
