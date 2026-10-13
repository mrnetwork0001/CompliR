# Tip Market — a paid market for risk intelligence

> "Pay the crew the day they work." Anyone who spots a risky address on Arc can tell CompliR, stake a few cents via x402,
> and get paid in USDC the moment the tip verifies. Bad tips lose the stake. Verified tips become evidence in every
> verdict the oracle issues afterwards — the oracle is now two-sided: it sells verdicts *and* buys intelligence.

Page: `/tips` · API: `POST|GET /api/v1/tips`, `GET /api/v1/tips/:id` · tick: `POST|GET /api/internal/tips` · worker: `worker/tips.ts` (5 min)

## Flow

```
submit (x402 stake 0.05 USDC, settled FIRST)  ──►  SUBMITTED
                                                      │  tick (every 5 min)
                                                      ▼
                                   re-screen subject (RESCREEN, clientId "tips") + check evidence
                                                      │
          ┌───────────────────────┬───────────────────┴───────────────────┐
     VERIFIED                 NEEDS_REVIEW                      REJECTED / SLASHED
  bounty → PAID         human: {review, decision}             stake kept (already settled
  tip_overrides row      → VERIFIED | REJECTED                  to X402_PAY_TO), rep down
```

Every step is a hash-chained ledger entry of kind **`TIP`** (`event`: `SUBMIT`, `VERIFY`, `PAY`, `SLASH`, `REVIEW`, `DROP`) —
visible on `/ledger`, replayable, with the submitter anonymised.

## Verification (deterministic, no LLM)

| Check | Strong | Weak |
|---|---|---|
| Evidence tx hash (`eth_getTransactionReceipt` on Arc) | receipt exists **and** touches the subject (from / to / log emitter / indexed topic) | receipt exists but does not touch the subject |
| Evidence URL | hostname on `ofac.treasury.gov`, `sanctionssearch.ofac.treas.gov`, `opensanctions.org`, `europa.eu`, `gov.uk` (or a subdomain) | any other http(s) URL |

Decision from the re-screen tier (`screen({address, clientId:"tips"}, {kind:"RESCREEN", writeOnChain:false})`):

| Re-screen | Corroboration | Decision |
|---|---|---|
| HIGH | any | **VERIFIED** |
| MEDIUM | ≥ 1 strong | **VERIFIED** |
| LOW | none at all | **REJECTED** → `SLASHED` when a stake was paid |
| anything else (MEDIUM alone, LOW + something, re-screen failed) | | **NEEDS_REVIEW** |

The submitter only ever sees `tier`, `score`, `reasonCodes`, the re-screen `decisionId` and the corroboration result —
never the evidence bundle, never another client's data (`src/lib/tips/model.ts` → `toPublicTip`).

## Bounty

`TIP_BOUNTY_USDC` (default **0.25**) × category multiplier × reputation factor, 6 dp:

| category | × | | reputation (0–1) | factor |
|---|---|---|---|---|
| sanctions | 2.0 | | new submitter | 0.5 → ×0.75 |
| poisoning | 1.5 | | 3 verified / 0 rejected | 0.8 → ×0.90 |
| mixer, scam, stolen_funds, other | 1.0 | | perfect record | 1.0 → ×1.00 |

Reputation is Laplace-smoothed `(verified+1)/(verified+rejected+2)` per submitter (`tip_stats`). So a new sanctions tip pays
0.375 USDC, a perfect tipster's sanctions tip pays 0.5 USDC, a new "other" tip pays 0.1875 USDC. Daily cap `TIPS_DAILY_CAP_USDC`
(default **5**): a VERIFIED tip beyond the cap stays VERIFIED and is paid on a later tick.

## Payout rails (`src/lib/tips/payout.ts`, first that applies)

1. **circle** — Circle Developer-Controlled `revenue` wallet via `transferUsdc({ role: "revenue" })` (app-side spending policy,
   Gas Station-sponsored when a mainnet policy is active). Needs `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET`.
2. **local** — viem ERC-20 `transfer(to, amount)` on the USDC interface (`USDC_ADDRESS`) from `TIPS_PAYOUT_PRIVATE_KEY`.
3. **dry-run** — nothing leaves the process (`payoutTx: null`, `payoutMode: "dry-run"`). Default without credentials.

Demo tips from the `/tips` page (same-origin browser) and tips accepted while `X402_DISABLED=1` have no payout address: a
verified bounty is **recorded** (counts against the daily cap, shows on the page) but nothing is sent.

### Why not Circle Nanopayments (research, 2026-10-13)

Circle Nanopayments = **Gateway batched x402**: a *buyer* deposits USDC into a Gateway Wallet once, then signs EIP-3009
authorizations offchain for every x402 request; the *seller's* middleware (`@circle-fin/x402-batching/server`,
`createGatewayMiddleware` / `BatchFacilitatorClient.settle()`) settles them in batches through Gateway's
`settle-x402payment` API. Minimum $0.000001, "near gas-free", EOA only (ecrecover), Arc listed as supported (domain 26,
mainnet `arc` + `arcTestnet`; every Gateway chain except Solana); the quickstarts target Arc Testnet and
`gateway-api-testnet.circle.com`.

It is **buyer → x402-seller only**: there is no server-side "push USDC to an arbitrary wallet" call, so CompliR cannot use
it to *pay out* a bounty to a tipster's address unless the tipster runs an x402 seller endpoint. It fits the **stake**
side perfectly (a buyer can already pay `/api/v1/tips` with a Gateway-signed authorization once our facilitator accepts the
batching scheme), and the `@circle-fin/x402-batching` SDK is not installed. Hence the rails above.

Sources:
- https://developers.circle.com/gateway/nanopayments (overview, EIP-3009 + batched settlement)
- https://developers.circle.com/gateway/nanopayments/quickstarts/seller (`createGatewayMiddleware`, `BatchFacilitatorClient`, `networks: ["eip155:5042002"]`)
- https://developers.circle.com/gateway/nanopayments/quickstarts/buyer (`GatewayClient.deposit/pay`, EOA requirement, `CHAIN_CONFIGS.arcTestnet`)
- https://developers.circle.com/gateway/nanopayments/supported-networks + https://developers.circle.com/gateway/references/supported-blockchains (Arc: domain 26, `arc` / `arcTestnet`; all except Solana)
- https://developers.circle.com/gateway/nanopayments/concepts/batched-settlement
- https://github.com/circlefin/arc-nanopayments (reference app)
- https://circle.com/blog/build-agentic-systems-for-high-frequency-sub-cent-transactions

## The stake is the x402 payment

`POST /api/v1/tips` is wrapped with `withX402(handler, { priceUsdc: TIPS_STAKE_USDC, description: "CompliR tip stake",
settleFirst: true })`. `settleFirst` settles the payment *before* the tip is created, so the payment sink has already
written the `payments` row when the handler runs; the handler picks the payer (`authorization.from`) as the submitter and
the settle tx as `stakeTx`. If the handler then fails, x402 auto-refunds. A tip whose stake never shows up in `payments`
within `TIPS_STAKE_GRACE_SECONDS` (600) is dropped (`REJECTED`, ledger `DROP`, nothing slashed).

Same-origin browser requests (the `/tips` page) bypass x402 and create **demo** tips (submitter `demo`, stake 0, marked
`demo: true` in the API and on the page). With `X402_DISABLED=1` API tips are accepted unstaked as `anonymous`.

## API

```http
POST /api/v1/tips            x402 (0.05 USDC) · same-origin → demo
{ "subject": "0x…", "category": "sanctions|mixer|scam|poisoning|stolen_funds|other",
  "claim": "10–2000 chars", "evidenceUrls": ["https://…"] (≤5), "evidenceTxs": ["0x…64hex"] (≤10) }
→ 201 { tip: PublicTip, demo, note, next }   header X-CompliR-Tip-Id

GET  /api/v1/tips            free · { config, totals, leaderboard[10], items[50], time }   (submitters anonymised: tipster-xxxxxx)
GET  /api/v1/tips/:id        free · { tip: PublicTip }

POST /api/internal/tips      Authorization: Bearer $CRON_SECRET · one tick → TipsTickResult
POST /api/internal/tips      { "review": "tip_…", "decision": "VERIFIED"|"REJECTED", "note"?: "…" } · human override
GET  /api/internal/tips      same as POST without body (Vercel Cron)
```

Public statuses: `SUBMITTED → VERIFYING → VERIFIED → PAID`, or `REJECTED` (no stake) / `SLASHED` (stake kept), or `NEEDS_REVIEW`.

## Oracle feedback — the hook for the lead

VERIFIED tips are written to `tip_overrides` and exposed by **`tipEvidenceFor(address)`** (`src/lib/tips/model.ts`; never
throws, returns `[]` when the store is down, 180-day window). `overrides.ts` is untouched. To make verified tips a reason:

1. `src/lib/types.ts` — add `"COMMUNITY_TIP_VERIFIED"` to `REASON_CODES`, and `communityTips?: TipEvidence[]` to `EvidenceBundle`.
2. `src/lib/evidence/collect.ts` — one more guarded source in Phase 1:
   ```ts
   import { tipEvidenceFor } from "../tips/model";
   // in the Promise.all:  guard("communityTips", tipEvidenceFor(subject, { now })),
   // in the bundle:       communityTips: communityTips === SENTINEL ? [] : communityTips,
   ```
3. `src/lib/scoring/rules.ts` — `WEIGHTS.COMMUNITY_TIP_VERIFIED = 15`, and after the direct hits:
   ```ts
   if (bundle.communityTips?.length) reasons.push({ code: "COMMUNITY_TIP_VERIFIED", weight: WEIGHTS.COMMUNITY_TIP_VERIFIED,
     evidence: { count: bundle.communityTips.length, tips: bundle.communityTips.map((t) => ({ tipId: t.tipId, category: t.category, strength: t.strength, verifiedAt: iso(t.verifiedAt) })) } });
   ```
   (15 points: enough to lift a clean LOW to the top of LOW / a borderline wallet into MEDIUM, never to HIGH on its own —
   a tip is corroboration, not a sanctions hit.)

## Env

| var | default | |
|---|---|---|
| `TIPS_STAKE_USDC` | 0.05 | x402 price of `POST /api/v1/tips` (the stake) |
| `TIP_BOUNTY_USDC` | 0.25 | base bounty |
| `TIPS_DAILY_CAP_USDC` | 5 | max bounties per UTC day |
| `TIPS_PAYOUT_PRIVATE_KEY` | — | local payout rail (viem USDC transfer) when Circle is not configured |
| `TIPS_STAKE_GRACE_SECONDS` | 600 | how long an API tip may wait for its stake to appear in `payments` |
| `CRON_SECRET` | — | protects `/api/internal/tips` |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | — | enable the Circle `revenue` wallet rail (docs/CIRCLE_WALLETS.md) |

Tables (own migrations in `src/lib/tips/model.ts`): `tips`, `tip_stats`, `tip_overrides`, `tip_spend`.
Tests: `npx vitest run src/lib/tips` (verify matrix, bounty/reputation math, dry-run payout, daily cap, ledger entries, review, stake drop).
