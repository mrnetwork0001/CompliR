# arc-p2p-payments integration notes

Repo: https://github.com/circlefin/arc-p2p-payments · main @ `499d1f5` (2026-10-02) · Apache-2.0 (Circle Internet Group). Prepared 2026-10-14.
Stack: Next.js App Router (eslint-config-next 16 flat config; React Compiler rules downgraded to warn), Supabase, Circle Modular Wallets (`@circle-fin/modular-wallets-core`, passkey + bundler + paymaster) in the browser, Circle DCW SDK server-side for wallet creation only, vitest unit + integration tests. Server actions in `app/actions/index.ts` (`"use server"`, arrow-function exports, `await createSupabaseServerClient()`).

## Where funds are released

- `components/web3-provider.tsx`: `sendUSDC(to, amount)` encodes an ERC-20 transfer and sends it as a user operation through `bundlerClient.sendUserOperation({ paymaster: true })`; `sendTransaction` does the same for native value. Signed in the browser with the passkey.
- `components/wallet-tab.tsx`: `handleSend` is the only caller of `sendUSDC` (after the address-confirmation dialog). This is the release point.
- There is no server-side send route: `app/api/wallet/transactions/*` only lists transfers, `app/api/onramp/session` funds the user's own wallet.

## Files touched (101 insertions, 1 deletion)

| File | +/− | Why |
|---|---|---|
| `lib/complir.ts` (new) | 69/0 | `complirCheck(address)`; disabled → allowed; 8 s timeout; HIGH blocked; fail open with `console.warn`. Apache header included like every file in the repo |
| `app/actions/index.ts` | 16/0 | import + `screenRecipientAction(address)`: requires a Supabase session, then `complirCheck` |
| `components/wallet-tab.tsx` | 8/1 | import + screening before `sendUSDC`; throws into the existing `catch` → destructive toast |
| `.env.example` | 3/0 | `COMPLIR_URL`, commented |
| `README.md` | 5/0 | env-table row + short section |

## Decisions and uncertainty

- A server action rather than a new API route: it is the repo's existing pattern for server work from client components, needs no fetch boilerplate and keeps `COMPLIR_URL` server-side. The action requires a signed-in user so it is not an open relay to CompliR.
- `lib/complir.ts` does not import `server-only` (the package is not used in this repo); it is only imported from the `"use server"` module, so it never reaches the client bundle.
- Importing `type ComplirCheck` into a `"use server"` file is fine: types are erased; only async functions are exported.
- Honest limitation: the user operation is signed and sent from the browser, so a modified client can skip the check. Stated in the README section and the PR. A true gate needs the on-chain `ICompliR.isAllowed` check in a receiving contract or a server-side relayer, neither of which exists in this app.
- When disabled, the only cost is one extra server-action round trip (auth check) per payment; `complirCheck` returns before any network call.
- Not verified: no `npm ci`, `tsc`, `eslint` or vitest run in the clone (untrusted download). `tests/unit` does not cover `app/actions` or `wallet-tab.tsx`, so no existing test exercises the changed paths. Patch verified with `git apply --check` on a clean `499d1f5`.
- No CONTRIBUTING.md, no CLA bot config, no CI workflow in the repo; `SECURITY.md` is HackerOne-only.
- Hosted CompliR URL is a placeholder (`https://complir.example`).
