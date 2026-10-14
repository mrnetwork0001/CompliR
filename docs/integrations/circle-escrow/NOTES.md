# arc-escrow integration notes

Repo: https://github.com/circlefin/arc-escrow · main @ `d5006bc` (2026-06-18) · Apache-2.0 (Circle Internet Group). Prepared 2026-10-14.
Stack: Next.js (App Router, `next: latest`), Supabase, Circle Developer-Controlled Wallets + Smart Contract Platform SDKs, OpenAI vision for work validation. Solidity `^0.8.24` `RefundProtocol` (EIP-712, OpenZeppelin imports) in `contracts/escrow_smart_contract/`, deployed per agreement from a precompiled `REFUND_PROTOCOL_BYTECODE` in `lib/constants.ts`. No eslint config in the repo (Prettier only, double quotes, trailing commas in the newer files).

## Where funds are released

- `app/api/contracts/escrow/deposit/route.ts` calls `pay(to, amount, refundTo)` from the depositor wallet (funds go *into* escrow; `to` is the beneficiary).
- `app/api/contracts/validate-work/route.ts` is the release: after OpenAI accepts the uploaded deliverable it submits `withdraw([0])` from the beneficiary's Circle wallet. This is the only route that moves escrowed USDC to the counterparty, so the HTTP gate lives there.
- `app/api/contracts/escrow/refund/route.ts` calls `refundByRecipient(0)` (money back to the depositor, not gated).
- In the contract, `withdraw` (recipient = `msg.sender`) and `earlyWithdrawByArbiter` (explicit `recipient`) are the two paths that `transfer` to a recipient; both are gated. Refund paths and `withdrawArbiterFunds` are not.

## Files touched (147 insertions, 1 deletion)

| File | +/− | Why |
|---|---|---|
| `lib/complir.ts` (new) | 69/0 | `complirCheck(address)`: disabled → allowed; GET attestation with `AbortSignal.timeout(8000)`; HIGH blocked; errors fail open with `console.warn`. Includes the repo's Apache header (18 lines) |
| `contracts/escrow_smart_contract/ICompliR.sol` (new) | 33/0 | Vendored interface, long notice trimmed; enum, 3 events, `tierOf`, `isAllowed` kept verbatim |
| `contracts/escrow_smart_contract/RefundProtocol.sol` | 24/0 | import, `address public complir`, `error CompliRTierTooHigh(address)`, `setComplir` (`onlyArbiter`), `_requireComplirAllowed` called in `withdraw` and `earlyWithdrawByArbiter` |
| `app/api/contracts/validate-work/route.ts` | 13/1 | import, `wallet_address` added to the beneficiary select, one gate returning 403 before `withdraw` |
| `.env.example` | 4/0 | `COMPLIR_URL`, `COMPLIR_REGISTRY`, commented |
| `README.md` | 4/0 | "Optional: CompliR counterparty screening" section after the env table |

## Decisions and uncertainty

- The contract has no `Ownable`; `arbiter` is the admin, so `setComplir` is `onlyArbiter`. A custom error is used instead of a `require` string because every other revert in the contract is a custom error.
- **The Solidity change does not affect the running app** until someone recompiles and replaces `REFUND_PROTOCOL_BYTECODE` / `REFUND_PROTOCOL_ABI_JSON` in `lib/constants.ts`; the repo has no Foundry/Hardhat setup, so this was not done and the contract was not compiled here. The HTTP gate is what takes effect when `COMPLIR_URL` is set. Said so in the PR.
- The beneficiary select in `validate-work` did not include `wallet_address`; one line added to the Supabase select string. `agreement` is untyped in that route (the file already uses `(task: any)`), so no type changes were needed.
- 403 status chosen to match `forbidden`-style responses elsewhere in the app; the file's own error shape `{ error }` is kept, with `tier` and `decisionId` added for the UI.
- A 404 from the free endpoint (address never screened) fails open; only a stored `HIGH` blocks. The paid `/api/v1/screen` is where a never-seen address gets a fresh verdict.
- `encodeURIComponent(address)` guards the URL; the route validates addresses by regex earlier only in the deposit flow, not in validate-work.
- Not verified: no `npm install`, build, lint or test was run in the clone (untrusted download). TS was read carefully against the existing imports and helpers; the patch was verified with `git apply --check` on a clean checkout of `d5006bc`.
- Repo has no CONTRIBUTING.md and no CLA bot config; `SECURITY.md` only covers vulnerability reporting via HackerOne. The `.github/workflows/workflow.yml` is a traffic-stats cron, not CI.
- Hosted CompliR URL is still a placeholder (`https://trycomplir.xyz`); fill it in before submitting.
