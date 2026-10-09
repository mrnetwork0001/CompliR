# CompliR — Tameion Hackathon Strategy & Competitive Landscape

*Written 2026-10-09 (8 days to deadline). Keep this updated; it is our memory.*

Event: https://tameion.thecanteenapp.com · Register: https://luma.com/ivroypr5 (passphrase `DIRECTx42490`)
Submit: https://forms.gle/BBWrdfuircrKiG2i6 · **Deadline Oct 17, 2026 11:59 PM ET** · submit early, resubmit often.
Needs: public GitHub repo + ≤3 min video (Loom/YouTube) + live link (strongly encouraged) + traction answers.
Discord: Canteen https://discord.gg/bDaEfsSqc8 (daily live chat on Canteen Stage, ~4:30 PM / 8:30 ET until Oct 17) · Arc builders https://discord.com/invite/buildonarc

---

## 1. Judging math and what it means for us

| Weight | Criterion | How CompliR scores it |
|---|---|---|
| 30% | Agentic sophistication — "does the AI decide, and can it explain why?" | Risk Analyst agent decides evidence depth, limits, EDD questions, re-screen cadence; every decision replayable from a hash-chained log. Rules set the score so the agent can't be talked into lowering it. |
| 30% | Traction — outside businesses, USDC actually flowing (test counts, mainnet counts more) | Other hackathon teams are our customers. Paid x402 calls from their wallets = outside USDC flow with tx links. |
| 20% | Circle tool usage | x402 facilitator, Dev-Controlled Wallets, Contracts (registry), Gateway, USYC sweep, Paymaster, USDC blacklist flag. |
| 20% | Innovation — "new territory beats polished re-runs" | On-chain attestation registry other contracts can read; 2-hop taint on Arc; graded limits as a service. Nobody has any of the three. |

Organizer signals (Aljosa, Discord, Oct 7–8):
- "Pick 1 business and get one loop working end to end with their real numbers." Shadow mode is fine.
- Proof of traction = **outside wallet addresses + tx links + who is behind them**. A short clip of a real user paying is even stronger.
- APEX got "No notes 🫡" for an *honest* update that listed a $0.003 mistaken charge and the same-hour on-chain refund.
- Judging is asynchronous. "Build for a reviewer who will click around without you in the room."

## 2. Why v1 would not have placed

- Prior Art #07 on the event page *is* v1 (continuous re-screen, yente, nomenklatura, vendor's vendor, scaled limits). It's the expected answer to RFB 05 → low innovation.
- A dashboard-first sidecar moves no money → no traction to show.
- Score bands → limits is a rules engine, "a cron job with an LLM bolted on."
- PDF dossier + graph canvas = days of work for ~0 points.

## 3. The field (as of Oct 9) — what others are building

**Template almost everyone converged on:** "agent proposes, contract decides, every decision signed."
Arc Guardian, Vestiarion, CeedeBooks, Mandate, Syn DAO, STEWARD, Tamias (×2), Thesauros, APEX Treasury Operator, BizArc.
Mainnet is table stakes: Mandate (since Sep 30), Syn DAO, Keryx, Vestiarion, VCCFly, Tamias, nibgate, FajuARC.

**How screening is done today (all thin, all internal):**

| Team | Screening | Gap we fill |
|---|---|---|
| STEWARD (github.com/big14way/steward) | local denylist + Arc protocol blocklist, before each decision, testnet | no sanctions source, no rescreen, binary |
| Vestiarion (github.com/duongnq2798/vestiarion) | OpenSanctions re-screen every agent cycle, hit lowers limit — *closest to us* | internal only, 1 hop, no portable verdict |
| Tamias (laurenthalbrun) | 1-hop funder trace, concentration report | no risk score, no sanctions data |
| APEX (apexfaucet-hub/apex-treasury-operator) | OFAC SDN + USDC `isBlacklisted` on **refunds only** | ordinary payments unscreened |
| CeedeBooks, Mandate, Syn DAO, BizArc | vendor registry / allowlist / caps | no screening at all |

**Nobody** does 2nd-degree exposure, graded risk as a service, continuous watch with push, or an on-chain verdict.
→ RFB 05 as a *shared service* is open.

**Traction leaders (self-reported, tiny, honest):** APEX 550 paid x402 calls / 14 outside wallets / $2.73; nibgate 11 creators, 71 unlocks, ~$35 mainnet; Syncly web2 Nigerian businesses via naira→USDC escrow; Tamias 13 external wallets; Vestiarion one 0.10 USDC mainnet payment + 1 new workspace.
Lesson: numbers are small everywhere. **Verifiable + honest** beats big.

**Circle Compliance Engine:** restricted access (request form), beta, Arc not on supported list. Do not depend on it. Yente + on-chain signals instead.

## 4. Standout features — the ones that can win 1st

Ranked by (points gained) / (hours to build). Build top-down; stop when time runs out.

1. **`AttestationRegistry.sol` — compliance as an on-chain primitive.** Any treasury contract adds one `require(compliR.tierOf(payee)…)`. Turns every "agent proposes, contract decides" project into a potential integrator. Verified on explorer. *Innovation + Circle Contracts + composability story in the video.*
2. **2-hop taint propagation on Arc with evidence paths.** Score decays per hop (e.g. direct hit 60, hop-1 30, hop-2 15); each reason carries the tx path so a reviewer can click through. Tamias does 1 hop with no score; nobody does 2.
3. **Integration PRs to competitors' public repos.** STEWARD, Vestiarion, CeedeBooks, Tamias, Mandate are open source. We write the `CompliR` provider adapter and open the PR ourselves. Merged or not, the PR is public evidence of adoption effort; merged = real outside usage. Highest-leverage traction move available.
4. **Shadow-mode report (`/v1/shadow`).** "Your denylist passed 2 payments CompliR would have held." Free, zero-risk, matches Aljosa's advice verbatim, and converts sceptics into watchers.
5. **Address-poisoning / lookalike detection against the client's payee book.** Tamias logged 3 poisoning attempts in one month; Syncly flags changed wallet addresses. Concrete, cheap (prefix/suffix Levenshtein), and every judge understands it instantly.
6. **Adaptive re-screen cadence chosen by the agent** (HIGH hourly → LOW weekly, tightened after any tier change). This is the clearest "the AI decides *when*, not just *what*" example. Emit `TierChanged` on-chain so contracts/webhooks react.
7. **EDD instead of refusal.** MEDIUM → agent drafts the exact due-diligence question; counterparty answers via a link; answer hashed into the decision log; tier can be revised. Turns "no" into a workflow (RFB 05 text: "a medium-risk counterparty gets a lower limit, not a refusal").
8. **Hash-chained decision log anchored to Arc** with public replay page. Prior Art #01 (euthyna) verbatim; signed "no"s included.
9. **Revenue agent sweeps idle x402 revenue into USYC** above a float and redeems before ops-wallet gas runs low. Tiny amounts, but a second autonomous loop + USYC + Paymaster in one feature.
10. **Public `/numbers` page in APEX style** — outside payers with tx links, own wallets excluded, refunds and mistakes listed. Update daily in Discord `share-your-traction`.
11. **"Screened by CompliR" badge + attestation link** integrators can show on their own payment receipts. Free marketing inside the cohort.
12. **ERC-8004 agent identity** for CompliR itself on Arc's registry (APEX is #1 there; being a registered, payable agent that other agents discover via x402 discovery / Coinbase Bazaar listing is cheap and visible).

Stretch (only if 1–8 are done): CCTP source-chain screening for inbound USDC (grade the Base/Solana funder before it lands on Arc); EURC counterparties; Telegram bot `/screen 0x…` like Syncly/Vestiarion's bots.

## 5. Traction playbook (start Day 1, not Day 7)

- **Customers = the Discord.** Post once in `share-your-traction` and once in the lounge: "Free 1,000 screenings for any Tameion team. One call, you get tier + limits + signed attestation. Shadow report on your payee list in 10 minutes." Name-tag STEWARD, Vestiarion, CeedeBooks, Mandate, Syn DAO, Tamias, Syncly, APEX, BizArc, Keryx.
- **DM template (zero crypto jargon, one question, per hanhgia2212's advice):**
  > Hey [name], saw [project] checks payees against a denylist before paying. I'm building CompliR: one API call grades the address (2 hops back on Arc + OpenSanctions), returns a limit your policy can use, and signs it so your ledger can store it. Can I run your current payee list through it and send you what it would have held? Free, no signup.
- **Open 3 integration PRs by Oct 13.** Adapter + README snippet + test. Link PRs in TRACTION.md.
- **Demo on the Canteen Stage** at least twice before Oct 17. Ask for a slot in the daily chat.
- **Daily update** in Discord + X (`#Tameion @thecanteenapp @arc @BuildOnCircle`), APEX-style honesty.
- **Our own business counts** (FAQ Q3). CompliR's revenue wallet is a business that receives USDC on Arc and the revenue agent manages it. Screen our own payers too.
- **Record one real user paying** for a screening (screen capture, 20s). Aljosa asked for exactly this.

## 6. 8-day plan (Oct 9 → Oct 17)

| Day | Build | Traction |
|---|---|---|
| **Oct 9 (Thu)** | Read `node_modules/next/dist/docs` (Next 16 differs!). Scaffold `/v1/screen` with yente Docker + Arc RPC funder trace (2 hops) + `isBlacklisted` + deterministic scoring. | Post the free-screening offer in Discord. Register ERC-8004 identity. |
| **Oct 10 (Fri)** | x402 on testnet via Circle facilitator; Dev-Controlled wallets (revenue, ops); EIP-712 attestation; decision log hash chain. `@complir/sdk` v0. | DM 8 teams. Ship `/v1/shadow`. |
| **Oct 11 (Sat)** | `AttestationRegistry.sol` (Foundry, OZ, Pausable) → testnet, verified. Risk Analyst agent (Claude): evidence depth, limits, EDD, cadence, rationale. | First shadow reports delivered. |
| **Oct 12 (Sun)** | Watcher worker (Railway/Fly) + webhooks + `TierChanged`. Lookalike detection. Explorer page `/`, `/log/:id`. | Open integration PRs #1–#3. Demo on Canteen Stage. |
| **Oct 13 (Mon)** | **Mainnet flip**: registry deploy + verify, wallets, x402 mainnet, ≤100 USDC float, `COMPLIR_PAUSED` kill switch tested. Anchor first Merkle root. | Traction update #1 with tx links. |
| **Oct 14 (Tue)** | USYC revenue sweep; `/numbers`, `/feed`; EDD link flow. Idempotency + fail-closed tests. | Follow-ups, merge PR feedback, 2nd Stage demo. |
| **Oct 15 (Wed)** | Bug-fix from integrators; README (judge-first: 60-second quickstart, tx links, architecture diagram); INTEGRATION.md. | Record the "real user paying" clip. |
| **Oct 16 (Thu)** | Video (≤3 min: problem 20s → one live screen with 2-hop hit 60s → contract require() 30s → numbers 30s → ask 20s). **Submit.** | Traction update #2. |
| **Oct 17 (Fri)** | Buffer. Resubmit with final numbers before 11:59 PM ET. | Final Discord/X post. |

## 7. Mainnet guardrails (from the Oct 9 review)

- Env-only network config; testnet until Oct 13.
- ≤100 USDC on-chain; separate revenue / ops wallets; agent-wallet spending policy on ops wallet (policies enforce on mainnet only).
- Never send to a real sanctioned address; HIGH simulated via local override labels on our own wallets.
- Secrets gitignored; scan git history before submission (`git log -p | grep -i key`).
- Idempotency key on every outbound tx; retries check status first (Agents & Ledgers: "retry paid it twice").
- Kill switch `COMPLIR_PAUSED=1` halts watcher writes and USYC sweeps; `/screen` keeps serving (read-only).
- Registry contract: `Ownable2Step` + `Pausable`; attester key separate from owner key; identical bytecode on testnet first.

## 8. Video script skeleton (≤3 min)

1. **0:00–0:20** Every Arc treasury agent checks a denylist once and pays. The list is stale the day it's carved. (Megarian Decree line from the event page.)
2. **0:20–1:20** Live: paste an address → score 37, MEDIUM, reason: funder's funder hit OpenSanctions, show the 2-hop path with tx links, agent's rationale, EDD question, next re-screen time. Show the attestation tx on Arc explorer.
3. **1:20–1:50** Show `require(compliR.tierOf(payee)…)` in a partner's contract, and a webhook firing when a watched address flips tier.
4. **1:50–2:20** `/numbers`: outside wallets paying 0.01 USDC per screen, PRs opened/merged, shadow reports delivered. Honest caveats.
5. **2:20–2:50** Decision log replay + Merkle anchor. "Signed no's included."
6. **2:50–3:00** Ask: "If your agent pays anyone on Arc, one call."

## 9. Sources consulted (Oct 9)

Event page · Discord `#general`, `#share-your-traction` (pasted by Mike) · github.com/big14way/steward · github.com/duongnq2798/vestiarion · github.com/laurenthalbrun/tamias · github.com/ferrousowl/tamias · github.com/apexfaucet-hub/apex-treasury-operator · github.com/tang-vu/keryx/pull/248 · developers.circle.com/wallets/compliance-engine/tx-screening · circle.com/wallets/compliance-engine · arc.io/blog (mainnet live Sep 16, 2026) · cryptobriefing.com (x402 facilitator on Arc) · aomi.dev/research/three-gates-onchain
