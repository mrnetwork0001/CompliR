# Title

admin capture/refund: optional CompliR counterparty screening

# Body

## What this adds

An opt-in counterparty check at the two admin operations that release funds from the Commerce Payments Protocol escrow, behind one env var:

| Route | Screened address | On `HIGH` |
|---|---|---|
| `POST /api/admin/orders/[id]/capture` | `paymentInfo.receiver` (the merchant) | `403 { error }`, `capture` not submitted |
| `POST /api/admin/orders/[id]/refund` | `paymentInfo.payer` (the shopper) | `403 { error }`, `refund` not submitted |

`lib/complir.ts` (server-only) reads the address's risk tier from [CompliR](https://github.com/mrnetwork0001/complir) (`GET /api/v1/attestation/<address>`, free, 8 s timeout). `LOW`/`MEDIUM` proceed exactly as today. No new dependency.

## Why

The operator submits every protocol op and sponsors its gas, so it is the party that would be asked why funds went to a sanctioned or blacklisted wallet. Nothing in the app screens the receiver before `capture` or the payer before `refund`. CompliR grades the address each time it is screened (OpenSanctions, USDC `isBlacklisted`, 2-hop USDC funder taint on Arc), mirrors the tier to a registry on Arc and returns a `decisionId` that links to a replayable decision log.

## How to enable

```
# .env.local
COMPLIR_URL=https://complir.example      # the hosted CompliR URL
```

## Opt-in and non-breaking

- `COMPLIR_URL` unset (the default and `.env.example`): `complirCheck()` returns `{ allowed: true, reason: "disabled" }` before any I/O; both routes behave exactly as today.
- CompliR unreachable, slow or non-2xx: `console.warn`, operation proceeds. The check can only ever block, never loosen the admin-role, status or amount checks that run before it.
- Response reuses the routes' own `{ error }` shape and sits after the 401/403/400/404/409/422 checks and before the 502 `capture`/`refund` call, so the admin UI shows it like any other refusal.
- `lib/operator/operations.ts`, the webhook handler, the lifecycle table and the shopper-facing routes are unchanged.

## Usage

```ts
// app/api/admin/orders/[id]/capture/route.ts (refund screens paymentInfo.payer)
const screening = await complirCheck(paymentInfo.receiver);   // { allowed, tier, score, decisionId, reason }
if (!screening.allowed) {
  return NextResponse.json({ error: `Receiver blocked by CompliR screening (tier ${screening.tier})` }, { status: 403 });
}
({ txHash } = await capture(paymentInfo, amountUnits));
```

The free endpoint returns the stored tier. For a fresh verdict with reasons and recommended limits, `POST /api/v1/screen` (x402, 0.01 USDC on Arc) is the upgrade and fits the same shape; the shopper-side `account/orders/[id]/refund` and the `authorize` step could adopt the same two lines if wanted.

## Docs

- CompliR README and the attestation/verdict shape: https://github.com/mrnetwork0001/complir#readme
- This integration (patch, notes): https://github.com/mrnetwork0001/complir/tree/main/docs/integrations/circle-ecommerce-payments
- Live registry on Arc mainnet: https://explorer.arc.network/address/0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d
