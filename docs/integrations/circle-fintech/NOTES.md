# arc-fintech integration notes

Repo: https://github.com/circlefin/arc-fintech · main @ `0b10d38` (2026-09-16) · Apache-2.0 (Circle Internet Group). Prepared 2026-10-14.
Stack: Next.js App Router (eslint-config-next 16 flat config, `core-web-vitals` + `typescript`), Supabase, Circle DCW + Gateway + App Kit + EarnKit, viem, zod, vitest (`tests/`). Routes wrap handlers in `withAuth(async (req, { user, supabase }) => …)` and return `{ error, userMessage }` on failures. Mixed quote style (routes use double quotes; `lib/compliance` single); double quotes used.

## Where funds are released

- `app/api/payout/route.ts` (878 lines): `recipientAddress` from the body; three strategies (selected wallet same-chain via `sendUsdcOnSameChainWithAppKit`, Gateway burn/mint via `signAndSubmitGatewayBurnIntent` + `executeGatewayMint`, unified-balance `unifiedBalance.spend`). All share the single validation prelude, so one gate after the amount check covers every path.
- `app/api/wallet/transfer/route.ts`: `destinationAddress` (zod `evmAddressSchema`), same-chain App Kit send. Gate right after `validateJsonBody`.
- `app/api/compliance/screen/route.ts` + `lib/compliance/utils.ts`: Circle Compliance Engine; `shouldBlockTransfer()` treats `FAIL`/`ERROR` as blocking. It is called only from the browser (`components/dialogs/use-compliance-check.ts`), not from the two money routes. CompliR sits beside it server-side; neither can override the other.

## Files touched (107 insertions, 1 deletion)

| File | +/− | Why |
|---|---|---|
| `lib/complir.ts` (new) | 69/0 | `complirCheck(address)`; disabled → allowed; 8 s timeout; HIGH blocked; fail open with `console.warn`. Apache header included like every file in the repo |
| `app/api/payout/route.ts` | 14/0 | import + gate after the amount validation, before wallet balances are fetched |
| `app/api/wallet/transfer/route.ts` | 13/0 | import + gate after zod parse |
| `.env.example` | 5/0 | `COMPLIR_URL`, commented |
| `README.md` | 6/1 | Compliance feature bullet extended, env-table row, short section |

## Decisions and uncertainty

- Gate placed before any wallet lookup so a blocked recipient costs no RPC/Gateway calls. `recipientAddress` in `/api/payout` is only checked for presence, not format; `encodeURIComponent` guards the CompliR URL.
- "Stricter verdict wins" is by construction: the Compliance Engine result lives in the browser flow, CompliR in the server routes; both must pass for money to move. Nothing merges the two results, so no change to `mapComplianceResult` / `shouldBlockTransfer`.
- Not written to `compliance_logs`: that table's columns are shaped for Circle's response (`rule_name`, `actions`, `risk_categories`) and the insert would need a migration decision. Suggested as a follow-up in the PR.
- `console.warn` is allowed by the eslint config (no `no-console` rule in `core-web-vitals`); the codebase already uses `console.error`/`console.log` in routes.
- Not verified: no `npm ci`, `tsc`, `eslint` or `vitest` run in the clone (untrusted download; `@crcl-main/onramp-kit` also needs a private registry). The vitest suite under `tests/` does not cover `/api/payout` or `/api/wallet/transfer` by filename, so no existing test exercises the gated code paths. Patch verified with `git apply --check` on a clean `0b10d38`.
- No CONTRIBUTING.md, no CLA bot config, no CI workflow in the repo; `SECURITY.md` is HackerOne-only.
- Hosted CompliR URL is a placeholder (`https://complir.example`).
