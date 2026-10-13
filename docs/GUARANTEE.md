# Guarantee: a bond on LOW verdicts

CompliR puts a little of its own money behind a clean verdict. When you screen an address **with an
amount** (`amountUsdc`) and the verdict is **LOW**, the response carries a `guarantee`:

```json
{
  "tier": "LOW",
  "decisionId": "dec_…",
  "guarantee": {
    "bondUsdc": 0.5,
    "until": "2026-11-12T22:16:51.000Z",
    "terms": "If CompliR re-grades 0x… to HIGH before 2026-11-12T22:16:51.000Z, the payer of this screen can claim 0.5 USDC back (POST /api/v1/guarantee/claim). The bond is paid from CompliR revenue on Arc, is capped, and is not insurance: it does not cover your payment to the subject."
  }
}
```

## The terms, in plain words

- **What is promised.** If the same address is re-screened by CompliR and comes back **HIGH** before
  `until` (30 days after the screen, `GUARANTEE_DAYS`), the payer of the original screen can claim
  `bondUsdc` back. The bond is a refund of CompliR's own money, sent on Arc in USDC.
- **How big the bond is.** The smallest of:
  - `GUARANTEE_MAX_BOND_USDC` (default **0.5 USDC**),
  - **10 %** of the `amountUsdc` you said you were about to pay,
  - **25 %** of the USDC currently in CompliR's revenue wallet (read live with `balanceOf`).
  If the revenue balance cannot be read, or is zero, there is **no guarantee** on that verdict
  (`guarantee: null`). MEDIUM and HIGH verdicts never carry one, nor do screens without an amount.
- **Who can claim.** The payer of the screen: the `clientId` the request was made with, the x402
  payer address recorded for that screen, or (for the hosted demo page) a same-origin browser naming a
  payer address. Anyone else gets `403 CLAIMANT_MISMATCH`.
- **How to claim.**
  ```
  POST /api/v1/guarantee/claim
  { "decisionId": "dec_…", "payerAddress": "0x…" }
  ```
  CompliR re-screens the subject right then (a `RESCREEN` entry on the ledger). Only if that fresh
  verdict is HIGH is the claim valid: the guarantee flips to `CLAIMED`, a refund of `bondUsdc` to
  `payerAddress` is queued through the normal refund rail (Circle `revenue` wallet; `reason` starts
  with `guarantee`), and a `GUARANTEE` entry is appended to the hash-chained decision ledger. A claim
  on a subject that is still LOW or MEDIUM is rejected (`409 NOT_HIGH`, also logged) and the guarantee
  stays active until `until`. Expired guarantees answer `409 EXPIRED`; a second claim `409 NOT_ACTIVE`.
- **Where to look it up.** `GET /api/v1/guarantee/{decisionId}` returns the bond, expiry, status
  (`ACTIVE | CLAIMED | EXPIRED | VOID`) and the claim (refund id, ledger entry, re-screen decision).

## Honest limits

- **The bond is small.** 0.5 USDC by default, and never more than a tenth of the screened amount or a
  quarter of what the revenue wallet holds. It is a signal that the verdict is backed by something,
  not compensation for your loss.
- **It is funded from revenue, not reserves.** Bonds are paid from the same Circle wallet that
  receives x402 fees. That wallet's balance caps every bond at sizing time, and refunds share the
  daily refund cap (`REFUND_DAILY_CAP_USDC`, default 5 USDC): a claim beyond the cap stays `QUEUED`
  until the cap rolls over. Without a configured refund signer the refund is recorded as `DRY_RUN`
  (still owed, still on the ledger) rather than sent.
- **It is not insurance.** It does not cover the payment you made to the subject, it has no legal
  standing beyond these terms, and it only pays on CompliR's **own** re-grade to HIGH. A subject that
  turns out bad in some way CompliR's rules and sources never see does not trigger it.
- **It pays on HIGH, not on MEDIUM.** A drift from LOW to MEDIUM within the window is not a claim.
- **It is time-boxed.** 30 days from the screen. After that the guarantee expires with no payout.
- **Sizing is as of the screen.** The revenue balance is read (and cached for a minute) when the
  verdict is issued; the bond does not grow or shrink later.

## Configuration

| Variable                  | Default | Meaning                                                |
| ------------------------- | ------- | ------------------------------------------------------ |
| `GUARANTEE_MAX_BOND_USDC` | `0.5`   | hard cap per guarantee                                 |
| `GUARANTEE_DAYS`          | `30`    | window after the screen during which a claim is valid |
| `REVENUE_WALLET`          | -       | wallet the bond is sized against (falls back to `X402_PAY_TO`, then the Circle `revenue` wallet) |

Code: `src/lib/guarantee/` (sizing, persistence in `guarantees`, claims), the pipeline hook in
`src/lib/pipeline.ts` (step 7c), routes under `src/app/api/v1/guarantee/`. Tests:
`npx vitest run src/lib/guarantee`.
