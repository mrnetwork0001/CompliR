# Title

payout/transfer: optional CompliR screening beside Compliance Engine

# Body

## What this adds

A second, server-side screening input behind one env var. `lib/complir.ts` reads the recipient's risk tier from [CompliR](https://github.com/mrnetwork0001/complir) (`GET /api/v1/attestation/<address>`, free, 8 s timeout) and the two routes that move money refuse a `HIGH` recipient:

| Route | Screened address | On `HIGH` |
|---|---|---|
| `POST /api/payout` | `recipientAddress` (before wallet lookup and routing) | `403 { error, userMessage }` |
| `POST /api/wallet/transfer` | `destinationAddress` (right after zod validation) | `403 { error, userMessage }` |

The existing Circle Compliance Engine check (`/api/compliance/screen`, called by `use-compliance-check.ts` before the send dialog submits) is untouched. The two checks are independent and the stricter verdict wins. No new dependency.

## Why

The Compliance Engine screen runs in the browser and is advisory from the server's point of view: a client can call `/api/payout` directly. CompliR adds a server-side check at the point of release and a different signal set (OpenSanctions, USDC `isBlacklisted`, 2-hop USDC funder taint on Arc, lookalike match), with the tier mirrored to a registry on Arc and a `decisionId` that links to a replayable decision log, so a refused payout can be explained.

## How to enable

```
# .env.local
COMPLIR_URL=https://trycomplir.xyz      # the hosted CompliR URL
```

## Opt-in and non-breaking

- `COMPLIR_URL` unset (the default and `.env.example`): `complirCheck()` returns `{ allowed: true, reason: "disabled" }` before any I/O; both routes behave exactly as today.
- CompliR unreachable, slow or non-2xx: `console.warn`, request proceeds. CompliR can only ever block, never loosen the Compliance Engine result or any balance/currency check in the routes.
- Response shape on block reuses the routes' own `{ error, userMessage }` convention so the existing dialogs show the message.
- No change to `lib/compliance/*`, `/api/compliance/screen`, the `compliance_logs` table or the UI.

## Usage

```ts
// app/api/payout/route.ts (same block in app/api/wallet/transfer/route.ts)
const screening = await complirCheck(recipientAddress);   // { allowed, tier, score, decisionId, reason }
if (!screening.allowed) {
  return NextResponse.json(
    { error: "Recipient blocked by CompliR screening", userMessage: `CompliR rates this recipient ${screening.tier} risk. ...` },
    { status: 403 }
  );
}
```

The free endpoint returns the stored tier. For a fresh verdict with reasons, recommended per-tx limits and EDD questions, `POST /api/v1/screen` (x402, 0.01 USDC on Arc) is the upgrade and fits the same `complirCheck` shape; a natural follow-up is logging it into `compliance_logs` next to the Circle result.

## Docs

- CompliR README and the attestation/verdict shape: https://github.com/mrnetwork0001/complir#readme
- This integration (patch, notes): https://github.com/mrnetwork0001/complir/tree/main/docs/integrations/circle-fintech
- Live registry on Arc mainnet: https://explorer.arc.network/address/0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d
