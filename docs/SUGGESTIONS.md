# CompliR — Consolidated suggestions (2026-10-11, 6 days to deadline)

Ordered within each group by impact per hour. ✅ = already built.

## A. Reframe the product (so it does not read as "a lookup tool")
1. **Arc Trust Map** — tail Arc mainnet live, grade every counterparty receiving meaningful USDC, show a real-time risk map with tier changes over time. Nobody has a live risk view of Arc. Most visible, most novel.
2. **Guarded payout demo that moves real USDC** — deploy GuardedTreasury on mainnet with a small float; a treasury agent pays a few real recipients through it; show paid / limited / held, each with a signed reason. Turns "scoring" into "an agent that moves money and cannot pay a tainted address", and creates USDC flow for the traction score.
3. **Pitch line**: "the open, verifiable risk layer for money moving on Arc" — contrast with black-box vendors (TRM/Chainalysis): every verdict signed, replayable, on-chain.
4. Keep the Explorer form as the developer entry point under Docs, not the front door.

## B. Front door / UI
5. Home page auto-runs the MEDIUM demo on load so dial, 2-hop graph, attestation are visible without clicking.
6. Hero strip: one-line pitch + three live numbers from /api/v1/numbers + the Solidity one-liner.
7. Shadow Report page: paste a payee list → "what your denylist would have missed" table. (API ✅, page not yet.)
8. "Screened by CompliR" badge + attestation link integrators can show on receipts.

## C. Standout technical features (from the strategy doc)
9. ✅ AttestationRegistry.sol — compliance as an on-chain primitive (`isAllowed(payee, MEDIUM)`), 45 tests. **Deploy to mainnet.**
10. ✅ 2-hop taint propagation with tx-path evidence. Improve: raise lookback / use a paid RPC so busy wallets don't return depth 0.
11. ✅ Adaptive re-screen cadence chosen by the agent + TierChanged event + webhooks. Needs the watcher running (cron route ✅).
12. ✅ Address-poisoning / lookalike detection against the client's payee book.
13. ✅ Hash-chained decision log + Merkle anchor. **Anchor roots on mainnet** (needs attester key).
14. EDD-instead-of-refusal flow: counterparty answers the agent's question via a link; answer hashed into the log; tier revised. (Questions ✅, link flow not yet.)
15. USYC revenue sweep: idle x402 revenue → USYC, redeem before ops gas runs low. Small, but a second autonomous loop + Circle tool usage.
16. ERC-8004 agent identity for CompliR on Arc's registry; list on x402 discovery / Bazaar so other agents find it.
17. Stretch: CCTP source-chain screening of inbound USDC; EURC counterparties; Telegram `/screen 0x…` bot.

## D. Traction (30% of score — start today)
18. Post the free-screening offer in Canteen Discord `#share-your-traction` + lounge (copy in docs/OUTREACH.md).
19. DM the named teams: STEWARD, Vestiarion, CeedeBooks, Mandate, Syn DAO, Tamias, Syncly, APEX, BizArc, Keryx, Coin Ledger, Arc Guardian, VCCFly. One question, no crypto jargon.
20. Open integration PRs on 3 open-source competitor repos (STEWARD, Vestiarion, CeedeBooks) adding CompliR as the screening provider — merged or not, it is public adoption evidence.
21. Deliver shadow reports to anyone who sends a payee list.
22. Demo on the Canteen Stage daily chat at least twice before Oct 17.
23. Daily honest traction update (Discord + X, tag @thecanteenapp @arc @BuildOnCircle #Tameion): outside payers with tx links, own wallets excluded, mistakes and refunds listed (APEX-style).
24. Record a 20-second clip of one real user paying for a screening.
25. Our own revenue wallet counts as "a real business using it" (FAQ Q3) — screen our own payers too.

## E. Mainnet / ops (everything on Arc mainnet 5042)
26. Fund an attester wallet with ≤100 USDC; deploy the registry (`contracts/README.md`); set `REGISTRY_ADDRESS` + `ATTESTER_PRIVATE_KEY`; verify source on explorer.
27. Set `X402_PAY_TO` (revenue wallet) and get a Circle Console API key; confirm the undocumented minimum settle amount with one real 0.01 USDC call. Keep revenue and ops wallets separate; put an agent-wallet spending policy on the ops wallet.
28. Run yente (`docker/yente/`) for live OpenSanctions matching.
29. Host it (Vercel for the app + cron; a small VM/Railway for yente and the long-running watcher/trust-map tailer).
30. Never pay or test against a real sanctioned address; keep HIGH simulated via `.data/overrides.json` on our own wallets.
31. Secrets gitignored; scan git history before submission; idempotency on every outbound tx; `COMPLIR_PAUSED=1` kill switch tested.
32. Decide on the name: "Complir" (complir.io) is a funded Danish compliance startup. Fine for the hackathon; rename (e.g. Dokimasia) only if you continue afterwards.

## F. Submission (Oct 17, 11:59 PM ET)
33. README judge-first: 60-second quickstart, mainnet tx links, architecture diagram, honest status.
34. Video ≤3 min: problem (20s) → live screen with 2-hop hit + attestation tx (60s) → contract `require` + webhook tier change (30s) → numbers/PRs/shadow reports (30s) → ledger replay (30s) → ask (10s).
35. Live URL in the form; submit early, resubmit with final numbers on Oct 17.
36. Commit the work (nothing but the contracts commit is in git yet).

## G. Round-two standout features (added 2026-10-11 after the build)
Ranked by judge impact per hour. These exploit the one thing a *shared* oracle can do that no in-house screen or black-box vendor can.

37. **Network signal across clients** — fill the `concentration`/cross-client field: "this address was HELD by 2 other treasuries on Arc this week", "shares a funder with 6 of your payees", anonymised counts only. Only a shared service can produce this; it is the strongest answer to "why not just call TRM". ~4h (store query over screenings/edges + a reason code + UI line).
38. **Event-driven tier changes** — subscribe to USDC `Blocklisted`/`UnBlocklisted` events on Arc and re-grade every watched/graded address that is touched within ~30 s, pushing webhooks and `TierChanged`. Demo line: "Circle blacklists a wallet → every integrator's webhook fires in under a minute." Cadence stays as the baseline. ~3h (log subscription in the watcher worker).
39. **Inbound (AR) screening for x402 sellers** — `/v1/screen` already works for payers; add `/v1/inbound` + a "refund gate" snippet so sellers (APEX, Keryx, nibgate, VCCFly are all x402 sellers in the cohort) can decide whether to accept money from a wallet and auto-refund HIGH. Broadens the buyer list from treasuries to every seller. ~3h.
40. **MCP server** — expose `screen`, `watch`, `shadow`, `attestation` as MCP tools so any Claude/agent treasury (BizArc uses MCP) adds CompliR in one config line. Cheap, demo-friendly, and judges building agents will try it. ~3h.
41. **Attestation-stamped payments** — `GuardedTreasury.releaseWithProof(payee, amount, decisionHash)` emits the verdict hash alongside the transfer, so any USDC payment on Arc can be traced back to its compliance verdict on the explorer. "Every payment carries its euthyna." ~2h contract + wiring.
42. **Exposure dashboard per client** — "your outstanding exposure to MEDIUM counterparties is 1,240 USDC across 4 payees; 1 tier change pending EDD". Turns screening into treasury risk management (RFB 01 flavour). ~4h.
43. **ERC-8004 reputation as evidence** — when the counterparty is a registered agent, read ReputationRegistry/ValidationRegistry and include it as a reason ("agent #12, 3 validations, 0 disputes"); publish CompliR's own validations back. Agent-to-agent trust is new territory for judges. ~4h.
44. **Live mainnet "blacklist drill" video segment** — using our own wallet in `.data/overrides.json`, flip it to HIGH mid-video and show the payout agent holding, the webhook firing, the badge turning red, the map node changing. 30 s that proves continuity. 0h code.
45. **Public honesty page for the oracle itself** — false-positive reports, EDD outcomes (how many MEDIUM were cleared after answers), guard-trigger rate of the analyst. Accountability for the compliance agent. ~2h on top of existing data.
46. **Circle CCTP inbound screening** — grade the source-chain funder before a CCTP mint lands on Arc (Gateway/CCTP usage + a real cross-chain story). ~5h, needs a Base RPC.

Suggested order for the last 5 days: 37 → 38 → 40 → 39 → 41, then 44 for the video. Skip 42/43/46 unless 37–41 are done.
