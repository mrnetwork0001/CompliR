# CompliR — Counterparty Risk Oracle for Agents on Arc

> **Grade any counterparty on Arc (0–100), get a signed verdict and a limit your policy can use, and keep re-grading it forever. One x402 call, 0.01 USDC. Contracts can read the verdict on-chain.**

Built for the [Tameion Agents Hackathon](https://tameion.thecanteenapp.com) (Canteen × Circle × Arc) · RFB 05 Compliance Intelligence.
CompliR **never holds client funds**. It screens; your wallet or contract pays.

| | |
|---|---|
| Live | **https://trycomplir.xyz** (Arc mainnet) · local: `npm run dev` → http://localhost:3000 |
| Trust Map / Payouts | `/map` · `/payouts` |
| Registry (Arc mainnet 5042) | [`0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d`](https://explorer.arc.io/address/0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d) · verified on Sourcify · first attestation [tx](https://explorer.arc.io/tx/0xb29418cfa4630ef52333947f9ddca2851948934dbe1720f02172f245d54a073e) · first Merkle anchor [tx](https://explorer.arc.io/tx/0x6df814a6085dc67003ca449291e6c7ec2554bbe808244054f205e5ad352eee84) |
| GuardedTreasury v2 (Arc mainnet) | [`0x3B13186a1E4b1108eA5CB2f8853D84A2aeD71Cc5`](https://explorer.arc.io/address/0x3B13186a1E4b1108eA5CB2f8853D84A2aeD71Cc5) · verified · `releaseWithProof` emits the verdict's decision hash with every payment: [first proof payout](https://explorer.arc.io/tx/0x15ee6653154af48122eeb01297c0b707e7c23d5be2e7437022d06a7845923011) · v1 [`0x5465f31a…`](https://explorer.arc.io/address/0x5465f31a6155E3eCCcC35f4E5bDC0e287763B0ee) retired |
| Numbers (honest, own wallets excluded) | `/numbers` |
| Video | _pending_ |

## Why

Every treasury agent checks a denylist once and pays. The list is stale the day it is carved (the Megarian Decree problem).
Nobody looks past the first hop, nobody re-grades after onboarding, and no verdict can be verified by anyone else.

## 60-second quickstart

```bash
# 1. Free, unpaid screen (dev mode)
curl -s -X POST http://localhost:3000/api/v1/screen \
  -H 'content-type: application/json' \
  -d '{"address":"0x1234567890abcdef1234567890abcdef12345678","amountUsdc":120}' | jq .tier

# 2. Paid screen over x402 (production): the SDK handles the 402 → sign → retry loop
```

```ts
import { CompliR } from "@complir/sdk";
const c = new CompliR({ account /* viem account that holds USDC on Arc */ });
const v = await c.screen("0xPayee", { amountUsdc: 120, payeeBook: myPayees });
if (v.tier === "HIGH") hold();
else pay(Math.min(120, v.recommendedLimits.maxPerTxUsdc));
```

```solidity
// 3. On-chain: one line in your treasury contract
require(ICompliR(COMPLIR).isAllowed(payee, ICompliR.Tier.MEDIUM), "CompliR: payee tier too high");
```

## What a verdict contains

Score + tier (deterministic rules) · recommended per-tx / per-day limits · reasons with clickable evidence
(2-hop funder paths, sanctions entity ids, USDC blacklist flag, lookalike/poisoning matches) · the Risk Analyst's
rationale and any Enhanced Due Diligence questions · the next re-screen time it chose · an EIP-712 attestation
signed by CompliR and mirrored to `AttestationRegistry` on Arc · a decision id in a hash-chained log anchored on-chain.

## Architecture

```
POST /v1/screen ─► Evidence Collector ─► Rules (score/tier) ─► Risk Analyst (limits, EDD, cadence, rationale)
   (x402)           yente · Arc graph        deterministic        Claude, guard-railed in code
                    USDC blacklist                                       │
                    payee book                                           ▼
                                                        EIP-712 attest ─► AttestationRegistry.sol (Arc)
                                                        Decision log  ─► Merkle root anchored on Arc
POST /v1/watch  ─► Watcher (adaptive cadence) ─► webhook + TierChanged event
```

Full spec: [COMPLIR_PROJECT_SPEC.md](COMPLIR_PROJECT_SPEC.md) · Strategy & landscape: [docs/HACKATHON_STRATEGY.md](docs/HACKATHON_STRATEGY.md)

## Run locally

```bash
cp .env.example .env.local        # fill ARC_* and keys; X402_DISABLED=1 for dev
docker compose -f docker/yente/docker-compose.yml up -d   # OpenSanctions (optional; degrades gracefully)
npm install && npm run dev
```

`npm test` · `npm run typecheck` · `cd contracts && forge test`

## Circle / Arc stack

x402 Facilitator (Arc mainnet) · Developer-Controlled Wallets · Contracts (`AttestationRegistry`) · Gateway · USYC revenue sweep · Paymaster · USDC `isBlacklisted` as evidence.

## What's in the box (2026-10-11)

| Surface | What it shows |
|---|---|
| `/` | Landing page → **Launch App** |
| `/app` | Operations console: status, KPIs, decision ticker, today's operator decision, grouped products |
| `/company` | **The company the agent runs**: earned / held / paid out / refused, reserves, obligations, pricing, operator decisions with reasons |
| `/report` | Signed daily traction report written by the agent (own wallets excluded, refunds and mistakes listed) |
| `/tips` | Tip market: stake USDC on risk intelligence, verified tips are paid, bad tips are slashed |
| `/map` | **Arc Trust Map** — tails Arc mainnet, grades counterparties receiving ≥25 USDC, live risk graph with tier changes |
| `/payouts` | **Guarded Payouts** — a treasury agent paying through `GuardedTreasury`; PAID / LIMITED / HELD with signed reasons (dry-run until funded) |
| `/explorer` | Screen any address: score dial, 2-hop funder graph, reasons with tx evidence, rationale, EDD, attestation |
| `/shadow` | Shadow Report: paste a payee book → what your denylist would have missed |
| `/badge` | "Screened by CompliR" SVG badge + embed snippets |
| `/feed` `/numbers` `/ledger` `/log/:id` | Public feed, honest traction numbers (own wallets excluded), hash-chained decision log with replay |
| `/edd/:id` | Counterparty-facing Enhanced Due Diligence answer page (answers hashed into the ledger, triggers re-screen) |
| `/docs` | curl / SDK / Solidity / webhook integration |

Pipeline: evidence (2-hop USDC funder trace via Arc's system emitter, USDC `isBlacklisted`, yente/OpenSanctions, payee-book lookalikes) → deterministic score/tier → Risk Analyst (Claude, guard-railed; deterministic fallback) → EIP-712 attestation → `AttestationRegistry` on Arc → hash-chained log with Merkle roots anchored on-chain. x402 via Circle's Facilitator (Arc native) on `/screen` and `/watch`; hosted UI stays free. Revenue and ops wallets are Circle Developer-Controlled Wallets (SCA) with app-enforced spending policies; registry writes relay through the Circle ops wallet with Gas Station sponsorship when `SIGNER_MODE=circle` (`docs/CIRCLE_WALLETS.md`), falling back to a local key. Operator agent decides sweeps, payouts and x402 pricing within hard guards and signs one decision per tick. Automatic on-chain refunds for settled-but-undelivered calls. Cross-client network signal (held elsewhere / shared funder) and event-driven re-grades on USDC blacklist events with webhooks within a minute. MCP server (`packages/mcp`) exposes it all as agent tools. Workers: watcher, trust-map tailer, treasury, operator, events, refunds, tips, USYC, report (`worker/*.ts` or Vercel crons in `vercel.json`).

Tests: `npm test` 229 passing · `cd contracts && forge test` 45 passing · `npm run build` clean.

**Live on Arc mainnet (2026-10-13):** registry + GuardedTreasury deployed and verified, attestations mirrored on-chain, Merkle roots anchored, Guarded Payouts running live, OpenSanctions (yente) indexed, Claude rationales via 0G Compute. x402 charging is live through Circle's Facilitator (first real 0.01 USDC settlement in the Circle revenue wallet `0x9b0d…977e`); revenue and ops are Circle Developer-Controlled Wallets (SCA) on Arc. Registry writes relay through the Circle ops wallet with Gas Station sponsored gas. **Still pending:** hosting, USYC onboarding. Ready-to-open integration PRs for STEWARD, Vestiarion and CeedeBooks are in `docs/integrations/`.
