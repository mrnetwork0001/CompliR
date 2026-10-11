# Title

compliance: optional CompliR address screening beside OpenSanctions

# Body

## What this adds

`src/lib/complir.ts`, a second screening provider that runs inside the existing compliance sweep. OpenSanctions (or the bundled list) answers *who is this*; [CompliR](https://github.com/mrnetwork0001/complir) answers *where did this wallet's money come from*. For each counterparty with an `address`, after `screenName`:

- CompliR grades the address (2-hop USDC funder trace on Arc, OpenSanctions/yente, USDC `isBlacklisted`, lookalike of a known payee) into a 0–100 score and a tier.
- The **stricter** of the two verdicts wins: `HIGH → high` (limit 0, the existing hard block), `MEDIUM → medium`, `LOW → clear`. CompliR never loosens a name-screening verdict.
- `planScreening` keeps your tiering and adds one ceiling: `newLimit = min(paymentLimitForRisk(risk, baseline), verdict.recommendedLimits.maxPerTxUsdc)`. Still a pure function of `(risk, baseline, recommendedLimit)`, so re-screening stays idempotent (the migration 0002 property).
- The **EIP-712 attestation CompliR signs** (plus `decisionId`, score, tier, limits, `nextRescreenAt`) is stored in the `detail` of the Ed25519-signed `screen_counterparty` / `risk_level_changed` ledger entry, so an auditor can verify CompliR's signature offline next to yours and replay the decision by id.
- Failures are `ScreeningLookupError`s like an OpenSanctions outage: previous verdict retained, `screening_incomplete` recorded.

No new dependency: `viem` and `zod` are already in `package.json`.

## Why

A sanctions-list match on a *name* misses the cases that matter on-chain: a vendor whose wallet was funded by a sanctioned address two hops back, a lookalike address of a contractor you already pay, a wallet Circle blacklisted after onboarding. The sweep already re-screens every cycle; this gives it an address-level signal and a limit it can adopt directly, with a verdict a third party can verify.

## How to enable

```
COMPLIR_URL=https://complir.example      # the hosted URL (ask us; mainnet 13 Oct)
COMPLIR_PAYER_PRIVATE_KEY=0x...          # a small USDC purse on Arc that pays 0.01 USDC per screen over x402 (not the treasury)
```

## Opt-in and non-breaking

- `COMPLIR_URL` unset: `complirEnabled()` is false, `applyScreening` is byte-for-byte the old path, `planScreening` computes the old limit (`recommendedLimit` is absent). `tests/complir.test.ts` asserts this; the existing compliance tests pass unchanged.
- A sandbox workspace never calls CompliR (`org-config.ts` drops `complirUrl` with the OpenSanctions URL), so demo counterparties cost nothing.
- Payment safety K1 is untouched: a live workspace with no screening service still gets no verdict; CompliR only ever runs *after* `screenName` returned one.
- Schema: `SCREENING_COLUMNS` gains `address` (an existing column); no migration. The new ledger `detail` keys are additive.

## Usage

```ts
// src/lib/compliance.ts, applyScreening — the whole wiring
result = await screenName(cp.name, cp.jurisdiction, dismissed);
if (complirEnabled() && cp.address) {
  result = mergeCompliR(result, await screenAddressWithCompliR(cp.address, { name: cp.name, amountUsdc }));
}
const plan = planScreening(cp, result);     // newLimit = min(tiered limit, CompliR's maxPerTxUsdc)
await appendLedgerEntry({ ..., detail: { ..., complir: plan.result.complir } });   // signed attestation beside yours
// result.complir = { tier, score, decisionId, recommendedLimits, attestation: { typedData, signature, attester, validUntil, registryTx } }
```

## Docs

- CompliR README and verdict shape: https://github.com/mrnetwork0001/complir#readme
- This integration: https://github.com/mrnetwork0001/complir/tree/main/docs/integrations/vestiarion
- Offline attestation check (`CompliR.verifyAttestation`) lives in `packages/sdk/src/index.ts` there; happy to add a `verify-ledger` hook for it if useful.

## Free screenings during Tameion

Free for every Tameion team during the event: send us your agent address and we switch x402 off for it (no purse key needed), or send a counterparty list and we return a shadow report of what name screening cleared that CompliR would have tiered down. Also glad to route the x402 payment through your Circle wallet signer (`src/lib/x402/buyer.ts` style) instead of a purse key if you prefer.
