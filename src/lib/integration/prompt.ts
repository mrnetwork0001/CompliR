/**
 * The copy-paste prompt builders hand to their coding agent (Claude Code, Cursor, Codex…) to integrate CompliR.
 * Served at /docs/agent-prompt (with a copy button) and /llms.txt. Keep it self-contained and accurate to the live API.
 */
export const COMPLIR_BASE_URL = "https://trycomplir.xyz";
export const COMPLIR_REGISTRY = "0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d";

export const INTEGRATION_PROMPT = `You are integrating CompliR into this codebase. CompliR (${COMPLIR_BASE_URL}) is a counterparty-risk oracle for USDC on Arc mainnet (chain 5042): before money moves to or from an address, it returns a graded, signed verdict. Docs: ${COMPLIR_BASE_URL}/docs

GOAL
Add a CompliR check at every point where this codebase sends USDC to an address it did not create itself, or accepts USDC from an outside payer. Do not change any existing behaviour when CompliR is disabled.

STEP 1 - FIND THE MONEY FLOWS (report them to me before editing)
Search for: transfers, withdrawals, payouts, refunds, escrow releases, invoice payments, x402/payment middleware, "payTo", "toAddress", "destinationAddress", "transfer(", "withdraw", "release(". For each, note: file:line, direction (outbound/inbound), who controls the address (user-typed? our own wallet?), and amount source. Skip transfers between wallets this app itself created.

STEP 2 - THE API
- Free verdict, always answers (no payment, no key):  GET ${COMPLIR_BASE_URL}/api/v1/attestation/<address>
  → 200 {address, tier, score, reasons[{code, weight, evidence}], recommendedLimits {maxPerTxUsdc, maxPerDayUsdc}, rationale, eddRequested[], edd {id, url, status} | null, nextRescreenAt, attestation {signature, validUntil, registryTx, typedData}, decisionId, screenedAt, expired, refreshing, source}.
  It runs the full screen (sanctions, Circle USDC blocklist, two-hop funder trace, analyst). An address never seen before is screened on demand: the first call takes ~20-60 s (source "fresh"); later calls answer in < 1 s (source "store"). Concurrent calls for one address share one screen. It does not return 404 for unknown addresses.
  If the stored verdict has expired (attestation.validUntil < now) it is still returned at once with expired: true and refreshing: true while CompliR re-screens in the background; the next call gets the fresh verdict.
- Paid screen, optional (~0.01 USDC via x402):  POST ${COMPLIR_BASE_URL}/api/v1/screen  body {"address":"0x…","amountUsdc":<number>,"clientId":"<your-app>","payeeBook":[{"label":"…","address":"0x…"}]}
  Use it only when you need context the GET cannot take: amountUsdc (amount-aware limits and a guarantee bond on LOW), payeeBook (lookalike / address-poisoning check against your known payees), a forced re-screen right now, or attribution by clientId. Unpaid it returns HTTP 402 with x402 v2 requirements (network eip155:5042, asset USDC 0x3600000000000000000000000000000000000000). Pay with the SDK (packages/sdk in github.com/mrnetwork0001/CompliR: class CompliR with verdict()/screen()/watch()) or any x402 v2 client. The PAYMENT-SIGNATURE envelope and a worked signing example are at ${COMPLIR_BASE_URL}/docs/x402#payload.
- Watch an address (re-graded continuously): POST ${COMPLIR_BASE_URL}/api/v1/watch body {"address":"0x…","webhookUrl":"https://…"} → you later receive POST {type:"tier.changed", address, from, to, verdict} with header x-complir-event: tier.changed.
- Field notes: attestation.validUntil (same value as attestation.typedData.message.validUntil) is when the signature lapses: HIGH 1 h, MEDIUM 24 h, LOW 7 d. nextRescreenAt is when CompliR plans to re-grade. registryTx is null until the on-chain mirror lands seconds later; only on-chain callers need it. edd is present mainly on MEDIUM; a HIGH sanctions or blocklist hit has none.
- On-chain (Solidity, optional): ICompliR(${COMPLIR_REGISTRY}).isAllowed(payee, ICompliR.Tier.MEDIUM) returns true only for a non-expired LOW/MEDIUM attestation. Interface: contracts/src/ICompliR.sol in the CompliR repo.

STEP 3 - POLICY TO IMPLEMENT
- Use the free GET for every check. Add the paid POST only where amount-aware limits or payee-book lookalike checks matter (for example large payouts). Most integrations need no payer key.
- Outbound payment to an outside address:
  HIGH → block. Return a clear error ("This address is flagged as high risk by CompliR: <reasons[].code joined>") and log decisionId.
  MEDIUM → allow at most recommendedLimits.maxPerTxUsdc; if the request is larger, block or require manual approval (pick the pattern this codebase already uses). If edd.url is present, surface it.
  LOW → allow.
- Inbound payer (someone paying us): HIGH → refuse the request (or refund if already settled); otherwise proceed.
- New user/creator/vendor wallet at signup: screen it; if HIGH, flag the account; register a watch so later changes reach us.
- Cache each verdict per address until min(attestation.validUntil, nextRescreenAt). An expired verdict is still the latest answer: use its tier and fetch again later (the GET refreshes it for free).
- Timeouts: at least 90 s for the GET (first sight of an address) and 120 s for the POST. A shorter timeout shows up as a dropped connection. On hot paths, do not block on a first-sight screen: treat a timeout with COMPLIR_FAIL_MODE and let the screen finish server-side; the next call is instant.
- If CompliR is unreachable or times out: follow env COMPLIR_FAIL_MODE = "open" (default: allow and log a warning) or "closed" (block).

STEP 4 - IMPLEMENTATION RULES
- Put all CompliR code in ONE new module (e.g. lib/complir.ts or complir.py) exposing checkAddress(address, {amountUsdc, direction}) → {allowed, tier, maxUsdc, reason, decisionId}. Call it from the money-flow points; keep each call site to a few lines.
- Config via env: COMPLIR_URL (default ${COMPLIR_BASE_URL}; empty = disabled → checkAddress returns allowed:true), COMPLIR_FAIL_MODE, COMPLIR_CLIENT_ID, and COMPLIR_PAYER_PRIVATE_KEY only if you add paid screens (most integrations do not). Add them to .env.example with comments.
- Match the codebase's language, style, lint rules and error-handling patterns. Lowercase addresses before calling. Never log private keys.
- Store decisionId alongside the payment/withdrawal record so the decision can be replayed at ${COMPLIR_BASE_URL}/log/<decisionId>.
- Add tests with the HTTP calls mocked: HIGH blocks, MEDIUM caps, LOW passes, disabled = no-op, unreachable follows fail mode.
- Add a short README section "Counterparty screening (CompliR)".

STEP 5 - VERIFY
Run the existing test suite and type checks. Then a live smoke test against ${COMPLIR_BASE_URL}:
- 0x098b716b8aaf21512996dc57eb0615e2383e2f96 (a real OFAC-listed wallet) must be blocked as HIGH.
- A normal active wallet should pass as LOW.
Report: the money flows found, files changed, the policy at each point, test results, and anything you were unsure about.`;
