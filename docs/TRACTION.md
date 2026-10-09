# CompliR — Traction Log (honest, verifiable)

Rules we hold ourselves to (borrowed from APEX's "no notes" update):
- Own wallets are **excluded** from every count and **listed** in every report (`OWN_WALLETS` + the internal client ids).
- Every outside payer is listed with address + tx link.
- Mistakes and refunds are listed, not hidden — and refunds are automatic (below).

## The report is written and signed by the agent, daily

There is no hand-maintained table any more. Once per UTC day the agent generates the report from its own database,
hashes it, signs it with the attester key and appends a `REPORT` entry to the hash-chained ledger:

| Where | What |
|---|---|
| [`/report`](/report) | Rendered latest report, "Copy markdown" (what we paste into Discord `#share-your-traction`), signature, archive |
| `GET /api/v1/report` | Latest report as JSON (`?format=md` for markdown) + archive list |
| `GET /api/v1/report/<date>` · `/api/v1/report/<date>.md` | One day, JSON or markdown. `latest` is an alias |
| `POST /api/internal/report?date=yesterday` | Generate + sign + store (Bearer `CRON_SECRET`; `date=today`, `YYYY-MM-DD`; `&force=1` regenerates) |
| `worker/report.ts` | Long-running: publishes the previous UTC day at **00:05 UTC**, back-fills on start, drains the refund queue every 5 min |

What every report contains: period · outside payers (address, calls, USDC net of refunds, first tx link, endpoints) ·
own wallets + internal client ids excluded (listed, with how much was excluded) · screenings by tier · watches new/active ·
tier changes · payouts paid/limited/held · refunds (status, original tx, refund tx) · mistakes · integration PRs ·
caveats ("numbers are self-reported; verify via tx links") · ledger head at generation time.

Verify a report: `hash = keccak256(canonical(report JSON))` (sorted keys, no whitespace — `src/lib/attest/canonical.ts`),
`signature` = EIP-191 `personal_sign` by the attester over the hash string. With viem:
`verifyMessage({ address: signer, message: hash, signature })`. The `REPORT` ledger entry (`/log/<ledgerId>`) carries the
same hash and is Merkle-anchored on Arc with the rest of the chain.

## Adding notes, mistakes and PR status: `.data/report-notes.json`

The agent reads this file (override the path with `REPORT_NOTES_PATH`) every time it generates a report. Append to it;
regenerate with `POST /api/internal/report?date=<date>&force=1` if the day was already published.

```json
{
  "notes": [
    { "date": "2026-10-13", "text": "Shadow report delivered to Steward (DM)." }
  ],
  "mistakes": [
    { "date": "2026-10-13", "what": "Charged 0.01 USDC for a screen that 500'd (RPC timeout). Auto-refunded.", "refundTx": "0x…" }
  ],
  "integrations": {
    "steward":    { "repo": "big14way/steward",        "status": "opened", "pr": "https://github.com/big14way/steward/pull/1" },
    "vestiarion": { "repo": "duongnq2798/vestiarion", "status": "prepared, not submitted" },
    "ceedebooks": { "repo": "MusaAis/CeedeBooks",     "status": "merged", "pr": "https://github.com/MusaAis/CeedeBooks/pull/7" }
  }
}
```

- `notes[]` / `mistakes[]`: entries with a `date` appear on that day's report only; entries without one appear on every report.
- `integrations`: keyed by the folder name under `docs/integrations/` (every folder with a `NOTES.md` is listed automatically with
  status "prepared, not submitted" until you set one here). Unknown keys are listed too.
- Refunds come from the `refunds` table automatically; `mistakes` is for anything the refund system could not see.

## Automatic refunds

Every x402 payment that settled but was not honoured (handler threw / non-2xx after settlement, client disconnected before
the response, response could not be built) is queued by `src/lib/pay/x402.ts` → `src/lib/refunds` and sent back on Arc
right away: Circle `revenue` wallet when Circle is configured, else a local `REFUND_PRIVATE_KEY` / `REVENUE_PRIVATE_KEY`
ERC-20 transfer, else **DRY_RUN** (recorded, still owed, shown in the report until a signer exists). Each outcome is a
`REFUND` ledger entry; the original `payments` row is marked `refunded`. Daily cap `REFUND_DAILY_CAP_USDC` (default 5):
beyond it refunds stay QUEUED and are flagged.

Human-initiated refund: `POST /api/internal/refunds` with `{ "payer": "0x…", "amountUsdc": 0.01, "reason": "…", "originalTx": "0x…" }`
(Bearer `CRON_SECRET`). `GET /api/internal/refunds` ticks the queue and lists everything; `{ "requeue": "ref_…" }` retries a DRY_RUN/FAILED one.
