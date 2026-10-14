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
9. [API reference](#9-api-reference)
10. [Reason codes and scoring](#10-reason-codes-and-scoring)
11. [Trust model](#11-trust-model)
12. [Architecture](#12-architecture)
13. [Configuration and security](#13-configuration-and-security)
14. [Run, test, deploy](#14-run-test-deploy)
15. [Build log](#15-build-log)
16. [Honest status](#16-honest-status)
17. [Roadmap](#17-roadmap)

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
| [**Operations console**](https://trycomplir.xyz/app) | Everyone | One view of the company: status, KPIs, live decision ticker, today's operator decision, the trust map at a glance. |
| [**Check**](https://trycomplir.xyz/check) | Anyone | Paste an address, a payment link, or upload an invoice PDF. Plain answer: *safe / pay up to X / don't pay*. Flags a vendor's changed wallet (invoice-swap fraud). |
| [**Address pages**](https://trycomplir.xyz/a/0x098b716b8aaf21512996dc57eb0615e2383e2f96) | Anyone | Public, shareable risk history of any wallet: every verdict, tier changes, attester, on-chain tx. |
| [**Arc Trust Map**](https://trycomplir.xyz/map) | Anyone | A live, chain-wide risk instrument: hundreds of real Arc wallets observed and graded as blocks arrive. |
| [**Payment links**](https://trycomplir.xyz/pay) | Merchants | Screen the payer before you accept. HIGH payers are declined automatically. |
| [**Guarded Payouts**](https://trycomplir.xyz/payouts) | Treasuries | A treasury that cannot pay a tainted address, with proof attached to every payment. |
| [**Browser extension**](https://trycomplir.xyz/tools) | USDC holders | Manifest V3 (Chrome, Brave, Edge). Chips every address on any web page by tier, warns before you send to a HIGH wallet, 10-minute cache, skips CompliR's own pages. |
| [**Telegram bot**](https://trycomplir.xyz/tools) | Non-technical users | `/check`, `/watch`, `/report` from chat. |
| [**Risk dataset**](https://trycomplir.xyz/stats) | Ecosystem | Signed daily statistics on Arc risk (JSON / CSV): share of observed USDC volume touching flagged wallets, tier mix, top reasons. |
| [**Tip market**](https://trycomplir.xyz/tips) | Researchers | Stake USDC on risk intelligence; verified tips are paid, bad tips are slashed; verified tips become evidence. |
| [**Shadow report**](https://trycomplir.xyz/shadow) / [**Badge**](https://trycomplir.xyz/badge) | Teams | What your current denylist would have missed; an embeddable "Screened by CompliR" badge. |
| [**Company**](https://trycomplir.xyz/company) · [**Ledger**](https://trycomplir.xyz/ledger) · [**Feed**](https://trycomplir.xyz/feed) · [**Report**](https://trycomplir.xyz/report) | Auditors, judges | The operator's decisions; the hash-chained ledger and live feed (paginated, 20 per page) with per-decision replay; the signed daily report and monthly transparency rollup. |
| [**Integrate with your AI agent**](https://trycomplir.xyz/docs/agent-prompt) | Developers | A copy-paste prompt that makes Claude Code, Cursor or Codex wire CompliR into any codebase; the same guide is served at [`/llms.txt`](https://trycomplir.xyz/llms.txt). |

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

**Fastest: hand it to your coding agent.** Open [trycomplir.xyz/docs/agent-prompt](https://trycomplir.xyz/docs/agent-prompt), copy the prompt into Claude Code, Cursor or Codex inside your repo. The agent lists every place your code sends or receives USDC, adds one `checkAddress()` module, applies the policy (block HIGH, cap MEDIUM, pass LOW), adds env switches (`COMPLIR_URL`, `COMPLIR_FAIL_MODE`), writes tests, and proves the result against a real OFAC-listed wallet. Agents that read [`/llms.txt`](https://trycomplir.xyz/llms.txt) get the same instructions automatically.

**HTTP (any language)**
```bash
curl -s -X POST https://trycomplir.xyz/api/v1/screen \
  -H 'content-type: application/json' \
  -d '{"address":"0x098b716b8aaf21512996dc57eb0615e2383e2f96","amountUsdc":120}'
# → 402 with x402 v2 payment requirements; an x402 client pays ~0.01 USDC and retries.
curl -s https://trycomplir.xyz/api/v1/attestation/0x098b716b8aaf21512996dc57eb0615e2383e2f96   # free: latest signed verdict
```

**TypeScript SDK** (`packages/sdk`, x402 built in)
```ts
import { CompliR } from "@complir/sdk";
import { privateKeyToAccount } from "viem/accounts";

const c = new CompliR({ baseUrl: "https://trycomplir.xyz", account: privateKeyToAccount(PAYER_KEY), maxPriceUsdc: 0.05, network: "eip155:5042" });
const v = await c.screen("0xPayee", { amountUsdc: 120, payeeBook });
if (v.tier === "HIGH") hold(v.rationale);
else pay(Math.min(120, v.recommendedLimits.maxPerTxUsdc));
await c.watch("0xPayee", { webhookUrl: "https://you.example/complir" });
await CompliR.verifyAttestation(v.attestation, { expectedChainId: 5042 });   // offline EIP-712 check
```

**Solidity** (one line, opt-in)
```solidity
require(ICompliR(0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d).isAllowed(payee, ICompliR.Tier.MEDIUM), "CompliR: payee tier too high");
```

**MCP** (`packages/mcp`, stdio and HTTP): `screen_counterparty`, `watch_counterparty`, `shadow_report`, `get_attestation`, `verify_attestation`, `get_network_signal`, `get_decision`, `list_recent_tier_changes`, `company_status`, plus a `pay_safely` prompt.
```bash
claude mcp add complir -e COMPLIR_URL=https://trycomplir.xyz -- node /path/to/CompliR/packages/mcp/bin/complir-mcp.mjs
```

**Webhooks:** `POST /api/v1/watch` → `tier.changed` events (header `x-complir-event`), delivered when the agent's cadence or a Circle blocklist event changes a tier.

**Telegram bot** (`packages/bot`, dependency-free): `/check <address>`, `/watch <address>`, `/report`.

**Prepared integration PRs** (`docs/integrations/`), opt-in and non-breaking, each with `PATCH.diff`, `PR.md` and `NOTES.md`, all passing `git apply --check`:

| Target | Gate added |
|---|---|
| Circle `arc-escrow` | Solidity `isAllowed` in withdraw paths + server-side pre-check |
| Circle `arc-fintech` | Server-side gate on payouts and wallet transfers |
| Circle `arc-p2p-payments` | Recipient screen before the passkey-signed user operation |
| Circle `arc-ecommerce-payments` | Gate on capture (receiver) and refund (payer) |
| STEWARD | CompliR provider beside the existing denylist; HIGH → SCREEN_FAIL, MEDIUM → per-tx cap |
| Vestiarion | Stricter-wins merge with OpenSanctions; recommended limit + attestation stored with the signed decision |
| CeedeBooks | Agent-side check before proposing a payment + opt-in `require` in the vendor contract |

## 9. API reference

Base URL `https://trycomplir.xyz`. Paid routes use x402 v2 on `eip155:5042` (USDC `0x3600…0000`); the price is set by the operator within bounds (screen 0.005-0.05 USDC, watch 0.02-0.2 USDC). Same-origin browser calls from the hosted UI are free. Errors are `{error:{code,message}}`.

| Method & path | Price | Purpose |
|---|---|---|
| `POST /api/v1/screen` | x402 | Full verdict for one address (`address`, optional `name`, `amountUsdc`, `payeeBook`, `clientId`) |
| `POST /api/v1/watch` | x402 | Re-grade an address for 30 days and push `tier.changed` webhooks |
| `GET /api/v1/attestation/:address` | free | Latest stored signed verdict (404 if never screened) |
| `POST /api/v1/check` | free, rate-limited | Plain-language verdict for people (`headline`, `advice`, `shareUrl`) |
| `POST /api/v1/check/invoice` | free | Extract wallet addresses, vendor and amount from an invoice PDF |
| `GET /api/v1/address/:address` | free | Public verdict history, tier changes, open EDD |
| `POST /api/v1/shadow` | free | Screen a payee book: what your denylist would have missed |
| `GET /api/v1/badge/:address.svg` | free | "Screened by CompliR" SVG badge |
| `GET /api/v1/network/:address` · `/network/events` | free | Anonymised cross-client signal; blocklist events handled |
| `GET /api/v1/inbound` · `/inbound/:address` | free | CCTP inbound mints and source-sender screening |
| `POST /api/v1/edd` · `GET /edd/:id` · `POST /edd/:id/answer` | free | Enhanced due diligence: questions, hashed answers, re-screen |
| `POST /api/v1/pay` · `GET /pay/:id` · `POST /pay/:id/screen` · `POST /pay/:id/decide` | free | Merchant payment links with payer screening |
| `GET /api/v1/payouts` | free | Guarded Payouts invoices, tranches, proofs |
| `GET /api/v1/guarantee/:decisionId` · `POST /guarantee/claim` | free | LOW-verdict bond and claim |
| `GET /api/v1/tips` · `/tips/:id` · `POST /tips` | free / x402 stake | Tip market |
| `GET /api/v1/map` · `/map/:address` · `/map/changes` | free | Trust Map snapshot, node history, tier changes |
| `GET /api/v1/ledger` · `/ledger/verify` · `/decision/:id` | free | Hash-chained ledger (paginated), chain check, decision replay |
| `GET /api/v1/feed` · `/numbers` · `/company` | free | Live feed, honest counters, operator snapshot |
| `GET /api/v1/report` · `/report/:date` · `/report/monthly/:period` | free | Signed daily and monthly reports (JSON or `.md`) |
| `GET /api/v1/stats` · `/stats/:date` · `/stats/latest.csv` | free | Signed daily Arc risk dataset |
| `GET /api/v1/health` | free | Network, signer mode, x402 status, live prices |
| `GET /llms.txt` · `/.well-known/agent-registration.json` | free | Agent integration guide; ERC-8004 registration file |

Internal cron routes (`/api/internal/*`: watcher, trustmap, events, cctp, treasury, operator, tips, refunds, usyc/yield, report, stats, circle) require `Authorization: Bearer $CRON_SECRET`.

## 10. Reason codes and scoring

Deterministic rules sum weighted reasons into a 0-100 score (clamped). Repeated funder hits at the same hop decay (100%, 50%, 25%, ...). Any of `SANCTIONS_DIRECT`, `USDC_BLACKLISTED`, `PROTOCOL_BLOCKLISTED` floors the score at 61 (HIGH).

| Code | Weight | Meaning |
|---|---|---|
| `SANCTIONS_DIRECT` | 100 | Address or name matched in OpenSanctions |
| `USDC_BLACKLISTED` | 100 | Circle's USDC `isBlacklisted` is true on Arc |
| `PROTOCOL_BLOCKLISTED` | 100 | Protocol-level blocklist (hook; none documented on Arc today) |
| `FUNDER_1HOP_SANCTIONED` / `_BLACKLISTED` | 30 | A direct funder is sanctioned / blacklisted |
| `FUNDER_2HOP_SANCTIONED` / `_BLACKLISTED` | 15 | A funder's funder is sanctioned / blacklisted |
| `LOOKALIKE_OF_KNOWN_PAYEE` | 25 | Address-poisoning pattern against your payee book |
| `PRIOR_HIGH_TIER` | 20 | Rated HIGH within the last 30 days |
| `NETWORK_HELD_ELSEWHERE` | 20 | Rated HIGH by other CompliR clients this week (anonymised; 10 for one client) |
| `INBOUND_FLAGGED` | 20 | Received bridged USDC (CCTP) from a flagged source-chain sender |
| `PAYEE_ADDRESS_CHANGED` | 15 | Same payee name, new address |
| `COMMUNITY_TIP_VERIFIED` | 15 | A staked tip about this address was verified |
| `AGENT_DISPUTED` | 15 | ERC-8004 agent with negative feedback or disputes |
| `NO_HISTORY` | 10 | No on-chain footprint on Arc |
| `HIGH_CONCENTRATION` | 10 | Shares a funder with many other payees |
| `FRESH_WALLET` | 8 | First seen < 7 days or < 5 transactions |
| `NETWORK_SHARED_FUNDER` | 8 | Shares a funder with several of your own payees |
| `AGENT_REGISTERED` / `AGENT_VALIDATED` | -5 each | Registered ERC-8004 agent / validated by a third party |

Tiers: LOW 0-20 (full limits, 7-day attestation), MEDIUM 21-60 (capped limits + EDD, 24 h), HIGH 61-100 (limits 0, 1 h). Re-screen windows: HIGH ≤ 1 h, MEDIUM ≤ 24 h, LOW ≤ 7 d, tightened after any tier change.

## 11. Trust model

- **The model cannot move the score.** Deterministic rules own score and tier; the analyst's limits, cadence and EDD questions are clamped in code; tx hashes or addresses in its rationale that don't appear in the evidence are stripped. If the model times out, a deterministic fallback is used and recorded as such.
- **Every verdict is signed** by the attester key (EIP-712 domain `CompliR` v1, chain 5042, verifying contract = registry) and verifiable offline; the registry stores tier, score, expiry and decision hash, with replay protection.
- **Every decision is replayable** from the hash-chained ledger (`hash = keccak256(prevHash ‖ payload ‖ seq ‖ kind)`), with Merkle roots anchored on Arc.
- **Contracts enforce, agents propose.** `GuardedTreasuryV2` refuses non-allowed payees and payments whose decision hash doesn't match the registry, so a wrong or compromised agent cannot pay a HIGH address.
- **Honest numbers.** Own wallets and internal client ids are excluded from every public count; reports list refunds and mistakes; unstaked tip bounties are "recorded", never "paid".
- **Never holds client funds.** CompliR screens; your wallet or contract pays.

## 12. Architecture

```
            ┌─────────────────────── trycomplir.xyz (nginx + Let's Encrypt) ───────────────────────┐
            │  Next.js 16 app: 23 pages · 40 public API routes · 12 internal cron routes              │
            └───────────────┬───────────────────────────────────────────────┬───────────────────────┘
                            │ libsql (shared volume)                         │
            ┌───────────────┴──────────────┐                ┌──────────────┴───────────────┐
            │ Workers (one process)        │                │ OpenSanctions: yente +        │
            │ events 20 s · trustmap 30 s  │                │ Elasticsearch (self-hosted)   │
            │ watcher 60 s · treasury 60 s │                └──────────────────────────────┘
            │ cctp 60 s · tips 5 m ·       │
            │ refunds 5 m · erc8004 15 m · │      Arc mainnet RPC · Circle (x402 facilitator,
            │ operator / yield / stats /   │      Developer-Controlled Wallets, Gas Station,
            │ report hourly                │      Earn) · 0G Compute Router (Claude)
            └──────────────────────────────┘
```

| Path | Contents |
|---|---|
| `src/lib/evidence` | Collectors: 2-hop funder graph (Arc USDC system Transfer emitter), sanctions, blocklist, lookalikes, overrides (tests only) |
| `src/lib/scoring` · `analyst` · `llm` | Deterministic rules; guard-railed analyst; provider seam (Anthropic or 0G Compute) |
| `src/lib/attest` · `ledger` · `chain` | EIP-712 signing; hash chain + Merkle anchoring; registry and anchor writers |
| `src/lib/pay` · `refunds` | x402 v2 over Circle's facilitator (idempotent, settle-first option); automatic refunds |
| `src/lib/circle` · `earn` · `usyc` | Developer-Controlled Wallets, policies, contract execution; Earn Kit sweep; USYC alternative |
| `src/lib/operator` · `treasury` · `guarantee` | The agent that runs the company; guarded payouts and tranches; LOW-verdict bonds |
| `src/lib/trustmap` · `events` · `network` · `cctp` · `erc8004` | Chain-wide monitoring and signals |
| `src/lib/check` · `paylinks` · `tips` · `stats` · `reports` · `edd` · `integration` | Consumer, ecosystem and integration products |
| `contracts/` | Foundry: `ICompliR`, `AttestationRegistry`, `GuardedTreasuryV2` |
| `packages/sdk` · `mcp` · `extension` · `bot` | SDK, MCP server, browser extension, Telegram bot |
| `worker/all.ts` | All background loops in one process |
| `deploy/vps/` | Production compose project (`complir`), app Dockerfile, nginx site |

## 13. Configuration and security

- All configuration is environment-driven (`.env.example` documents every key, grouped: network, keys, data, payments, Circle, LLM, treasury, yield, trust map, events, tips, refunds, reports).
- Secrets live only in `.env.local` / `.env.production` (gitignored, root-only on the server).
- Production binds only to localhost behind nginx; the search index has no host port; containers run with memory caps.
- Kill switch: `COMPLIR_PAUSED=1` stops paid work and on-chain writes. Every outbound transfer carries an idempotency key; refunds and payouts have daily caps.
- Circle wallet spending policies (per-tx, daily, contract allowlist) are enforced in code before any call reaches Circle; registry writes go through the ops wallet, payouts and refunds through the revenue wallet.

## 14. Run, test, deploy

```bash
cp .env.example .env.local            # fill ARC_*, keys, Circle, LLM provider
docker compose -f docker/yente/docker-compose.yml up -d   # OpenSanctions (optional locally)
npm install && npm run dev            # http://localhost:3000
npx tsx --env-file=.env.local worker/all.ts               # all background loops
```

| Check | Result |
|---|---|
| `npm test` | 379 tests in 48 files, passing |
| `cd contracts && forge test` | 61 tests passing, incl. a cross-language EIP-712 test against the TypeScript signer |
| `npx tsc --noEmit` · `npm run build` | clean |

**Production:** `docker compose -f deploy/vps/docker-compose.yml --env-file .env.production --profile workers up -d --build` on any host with ~4 GB free RAM, then the nginx site in `deploy/vps/` and `certbot --nginx`. One-shot mainnet contract deployment and a live smoke test: `scripts/go-live.sh` and `scripts/go-live-check.mjs`. Details in [`docs/DEPLOY.md`](docs/DEPLOY.md).

## 15. Build log

| Date (2026) | What shipped |
|---|---|
| Sep 27 | Kickoff, architecture |
| Oct 9 | v2 spec: a risk oracle other agents call; shared types, config |
| Oct 11 | Evidence collector, scoring, analyst, EIP-712, ledger, store, contracts (registry + treasury), x402 + SDK, explorer UI, Trust Map, Guarded Payouts, EDD |
| Oct 12 | Circle Developer-Controlled Wallets + Gas Station relay |
| Oct 13 | Operator agent + Company page, auto-refunds, signed daily report, network signal, blocklist reactor, MCP server, tip market, console redesign, datasheet design system; **registry and treasury deployed to Arc mainnet**; OpenSanctions live; Claude via 0G; Circle wallets, Gas Station and x402 live on mainnet; all synthetic data removed |
| Oct 14 | Check page, address history, payment links, browser extension, Telegram bot, risk dataset, monthly report, GuardedTreasuryV2 with proof, tranches, guarantee, ERC-8004 agent #2418, CCTP inbound, Circle Earn sweep, Circle sample-app patches, production deploy at trycomplir.xyz, agent prompt and `llms.txt` |

## 16. Honest status

- **Usage:** live on mainnet and every payment shown is real, but at the time of writing the paying callers are our own wallets (excluded from public numbers). Free screenings and the prepared integration PRs are being offered to Tameion teams.
- **Earn sweep:** live, but it only deposits once revenue exceeds the float, so no deposit has executed yet.
- **USYC:** kept as an alternative backend; its mainnet minimum puts it out of reach at our scale.
- **Evidence limits:** the funder trace uses public RPC within a bounded lookback; sanctions coverage of crypto addresses is only as complete as the public lists; first-seen dates fall back to RPC when the explorer API is unavailable.
- **Analyst:** relayed Claude calls occasionally time out; those verdicts use the deterministic fallback and are marked as such in the ledger.

## 17. Roadmap

- Public "Built with CompliR" registry and an on-chain consumer counter (contracts calling `isAllowed`).
- Registry on additional chains (Base, Ethereum) with the same EIP-712 domain, and funder tracing there.
- Commercial OpenSanctions delivery and additional evidence sources; per-client policy profiles.
- Circle-side spending policies (Agent Wallets) instead of app-enforced ones.
- Merge the prepared integration PRs with partner teams; npm releases of the SDK and MCP server.

---

<sub>CompliR never holds client funds. Verdicts are risk signals, not legal advice. Sanctions data: OpenSanctions (CC BY-NC for non-commercial use).</sub>
