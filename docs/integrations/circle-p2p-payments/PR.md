# Title

pay: optional CompliR recipient screening before the user operation

# Body

## What this adds

An opt-in recipient check behind one env var. Payments in this app are user operations signed in the browser with a passkey (`sendUSDC` in `components/web3-provider.tsx`), so there is no server route to gate; instead:

- `lib/complir.ts` (server-only) reads the recipient's risk tier from [CompliR](https://github.com/mrnetwork0001/complir) (`GET /api/v1/attestation/<address>`, free, 8 s timeout).
- `screenRecipientAction` in `app/actions/index.ts` (a `"use server"` action, signed-in users only) exposes it to the client without leaking `COMPLIR_URL`.
- `handleSend` in `components/wallet-tab.tsx` calls it right before `sendUSDC(recipient, amount)`. A `HIGH` tier throws, which the existing `catch` turns into the "Transaction failed" toast with the reason; nothing is signed.

No new dependency.

## Why

The Pay flow validates the address format and asks the user to confirm it, but nothing asks whether the recipient is sanctioned, USDC-blacklisted or funded by a sanctioned wallet two hops back. CompliR grades the address each time it is screened, mirrors the tier to a registry on Arc and returns a `decisionId` that links to a replayable decision log.

## How to enable

```
# .env.local
COMPLIR_URL=https://complir.example      # the hosted CompliR URL
```

## Opt-in and non-breaking

- `COMPLIR_URL` unset (the default and `.env.example`): `complirCheck()` returns `{ allowed: true, reason: "disabled" }` before any I/O. The server action still runs (one `auth.getUser()` round trip) and `handleSend` proceeds exactly as today.
- CompliR unreachable, slow or non-2xx: `console.warn` on the server, payment proceeds. The check can only ever stop a payment, never loosen anything.
- Because signing happens in the browser, this is a UX guard, not an enforcement boundary; the README section says so. The enforcement variant is the on-chain `ICompliR.isAllowed` check in a receiving contract.

## Usage

```ts
// components/wallet-tab.tsx, handleSend
const screening = await screenRecipientAction(recipient);   // { allowed, tier, score, decisionId, reason }
if (!screening.allowed) {
  throw new Error(`Recipient blocked by CompliR screening (${screening.tier ?? screening.reason})`);
}
const txHash = await sendUSDC(recipient, amount);
```

The free endpoint returns the stored tier. For a fresh verdict with reasons and recommended limits, `POST /api/v1/screen` (x402, 0.01 USDC on Arc) is the upgrade and fits the same shape.

## Docs

- CompliR README and the attestation/verdict shape: https://github.com/mrnetwork0001/complir#readme
- This integration (patch, notes): https://github.com/mrnetwork0001/complir/tree/main/docs/integrations/circle-p2p-payments
- Live registry on Arc mainnet: https://explorer.arc.network/address/0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d
