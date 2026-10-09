# CompliR — Counterparty Risk Oracle for Agents on Arc

> **Version 2 (2026-10-09).** Supersedes v1 ("Continuous Autonomous Compliance & Risk Intelligence Protocol").
> v1 was a dashboard-first compliance sidecar. v2 is **infrastructure**: the screening layer every other
> Arc treasury agent plugs into. Why we pivoted → see [docs/HACKATHON_STRATEGY.md](docs/HACKATHON_STRATEGY.md).

**One line:** *CompliR grades any counterparty on Arc (0–100), explains why, signs the verdict, and keeps
re-grading it forever. Agents call it over x402 for a cent. Contracts can read the verdict on-chain.*

**Event:** Tameion Agents Hackathon (Canteen × Circle × Arc) · RFB 05 Compliance Intelligence · Deadline **Oct 17, 2026 11:59 PM ET**
**Network:** Arc mainnet (chain ID 5042) for production; Canteen-hosted Arc testnet for development.
**We never hold client funds.** CompliR screens; the client's own wallet/contract pays. This is deliberate (trust + zero custody risk).

---

## 1. The problem (as judges see it)

Every treasury agent in this hackathon has a home-rolled screen: a static denylist, OFAC on refunds only,
one-hop funder lookups, or OpenSanctions once per cycle locked inside their own product. All of them are
binary (pay / don't pay), none look past the first hop, none issue a verdict another system can verify,
and none re-grade after onboarding. RFB 05 says it plainly: *"Compliance screening today is a single
yes-or-no check, run once at the moment of payment."* Nobody is building the fix as a shared service.

## 2. What CompliR is

```
                 ┌────────────────────────────────────────────────────────────┐
  Treasury       │                        CompliR                             │
  agents         │                                                            │
  (Vestiarion,   │  POST /v1/screen ──► Evidence ──► Risk Analyst ──► Verdict  │
   STEWARD,      │   (x402, $0.01)      Collector     (agent)       (signed)   │
   CeedeBooks,   │                        │             │              │       │
   Mandate, …)   │   yente/OpenSanctions ─┤             │              ├─► JSON + EIP-712 attestation
       │         │   Arc chain graph ─────┤             │              ├─► AttestationRegistry.sol (Arc)
       └── SDK ──┤   USDC blacklist ──────┤             │              └─► Decision Log (hash-chained)
                 │   Arc protocol blocklist┤             │                                              
                 │   Client payee book ───┘             └─► picks tier, limits, EDD, next re-screen time
                 │                                                            │
                 │  POST /v1/watch ──► Watcher (adaptive cadence) ──► webhook + on-chain TierChanged
                 └────────────────────────────────────────────────────────────┘
```

### 2.1 Core API (x402-paid, Circle facilitator on Arc)

| Endpoint | Price | What it does |
|---|---|---|
| `POST /v1/screen` | 0.01 USDC | Full grade of one address (+ optional name/entity, amount, client payee book). Returns verdict + signed attestation. |
| `POST /v1/watch` | 0.05 USDC / 30 days | Register address + webhook. CompliR re-screens on an adaptive schedule and pushes on any tier change. |
| `GET /v1/attestation/:address` | free | Latest attestation (public, verifiable). Powers the public Arc Trust Explorer page. |
| `POST /v1/shadow` | free during event | Client posts its payee list + recent payments; CompliR returns "what we would have held that you paid" — onboarding tool for sceptics (organizers endorse shadow mode). |

### 2.2 Verdict shape

```jsonc
{
  "address": "0x…",
  "score": 37,                       // 0–100, deterministic
  "tier": "MEDIUM",                  // LOW 0–20 · MEDIUM 21–60 · HIGH 61–100
  "recommendedLimits": { "maxPerTxUsdc": 250, "maxPerDayUsdc": 1000 },   // scaled by tier; client policy can adopt directly
  "reasons": [
    { "code": "FUNDER_2HOP_SANCTIONED", "weight": 25, "evidence": { "path": ["0xA","0xB","0xSDN"], "txs": ["0x…"] } },
    { "code": "FRESH_WALLET", "weight": 8,  "evidence": { "firstSeen": "2026-10-06T…", "txCount": 3 } },
    { "code": "LOOKALIKE_OF_KNOWN_PAYEE", "weight": 4, "evidence": { "matches": "0x12ab…9f3c (your payee 'Lela')" } }
  ],
  "rationale": "…plain-English explanation written by the Risk Analyst agent…",
  "eddRequested": ["Ask counterparty to confirm source of funds for 0xB (12 USDC in, 2026-10-04)"],
  "nextRescreenAt": "2026-10-10T03:00:00Z",   // agent-chosen cadence: HIGH hourly, MEDIUM daily, LOW weekly
  "attestation": { "typedData": {…EIP-712…}, "signature": "0x…", "validUntil": 1760000000, "registryTx": "0x…" },
  "decisionId": "dec_01J…",                   // links to hash-chained decision log entry
  "screenedAt": "2026-10-09T…"
}
```

### 2.3 Risk Analyst agent (the "agentic" 30%)

Deterministic rules produce the **score and tier**. The LLM agent cannot change them. What the agent *decides*:

1. **Which evidence to pull next** (e.g. go a second hop only when first hop has a hit or is < 7 days old) — saves cost, explainable.
2. **Recommended limits within the tier band** given amount, history and the client's payee book.
3. **Whether to request Enhanced Due Diligence (EDD)** and which specific questions, instead of a flat refusal.
4. **Next re-screen time** — adaptive cadence per counterparty rather than a cron.
5. **The rationale** — a reviewer can replay it from the evidence stored alongside.

Every decision (including "no action") is appended to a **hash-chained decision log** whose Merkle root is
anchored to Arc every N decisions. That is the Athenian *euthyna* from the hackathon page: a continuous audit.

### 2.4 Evidence Collector — data sources (no restricted APIs)

| Source | Signal | Cost |
|---|---|---|
| Self-hosted **yente** (OpenSanctions) | SDN/PEP/sanctions by name + known crypto addresses | free, Docker |
| **Arc RPC / Blockscout** | 2-hop funder graph, first-seen, tx count, counterparties | free |
| **USDC `isBlacklisted(addr)`** on Arc | Circle-level freeze flag | free, 1 call |
| **Arc protocol blocklist** | chain-level denylist | free |
| **Client payee book** (optional in request) | address-poisoning / lookalike detection, payee-change detection | — |
| Our own **attestation history** | grade drift over time, repeat offenders across clients | — |

*Circle Compliance Engine is NOT used: access is restricted, beta, and Arc is not on its supported list.*

### 2.5 On-chain: `AttestationRegistry.sol` (Circle Contracts on Arc)

```solidity
interface ICompliR {
    enum Tier { UNKNOWN, LOW, MEDIUM, HIGH }
    function tierOf(address subject) external view returns (Tier tier, uint64 validUntil, bytes32 decisionHash);
    event Attested(address indexed subject, Tier tier, uint64 validUntil, bytes32 decisionHash);
    event TierChanged(address indexed subject, Tier from, Tier to);
}
```

Other teams' treasury contracts (Mandate, Syn DAO, CeedeBooks, Tamias) can add one line:
`require(compliR.tierOf(payee).tier <= Tier.MEDIUM && validUntil > block.timestamp)`.
Compliance becomes a composable on-chain primitive. Nobody else in the field has this.

### 2.6 SDK — `@complir/sdk` (npm) + `ICompliR.sol`

```ts
import { CompliR } from "@complir/sdk";
const c = new CompliR({ wallet /* x402 payer: Circle agent wallet */ });
const v = await c.screen("0xPayee", { amountUsdc: 120, payeeBook: myPayees });
if (v.tier === "HIGH") hold(); else pay(Math.min(amount, v.recommendedLimits.maxPerTxUsdc));
await c.watch("0xPayee", { webhook: "https://me/complir" });
CompliR.verifyAttestation(v.attestation); // offline, no network
```

### 2.7 Minimal UI (judges click around alone)

- **Arc Trust Explorer** `/` — paste any address → grade, reasons, funder graph (2 hops, small SVG), attestation link to explorer.
- **Live feed** `/feed` — anonymised screenings as they happen (traction proof).
- **Numbers** `/numbers` — public, honest: outside payers (addresses + tx links), own-wallet calls excluded, refunds listed.
- **Decision log** `/log/:id` — replayable evidence + rationale + anchor tx.

No PDF exporter, no dashboard shell. Export = JSON/Markdown of the decision log.

---

## 3. Circle / Arc stack usage (20% of score)

| Tool | How CompliR uses it |
|---|---|
| **x402 Facilitator (Circle, Arc mainnet)** | Monetises `/screen` and `/watch`. Real outside USDC flow = traction. |
| **Developer-Controlled Wallets** | CompliR revenue wallet + a separate ops wallet (gas for registry writes). Spending policy caps ops wallet. |
| **Contracts** | `AttestationRegistry.sol` on Arc; verified on explorer. |
| **Gateway** | Accept x402 payments from clients on Base/other chains as one USDC balance. |
| **USYC** | Revenue agent sweeps idle revenue above float into USYC weekly (tiny, but it's the Parable of the Talents hack and shows a second autonomous loop). |
| **Paymaster / Gas Station** | Registry writes paid in USDC; webhook-triggered writes never need a gas token. |
| **USDC contract** | `isBlacklisted` as a first-class evidence source. |

---

## 4. Non-goals (cut deliberately)

- Custody / quarantine vault — clients keep their money; CompliR is read-only on funds.
- PDF regulatory dossier — replaced by verifiable decision log export.
- Full interactive graph canvas — one small 2-hop SVG per verdict is enough.
- Real sanctioned addresses in tests — **never pay one.** Simulate HIGH via a local override label on our own wallets.

---

## 5. Repo layout (target)

```
src/app/                      Next.js 16 (read node_modules/next/dist/docs before touching)
  page.tsx                    Arc Trust Explorer
  feed/ numbers/ log/[id]/
  api/v1/screen|watch|attestation|shadow/route.ts
src/lib/
  evidence/   yente.ts arcGraph.ts usdcBlacklist.ts protocolBlocklist.ts lookalike.ts
  scoring/    rules.ts (deterministic) tiers.ts limits.ts
  analyst/    agent.ts prompts/ (Claude; decides evidence depth, EDD, cadence, rationale)
  attest/     eip712.ts registry.ts
  ledger/     decisionLog.ts (hash chain) anchor.ts (Merkle root → Arc)
  pay/        x402.ts (Circle facilitator) wallets.ts
worker/       watcher.ts (long-running; NOT Vercel serverless) — Railway/Fly + yente Docker
contracts/    AttestationRegistry.sol  ICompliR.sol  (Foundry; OpenZeppelin Ownable2Step + Pausable)
packages/sdk/ @complir/sdk
docs/         HACKATHON_STRATEGY.md  INTEGRATION.md  TRACTION.md (daily updates)
```

## 6. Environment switch (testnet → mainnet)

All of the following come from env, nothing hard-coded: `ARC_CHAIN_ID`, `ARC_RPC_URL`, `USDC_ADDRESS`,
`REGISTRY_ADDRESS`, `X402_NETWORK`, `CIRCLE_WALLET_ID_REVENUE`, `CIRCLE_WALLET_ID_OPS`, `ANCHOR_EVERY_N`.
Develop on testnet until **Oct 13**, flip to mainnet, keep ≤ 100 USDC on-chain at any time, kill-switch env `COMPLIR_PAUSED=1`.
