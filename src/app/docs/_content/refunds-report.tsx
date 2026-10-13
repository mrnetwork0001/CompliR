import Link from "next/link";
import { Code, Kv, Status } from "../_components/Doc";
import type { DocPage } from "./types";

const REFUND_ERR = `HTTP/1.1 502
X-CompliR-Payment: refund-queued
PAYMENT-RESPONSE: <base64 settle receipt>

{ "error": { "code": "PAID_BUT_UNDELIVERED",
             "message": "Payment settled (0x…) but the response could not be delivered: handler error: … A refund of 0.01 USDC to 0x… has been queued; see /report." } }`;

const MANUAL = `# Human-initiated refund (Bearer CRON_SECRET)
curl -s -X POST https://complir.example/api/internal/refunds -H "Authorization: Bearer $CRON_SECRET" \\
  -H 'content-type: application/json' -d '{ "payer": "0x…", "amountUsdc": 0.01, "reason": "…", "originalTx": "0x…" }'
# tick the queue + list everything          GET  /api/internal/refunds
# retry a DRY_RUN / FAILED row              POST /api/internal/refunds { "requeue": "ref_…" }`;

const NOTES = `// .data/report-notes.json (REPORT_NOTES_PATH) — read every time a report is generated
{
  "notes":    [{ "date": "2026-10-13", "text": "Shadow report delivered to Steward (DM)." }],
  "mistakes": [{ "date": "2026-10-13", "what": "Charged 0.01 USDC for a screen that 500'd (RPC timeout). Auto-refunded.", "refundTx": "0x…" }],
  "integrations": { "steward": { "repo": "big14way/steward", "status": "opened", "pr": "https://github.com/big14way/steward/pull/1" } }
}`;

export const refundsReport: DocPage = {
  slug: "refunds-report",
  title: "Refunds & daily report",
  description: "Automatic on-chain refunds for settled-but-undelivered calls, and the signed daily traction report the agent writes.",
  lead: (
    <>
      <strong>If CompliR charged you and did not deliver, the refund is queued before you see the error.</strong> And once a day the agent writes its own traction report from the
      database, excludes its own wallets, lists every refund and mistake, hashes it, signs it and appends it to the ledger.
    </>
  ),
  sections: [
    {
      id: "refunds",
      title: "Automatic refunds",
      body: (
        <>
          <p>
            Once the facilitator&apos;s <code>/settle</code> succeeds the payer has been charged. If the paid handler then throws or returns non-2xx (possible only with{" "}
            <code>settleFirst</code>, as on the tip stake), the client disconnects before the response, or the response cannot be built, the x402 gate calls the refund sink and
            returns:
          </p>
          <Code lang="http" code={REFUND_ERR} />
          <Kv
            rows={[
              { k: "Queue", v: "refunds table, idempotent per original tx; statuses QUEUED → SENT | FAILED (after REFUND_MAX_ATTEMPTS = 3) | DRY_RUN" },
              { k: "Signer", v: "Circle revenue wallet when configured → REFUND_PRIVATE_KEY or REVENUE_PRIVATE_KEY ERC-20 transfer → otherwise DRY_RUN: recorded, still owed, listed in the report until a signer exists" },
              { k: "Cap", v: "REFUND_DAILY_CAP_USDC (5): beyond it rows stay QUEUED with note OVER_DAILY_CAP until a human raises the cap or the day rolls over" },
              { k: "Ledger", v: "each outcome is a REFUND entry; the original payments row is marked refunded and excluded from revenue" },
              { k: "Schedule", v: "cron every 10 min (/api/internal/refunds) · worker/report.ts drains the queue every 5 min · REFUND_AUTO_PROCESS=1" },
              { k: "Today", v: <><Status kind="dry-run">dry-run</Status> no refund signer is configured on this deployment</> },
            ]}
          />
          <Code lang="sh" code={MANUAL} />
        </>
      ),
    },
    {
      id: "report",
      title: "The signed daily report",
      body: (
        <>
          <p>
            There is no hand-maintained traction table. At 00:05 UTC (<code>/api/internal/report</code> cron, or <code>worker/report.ts</code> which also back-fills on start) the
            agent generates the previous day from its own database, renders Markdown, hashes the JSON, signs the hash with the attester key and appends a <code>REPORT</code> ledger
            entry. Rendered at <Link href="/report">/report</Link> with a &quot;Copy markdown&quot; button for the Discord traction channel.
          </p>
          <Kv
            rows={[
              { k: "Contains", v: "period · outside payers (address, calls, USDC net of refunds, first tx link, endpoints) · excluded own wallets + internal client ids with how much was excluded · screenings by tier · watches new/active · tier changes · payouts paid/limited/held · refunds (status, original tx, refund tx) · mistakes · integration PRs · caveats · ledger head" },
              { k: "Excluded", v: "OWN_WALLETS and the internal client ids web-explorer, trustmap, treasury-agent, edd, watcher, smoke, shadow, events, tips, operator, report" },
              { k: "Endpoints", v: <><code>GET /api/v1/report</code> (latest, <code>?format=md</code>) · <code>GET /api/v1/report/&lt;date&gt;</code> and <code>.md</code> · <code>POST /api/internal/report?date=yesterday|today|YYYY-MM-DD&amp;force=1</code></> },
              { k: "Caveat line", v: "“numbers are self-reported; verify via tx links” is part of every report" },
            ]}
          />
          <Code lang="json" code={NOTES} />
          <p>
            Entries with a <code>date</code> appear on that day only; entries without one appear on every report. Every folder under <code>docs/integrations/</code> with a{" "}
            <code>NOTES.md</code> is listed automatically as &quot;prepared, not submitted&quot; until a status is set. How to verify a report&apos;s signature:{" "}
            <Link href="/docs/ledger-reports">Ledger & reports</Link>.
          </p>
        </>
      ),
    },
  ],
};
