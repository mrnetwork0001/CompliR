# arc-ecommerce-payments integration notes

Repo: https://github.com/circlefin/arc-ecommerce-payments · main @ `be2017d` (2026-09-02) · Apache-2.0 (Circle Internet Group). Prepared 2026-10-14.
Stack: Next.js 16 App Router, React 19, TypeScript, Tailwind v4, wagmi/viem/RainbowKit for the shopper, Circle DCW for operator/merchant, Supabase. eslint-config-next 16 flat config with `no-unused-vars` as warn (`^_` ignored). CI (`.github/workflows/ci.yml`) runs `npm ci --legacy-peer-deps`, `tsc --noEmit`, `npm run lint`, `npm run build` on every PR. Routes `import "server-only"`, use `NextResponse.json({ error }, { status })`, trailing commas.

## Where funds are released

- `lib/operator/operations.ts`: `authorize` (pull into escrow), `capture` (escrow → merchant `receiver`), `voidAuthorization` (escrow → payer), `refund` (operator wallet → payer via `OperatorRefundCollector`). All relayed as raw calldata through Circle's contract-execution API from the operator DCW.
- Admin: `app/api/admin/orders/[id]/capture` → `capture`; `app/api/admin/orders/[id]/refund` → `refund`; `app/api/admin/orders/[id]/void` → `voidAuthorization`.
- Shopper: `app/api/account/orders/[id]/cancel` → `voidAuthorization`; `app/api/account/orders/[id]/refund` → `refund`; `app/api/account/reclaim`.
- Contracts are pinned ABI/bytecode artifacts under `contracts/artifacts/` (no Solidity source in the repo), so there is no on-chain variant of the patch here.

## Files touched (101 insertions, 0 deletions)

| File | +/− | Why |
|---|---|---|
| `lib/complir.ts` (new) | 71/0 | `complirCheck(address)` with `import "server-only"` like the rest of `lib/*` server code; disabled → allowed; 8 s timeout; HIGH blocked; fail open with `console.warn`. Apache header included |
| `app/api/admin/orders/[id]/capture/route.ts` | 10/0 | import + gate on `paymentInfo.receiver` before `capture` |
| `app/api/admin/orders/[id]/refund/route.ts` | 10/0 | import + gate on `paymentInfo.payer` before `refund` |
| `.env.example` | 5/0 | `COMPLIR_URL`, commented |
| `README.md` | 5/0 | env-table row + "Optional: CompliR counterparty screening" subsection |

## Decisions and uncertainty

- Gated the two admin routes rather than `lib/operator/operations.ts`: the routes own the HTTP error shape (a throw inside `capture`/`refund` would surface as a 502 "Capture failed"), and the brief asked for the app's normal 403 JSON. The shopper-side refund/cancel return funds to the shopper's own wallet and were left alone; mentioned as a follow-up in the PR.
- `paymentInfo.receiver` / `.payer` are viem `Address` (`0x${string}`), already validated when the intent was built, so no extra parsing.
- `console.warn` passes the eslint config (no `no-console` rule in `core-web-vitals`); existing routes use `console.error`.
- `server-only` is already a transitive import in every route, so the new `import "server-only"` adds no dependency.
- Not verified: CI's `npm ci` / `tsc` / `lint` / `build` were deliberately not run in the clone (untrusted download; `--legacy-peer-deps` suggests a fragile install). The TS was read against the existing types and imports. Patch verified with `git apply --check` on a clean `be2017d`. CI on the fork will be the first real type-check.
- No CONTRIBUTING.md, no CLA bot config; `SECURITY.md` is HackerOne-only. This is the only one of the four repos with a PR CI workflow.
- Hosted CompliR URL is a placeholder (`https://complir.example`).
