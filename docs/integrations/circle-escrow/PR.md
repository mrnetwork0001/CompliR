# Title

escrow: optional CompliR screening of the beneficiary before release

# Body

## What this adds

An opt-in counterparty check at the one place this app releases escrowed USDC to a counterparty, in both layers, behind one env var each:

- **HTTP, `app/api/contracts/validate-work/route.ts`**: after OpenAI accepts the deliverable and before `withdraw(uint256[])` is submitted from the beneficiary's wallet, `lib/complir.ts` reads the beneficiary's risk tier from [CompliR](https://github.com/mrnetwork0001/complir) (`GET /api/v1/attestation/<address>`, free, 8 s timeout). `HIGH` returns `403 { error: "Beneficiary blocked by CompliR screening", tier, decisionId }` and the funds stay in escrow. `LOW`/`MEDIUM` release exactly as today.
- **On-chain, `RefundProtocol.sol`**: `address public complir` + `setComplir(address)` (arbiter-only, like the other admin functions) and `_requireComplirAllowed(recipient)` in `withdraw` and `earlyWithdrawByArbiter`, which reverts with a new custom error `CompliRTierTooHigh(address)` when a registry is set and `ICompliR(complir).isAllowed(recipient, Tier.MEDIUM)` is false. `ICompliR.sol` is vendored next to the contract (enum, events, `tierOf`, `isAllowed`).

No new dependency; the HTTP check uses `fetch`.

## Why

The escrow releases to whatever wallet is on the agreement. Nothing today asks whether that wallet is sanctioned, USDC-blacklisted or funded by a sanctioned wallet two hops back. CompliR grades the address every time it is screened and mirrors the tier to a registry on Arc, signed by its attester with a `decisionId` that links to a replayable decision log, so a held release can be explained to a third party.

## How to enable

```
# .env.local
COMPLIR_URL=https://trycomplir.xyz            # the hosted CompliR URL
COMPLIR_REGISTRY=0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d   # Arc mainnet registry, for setComplir
```

For the on-chain gate, recompile `RefundProtocol.sol`, refresh `REFUND_PROTOCOL_BYTECODE` / `REFUND_PROTOCOL_ABI_JSON` in `lib/constants.ts`, and call `setComplir(COMPLIR_REGISTRY)` from the arbiter wallet after deployment. The HTTP gate needs only `COMPLIR_URL`.

## Opt-in and non-breaking

- `COMPLIR_URL` unset (the default and `.env.example`): `complirCheck()` returns `{ allowed: true, reason: "disabled" }` before any I/O.
- `complir == address(0)` (the default; the constructor is unchanged): the contract behaves exactly as before. The deployed bytecode in `lib/constants.ts` is untouched by this PR.
- CompliR unreachable, slow or returning a non-2xx: `console.warn` and the release proceeds. The check can only ever block, never loosen the existing OpenAI validation or auth checks.

## Usage

```ts
// app/api/contracts/validate-work/route.ts, right before withdraw(uint256[]) is submitted
const screening = await complirCheck(agreement.beneficiary_wallet.wallet_address);
if (!screening.allowed) {
  return NextResponse.json({ error: "Beneficiary blocked by CompliR screening", ... }, { status: 403 });
}
```

```solidity
// RefundProtocol.sol
function withdraw(uint256[] calldata paymentIDs) external {
    _requireComplirAllowed(msg.sender);   // no-op while complir == address(0)
    ...
```

The free endpoint returns the stored tier. For a fresh verdict with reasons, recommended per-tx limits and EDD questions, `POST /api/v1/screen` (x402, 0.01 USDC on Arc) is the upgrade and plugs into the same `complirCheck` shape.

## Docs

- CompliR README and the attestation/verdict shape: https://github.com/mrnetwork0001/complir#readme
- This integration (patch, notes): https://github.com/mrnetwork0001/complir/tree/main/docs/integrations/circle-escrow
- Live registry on Arc mainnet: https://explorer.arc.network/address/0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d
