<p align="center">
  <img src="public/brand/lockup.png" alt="CompliR - the risk layer money on Arc runs on" width="640" />
</p>

<p align="center">
  <b>The open, verifiable counterparty-risk layer for money moving on Arc.</b><br/>
  One call before every USDC payment: a graded verdict, a spending limit, the reasons, and an EIP-712 signature a smart contract can check.
</p>

<p align="center">
  <a href="https://trycomplir.xyz"><b>trycomplir.xyz</b></a> ·
  <a href="https://trycomplir.xyz/check">Check an address</a> ·
  <a href="https://trycomplir.xyz/company">The agent-run company</a> ·
  <a href="https://trycomplir.xyz/map">Arc Trust Map</a> ·
  <a href="https://trycomplir.xyz/docs">Docs</a>
</p>

<p align="center">
  Live on <b>Arc mainnet (chain 5042)</b> · Built for the <a href="https://tameion.thecanteenapp.com">Tameion Agents Hackathon</a> (Canteen × Circle × Arc) · RFB 05 Compliance Intelligence
</p>

---

## Contents

1. [The problem](#1-the-problem)
2. [What CompliR is](#2-what-complir-is)
3. [Live on mainnet: verifiable proof](#3-live-on-mainnet-verifiable-proof)
4. [How a screen works](#4-how-a-screen-works)
5. [The agent that runs the company](#5-the-agent-that-runs-the-company)
6. [Products](#6-products)
7. [Circle × Arc stack](#7-circle--arc-stack)
8. [Integrate in minutes](#8-integrate-in-minutes)
9. [Trust model](#9-trust-model)
10. [Architecture & repository](#10-architecture--repository)
11. [Run, test, deploy](#11-run-test-deploy)
12. [Honest status](#12-honest-status)
13. [How this maps to the judging criteria](#13-how-this-maps-to-the-judging-criteria)

---

## 1. The problem

Every treasury agent on Arc has to answer one question before it moves money: *is this address safe to pay?*

Today the answer is a static denylist, checked once at payment time:

| Failure mode | What goes wrong |
|---|---|
| **One hop** | The payee looks clean; the wallet that funded it was funded by a sanctioned one. Nobody looked. |
| **One moment** | A payee graded clean in March is paid in October on March's answer. |
| **One bit** | Allow or deny. No limit, no questions, no path for a legitimate new counterparty to prove itself. |
| **Black box** | The verdict can't be verified, replayed, or checked by a contract before funds move. |

Athens barred the Megarians from its markets with a single decree and no appeal. Modern denylists are not much more granular.

## 2. What CompliR is

CompliR is a **counterparty-risk oracle** for USDC payments on Arc, operated end to end by an AI agent.

- **Graded, not binary.** Every address gets a 0-100 score, a tier (LOW / MEDIUM / HIGH), and a recommended per-transaction and per-day limit.
- **Evidence you can click.** Sanctions hits (OpenSanctions: OFAC SDN, EU, UK, UN, JP MOF and more), Circle's USDC `isBlacklisted`, a **two-hop USDC funder trace** on Arc, address-poisoning lookalikes, cross-client network signals, ERC-8004 agent reputation, and bridged-inflow (CCTP) screening.
- **Signed and on-chain.** Every verdict is an **EIP-712 attestation**, mirrored to `AttestationRegistry` on Arc. Any contract can gate a payment with one line: `require(ICompliR(registry).isAllowed(payee, ICompliR.Tier.MEDIUM))`.
- **Continuous.** Addresses are re-graded on a cadence the agent chooses, and within a minute of Circle blacklisting a wallet; integrators get a `tier.changed` webhook.
- **Replayable.** Every decision is appended to a hash-chained ledger whose Merkle roots are anchored on Arc.
- **Paid per call by machines.** 0.01 USDC per screen over **x402**, settled through Circle's facilitator. The hosted UI is free.
- **Never holds client funds.**

## 3. Live on mainnet: verifiable proof

Everything below is on Arc mainnet and checkable on the explorer. No mocked or seeded data runs anywhere in production.

| What | Address / transaction |
|---|---|
| `AttestationRegistry` (verified, Sourcify) | [`0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d`](https://explorer.arc.io/address/0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d) |
| `GuardedTreasuryV2` (verified) - `releaseWithProof` | [`0x3B13186a1E4b1108eA5CB2f8853D84A2aeD71Cc5`](https://explorer.arc.io/address/0x3B13186a1E4b1108eA5CB2f8853D84A2aeD71Cc5) |
| First on-chain attestation | [`0xb29418cf…a073e`](https://explorer.arc.io/tx/0xb29418cfa4630ef52333947f9ddca2851948934dbe1720f02172f245d54a073e) |
| Attestation relayed via **Circle wallet + Gas Station** (ERC-4337) | [`0xf5a0ea1b…99e0`](https://explorer.arc.io/tx/0xf5a0ea1b57720cf27a1e74ffba1f4d21ea9acb51b3bd2e5b8b007436a2b499e0) |
| First Merkle anchor of the decision ledger | [`0x6df814a6…ee84`](https://explorer.arc.io/tx/0x6df814a6085dc67003ca449291e6c7ec2554bbe808244054f205e5ad352eee84) |
| First payout carrying its verdict's decision hash | [`0x15ee6653…3011`](https://explorer.arc.io/tx/0x15ee6653154af48122eeb01297c0b707e7c23d5be2e7437022d06a7845923011) |
| First x402 screen settled (0.01 USDC → Circle revenue wallet) | [`0x3d45392b…69ad`](https://explorer.arc.io/tx/0x3d45392b7dd97f1f31beda91f2527428cdccd4fe1c93698d3daadff3a2d369ad) |
| CompliR registered as **ERC-8004 agent #2418** | [`0x0265f356…4e4e`](https://explorer.arc.io/tx/0x0265f3562e544159bf7fbd457a377f50c98c072128849a3145566490cb004e4e) |
| Circle revenue wallet (SCA) | [`0x9b0df32b9a239d392b8071f2a428b11c3b9c977e`](https://explorer.arc.io/address/0x9b0df32b9a239d392b8071f2a428b11c3b9c977e) |
| Circle ops/relayer wallet (SCA) | [`0xa4945f01faa002032449af43b07782b6da227c69`](https://explorer.arc.io/address/0xa4945f01faa002032449af43b07782b6da227c69) |
| Idle-revenue target: Circle Earn - Steakhouse Prime USDC (Morpho) | [`0xbeef0016cb2fd5c352ea7ca08a9f54739dfa7298`](https://explorer.arc.io/address/0xbeef0016cb2fd5c352ea7ca08a9f54739dfa7298) |

**Try it:** [trycomplir.xyz/a/0x098b716b8aaf21512996dc57eb0615e2383e2f96](https://trycomplir.xyz/a/0x098b716b8aaf21512996dc57eb0615e2383e2f96) - the Ronin Bridge exploiter wallet (Lazarus Group). CompliR answers *"Don't pay. This wallet is on the OFAC sanctions list and Circle has blocked it on USDC"* from live OpenSanctions data and a live call to Circle's USDC contract on Arc.

## 4. How a screen works

```
POST /api/v1/screen  (x402: 0.01 USDC)
        │
        ▼
 ┌─ EVIDENCE (concurrent, 4-12 s per-source timeouts, a failed source is recorded, never assumed clean)
 │   OpenSanctions (self-hosted yente) · USDC isBlacklisted · 2-hop USDC funder trace via Arc's
 │   system Transfer emitter · payee-book lookalikes · cross-client network signal ·
 │   ERC-8004 reputation/validations · CCTP inbound source-sender flags · verified community tips
 ├─ RULES  deterministic 0-100 score + tier; every point attributed to a reason code with its evidence
 ├─ RISK ANALYST  Claude (via 0G Compute) proposes limits, EDD questions, re-screen cadence, rationale
 │   → code clamps every field to the tier band. The model cannot move the score.
 ├─ ATTEST  EIP-712 Attestation(subject, tier, score, decisionHash, issuedAt, validUntil)
 │   → mirrored to AttestationRegistry, relayed by a Circle wallet with Gas Station sponsorship
 └─ LEDGER  append-only hash chain; Merkle roots anchored on Arc
        │
        ▼
 Verdict: score · tier · limits · reasons+evidence · rationale · EDD link · next re-screen · signature
```

| Tier | Score | What the caller should do |
|---|---|---|
| LOW | 0-20 | Pay. Full limits. Optional small guarantee bond. |
| MEDIUM | 21-60 | Pay up to the limit; the counterparty gets specific due-diligence questions (EDD) and can clear itself. |
| HIGH | 61-100 | Don't pay. Direct sanctions or Circle blocklist hits floor the score at HIGH. |

## 5. The agent that runs the company

CompliR is itself a small business run by an agent with no human in the loop (Prior Art 08: *a single AI agent that runs the whole cycle of money*). The **operator** wakes on its own cadence, reads a full snapshot of the company, and chooses among actions that code has already pre-validated:

| Function | How |
|---|---|
| **Earns** | x402 revenue lands in a Circle Developer-Controlled Wallet. The operator **re-prices the API within hard bounds** (it already cut the price from 0.01 to 0.009 USDC on its own after seeing low demand). |
| **Holds** | Circle wallets with app-enforced spending policies (per-tx, daily, contract allowlist). Idle revenue above a float is swept into **Circle Earn Kit** Morpho USDC vaults; vaults Circle flags as illiquid or risky are refused. |
| **Pays** | **Guarded Payouts**: contributor invoices are paid through `GuardedTreasuryV2.releaseWithProof`, which refuses any payee the registry doesn't allow and emits the verdict's decision hash with the transfer. MEDIUM payees get a **tranche schedule** (part now, the rest after EDD and a quiet period). |
| **Refunds** | A paid call that fails after settlement is refunded on-chain automatically. |
| **Accounts** | One signed `OPERATOR` ledger entry per tick, a signed daily traction report, and a monthly transparency rollup. |

Every decision states its reasons and the candidates it rejected: an agent that chooses when to pay, and can explain why.

## 6. Products

| Surface | For | What it does |
|---|---|---|
| [**Check**](https://trycomplir.xyz/check) | Anyone | Paste an address, a payment link, or upload an invoice PDF. Plain answer: *safe / pay up to X / don't pay*. Flags a vendor's changed wallet (invoice-swap fraud). |
| [**Address pages**](https://trycomplir.xyz/a/0x098b716b8aaf21512996dc57eb0615e2383e2f96) | Anyone | Public, shareable risk history of any wallet: every verdict, tier changes, attester, on-chain tx. |
| [**Arc Trust Map**](https://trycomplir.xyz/map) | Anyone | A live, chain-wide risk instrument: hundreds of real Arc wallets observed and graded as blocks arrive. |
| [**Payment links**](https://trycomplir.xyz/pay) | Merchants | Screen the payer before you accept. HIGH payers are declined automatically. |
| [**Guarded Payouts**](https://trycomplir.xyz/payouts) | Treasuries | A treasury that cannot pay a tainted address, with proof attached to every payment. |
| [**Browser extension**](https://trycomplir.xyz/tools) | USDC holders | Chips every address on any web page by tier; warns before you send to a HIGH wallet. |
| [**Telegram bot**](https://trycomplir.xyz/tools) | Non-technical users | `/check`, `/watch`, `/report` from chat. |
| [**Risk dataset**](https://trycomplir.xyz/stats) | Ecosystem | Signed daily statistics on Arc risk (JSON / CSV): share of observed USDC volume touching flagged wallets, tier mix, top reasons. |
| [**Tip market**](https://trycomplir.xyz/tips) | Researchers | Stake USDC on risk intelligence; verified tips are paid, bad tips are slashed; verified tips become evidence. |
| [**Shadow report**](https://trycomplir.xyz/shadow) / [**Badge**](https://trycomplir.xyz/badge) | Teams | What your current denylist would have missed; an embeddable "Screened by CompliR" badge. |
| [**Company**](https://trycomplir.xyz/company) · [**Ledger**](https://trycomplir.xyz/ledger) · [**Report**](https://trycomplir.xyz/report) | Auditors, judges | The operator's decisions, the hash-chained ledger with replay, the signed daily and monthly reports. |

## 7. Circle × Arc stack

| Circle / Arc primitive | How CompliR uses it | Status |
|---|---|---|
| **Arc mainnet** | Settlement, contracts, evidence (USDC system Transfer events), registry, anchors | Live |
| **USDC** | Native gas; payouts; `isBlacklisted` as a first-class risk signal | Live |
| **Contracts** | `AttestationRegistry`, `GuardedTreasuryV2` (verified) | Live |
| **x402 + Circle Facilitator** | Pay-per-screen, `eip155:5042`, idempotent, auto-refund on failure | Live |
| **Developer-Controlled Wallets** | Revenue + ops SCA wallets with app-enforced spending policies | Live |
| **Gas Station** | Sponsored gas for registry writes via the ops wallet (ERC-4337) | Live |
| **Earn Kit** | Idle-revenue sweep into Morpho USDC vaults, liquidity- and risk-filtered | Live (sweeps once revenue exceeds the float) |
| **CCTP** | Inbound bridged USDC: the source-chain sender is screened before it counts | Live tailer |
| **ERC-8004** | CompliR is agent #2418; counterparties' agent reputation is evidence; CompliR publishes validations | Live |

## 8. Integrate in minutes

**HTTP (any language)**
```bash
curl -s -X POST https://trycomplir.xyz/api/v1/screen \
  -H 'content-type: application/json' \
  -d '{"address":"0x098b716b8aaf21512996dc57eb0615e2383e2f96","amountUsdc":120}'
# → 402 with x402 payment requirements; an x402 client pays 0.01 USDC and retries.
curl -s https://trycomplir.xyz/api/v1/attestation/0x098b716b8aaf21512996dc57eb0615e2383e2f96   # free: latest signed verdict
```

**TypeScript SDK** (`packages/sdk`, x402 built in)
```ts
import { CompliR } from "@complir/sdk";
import { privateKeyToAccount } from "viem/accounts";

const c = new CompliR({ baseUrl: "https://trycomplir.xyz", account: privateKeyToAccount(PAYER_KEY) });
const v = await c.screen("0xPayee", { amountUsdc: 120, payeeBook });
if (v.tier === "HIGH") hold();
else pay(Math.min(120, v.recommendedLimits.maxPerTxUsdc));
await CompliR.verifyAttestation(v.attestation);   // offline EIP-712 check
```

**Solidity** (one line, opt-in)
```solidity
require(ICompliR(0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d).isAllowed(payee, ICompliR.Tier.MEDIUM), "CompliR: payee tier too high");
```

**MCP** (`packages/mcp`, 9 tools for Claude, Cursor and any agent): `screen_counterparty`, `watch_counterparty`, `shadow_report`, `get_attestation`, `verify_attestation`, `get_network_signal`, `get_decision`, `list_recent_tier_changes`, `company_status`, plus a `pay_safely` prompt.

**Webhooks:** `POST /api/v1/watch` → `tier.changed` events (header `x-complir-event`).

**Ready-made integration patches** (in `docs/integrations/`) for Circle's own Arc sample apps (`arc-escrow`, `arc-fintech`, `arc-p2p-payments`, `arc-ecommerce-payments`) and for STEWARD, Vestiarion and CeedeBooks: opt-in, non-breaking, each under ~150 lines.

## 9. Trust model

- **The model cannot move the score.** Deterministic rules own score and tier; the analyst's limits, cadence and EDD are clamped in code; unverified identifiers are stripped from its rationale. If the model times out, a deterministic fallback is used and marked as such.
- **Every verdict is signed** by the attester key and verifiable offline; the registry stores tier, expiry and decision hash.
- **Every decision is replayable** from the hash-chained ledger (`hash = keccak256(prevHash ‖ payload ‖ seq ‖ kind)`), with Merkle roots anchored on Arc (27 roots anchored at time of writing).
- **Contracts enforce, agents propose.** `GuardedTreasuryV2` refuses non-allowed payees and payments whose decision hash doesn't match the registry, so a wrong or compromised agent cannot pay a HIGH address.
- **Honest numbers.** Own wallets and internal clients are excluded from every public count; reports list refunds and mistakes; unstaked tip bounties are "recorded", never "paid".
- **Never holds client funds.** CompliR screens; your wallet or contract pays.

## 10. Architecture & repository

```
Next.js 16 app (App Router) ── 53 API routes, 23 pages ─┐
                                                        ├── libsql ledger + store
Workers: watcher · trust-map tailer · blocklist events ·│
  treasury · operator · tips · refunds · yield (Earn) · │
  CCTP · ERC-8004 sync · stats · report  ───────────────┘
OpenSanctions (yente + Elasticsearch, self-hosted)
Arc mainnet RPC · Circle APIs (x402 facilitator, Wallets, Gas Station, Earn) · 0G Compute (Claude)
```

| Path | Contents |
|---|---|
| `src/lib/evidence` | Collectors: funder graph, sanctions, blocklist, lookalikes, overrides (tests only) |
| `src/lib/scoring`, `src/lib/analyst`, `src/lib/llm` | Deterministic rules; guard-railed analyst; provider seam (Anthropic or 0G) |
| `src/lib/attest`, `src/lib/ledger`, `src/lib/chain` | EIP-712 signing; hash chain + Merkle anchoring; registry writer and anchor writer |
| `src/lib/pay`, `src/lib/refunds` | x402 v2 over Circle's facilitator; automatic refunds |
| `src/lib/circle`, `src/lib/earn` | Developer-Controlled Wallets, policies, contract execution; Earn Kit sweep |
| `src/lib/operator`, `src/lib/treasury`, `src/lib/guarantee` | The agent that runs the company; guarded payouts and tranches; LOW-verdict bonds |
| `src/lib/trustmap`, `src/lib/events`, `src/lib/network`, `src/lib/cctp`, `src/lib/erc8004` | Live chain monitoring and signals |
| `src/lib/check`, `src/lib/paylinks`, `src/lib/tips`, `src/lib/stats`, `src/lib/reports` | Consumer and ecosystem products |
| `contracts/` | Foundry: `ICompliR`, `AttestationRegistry`, `GuardedTreasuryV2` |
| `packages/sdk`, `packages/mcp`, `packages/extension`, `packages/bot` | SDK, MCP server, browser extension, Telegram bot |
| `deploy/vps/` | Production compose stack + nginx site |

## 11. Run, test, deploy

```bash
cp .env.example .env.local            # fill ARC_*, keys, Circle, LLM provider
docker compose -f docker/yente/docker-compose.yml up -d   # OpenSanctions (optional locally)
npm install && npm run dev            # http://localhost:3000
npx tsx --env-file=.env.local worker/all.ts               # all background loops
```

| Check | Result |
|---|---|
| `npm test` | 379 tests, 48 files, passing |
| `cd contracts && forge test` | 61 tests passing (incl. a cross-language EIP-712 test against the TypeScript signer) |
| `npm run build` | clean |

Production runs as one compose project on a VPS (`deploy/vps/`): app, workers, yente and its index, localhost-only behind nginx with Let's Encrypt. See [`docs/DEPLOY.md`](docs/DEPLOY.md).

## 12. Honest status

- **Usage:** the product is live and every payment shown is real, but at the time of writing the paying callers are our own wallets (excluded from public numbers). Free screenings and the prepared integration PRs are being offered to Tameion teams.
- **Earn sweep:** live, but it only deposits once revenue exceeds the float, so no deposit has executed yet.
- **USYC:** kept as an alternative backend; its mainnet minimum puts it out of reach at our scale.
- **Evidence limits:** the funder trace uses public RPC within a bounded lookback; sanctions coverage of crypto addresses is only as complete as the public lists.

## 13. How this maps to the judging criteria

| Criterion | Where to look |
|---|---|
| **Agentic sophistication (30%)** | The operator decides sweep / payout / price with written reasons and rejected alternatives ([/company](https://trycomplir.xyz/company)); the analyst decides limits, EDD and cadence under code guards; tranche schedules and re-grade timing are agent decisions; every one is replayable in the [ledger](https://trycomplir.xyz/ledger). |
| **Traction (30%)** | Real mainnet USDC flows (x402 settlements, payouts, refunds path); a public, honest numbers page and signed daily report; integration PRs ready for seven projects including Circle's sample apps. |
| **Circle tool usage (20%)** | Nine primitives in production: Arc, USDC, Contracts, x402 Facilitator, Developer-Controlled Wallets, Gas Station, Earn Kit, CCTP, ERC-8004 (section 7). |
| **Innovation (20%)** | Compliance as an on-chain primitive any contract can read; two-hop taint on Arc; verdicts that are signed, continuous and replayable; payouts that carry their proof; a company run by an agent whose product is risk. |

---

<sub>CompliR never holds client funds. Verdicts are risk signals, not legal advice. Sanctions data: OpenSanctions (CC BY-NC for non-commercial use).</sub>
