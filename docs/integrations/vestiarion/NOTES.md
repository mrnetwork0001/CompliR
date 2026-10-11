# Vestiarion integration notes

Repo: https://github.com/duongnq2798/vestiarion · main @ `13b0dc9` (PR #315, 2026-10-11) · MIT.
Stack: Next.js 16.3.6 / React 19, TypeScript 5 strict, ESM, Supabase (service-role via DAL), viem 2.57, zod 4.6, vitest 5, ESLint 9 with `eslint-config-next` (+ custom `no-restricted-imports` on `@/lib/context` names `currentContext/createContext/runWith/runWithConfig`; `currentConfig` is allowed and is what I use). Path alias `@/`.

## Where screening happens

- `src/lib/compliance.ts` — `screenName()` is the documented provider boundary (OpenSanctions/yente or bundled list, by *name*), `planScreening()` is the pure tiering (`paymentLimitForRisk`), `applyScreening()` writes `counterparties` + `compliance_checks` + a signed ledger entry, `runComplianceSweep()` runs it for every due counterparty each cycle (`orchestrator.ts` stage "compliance").
- `src/lib/config.ts::configFromEnv` → `compliance: { openSanctionsUrl, openSanctionsApiKey, rescreenIntervalHours }`; `src/lib/dal/org-config.ts` adjusts it per workspace mode (sandbox drops the live service; live without a service sets `serviceRequired`).
- Limit-lowering: `paymentLimitForRisk(risk, baseline)` → high 0, medium 25 %, else baseline.

## Files touched (242 insertions, 5 deletions)

| File | Why |
|---|---|
| `src/lib/complir.ts` (new, 137 lines) | zod schema for the Verdict, `mergeCompliR` (stricter verdict + limit + attestation), `screenAddressWithCompliR` (POST + x402 `exact`/EIP-3009 signing with viem, 1 USDC cap) |
| `src/lib/compliance.ts` | import; `ScreeningResult.recommendedLimit` / `.complir`; `planScreening` caps the tiered limit; `CounterpartyScreeningRow.address` + `SCREENING_COLUMNS`; 4-line call in `applyScreening`; 2 ledger `detail` keys |
| `src/lib/config.ts` | `ComplianceConfig.complirUrl` / `complirPayerKey` from `COMPLIR_URL` / `COMPLIR_PAYER_PRIVATE_KEY` |
| `src/lib/dal/org-config.ts` | sandbox workspaces drop `complirUrl` (both branches of the existing ternary) |
| `.env.example` | the two vars under "Compliance (optional)" |
| `README.md` | the Compliance row of the capabilities table |
| `tests/complir.test.ts` (new, 67 lines) | tier mapping, stricter-wins, limit cap, high → 0, off → unchanged |

## Verification done

- `git apply --check` clean against `13b0dc9`.
- `complir.ts` type-checked with `tsc --strict` against viem 2.57.4 / zod 4.6.5 (from the CompliR repo's node_modules) with stubbed `./context` and `./compliance` — passes. The edits to `compliance.ts`/`config.ts` were not type-checked in situ (their `npm install` was not run, per instructions); they are small and follow the surrounding types.
- `tests/complir.test.ts` not executed (same reason); it uses only pure functions already covered by `tests/compliance.test.ts` patterns (`planScreening`, `screenBundledName`).

## Decisions and uncertainty

- Patch is 242 lines, above the 150 target: the x402 signing (~45 lines) and the test (67) account for it. The signing could be dropped if they allowlist their agent address with us (free during Tameion), making `complir.ts` ~80 lines.
- Their existing `buyX402` (`src/lib/x402/buyer.ts`) is GET-only, Circle-Gateway batched scheme, and checks a fixed expected offer, so it does not fit CompliR's `exact`/EIP-3009 POST. I wrote a minimal payer with a purse key rather than threading their Circle signer through; offered the Circle-signer route in the PR.
- K1 (`serviceRequired`) is intentionally not extended to count CompliR as "the service"; that is a product decision for them.
- `amountUsdc` sent to CompliR is the counterparty's baseline (or current) limit, which is the per-payment amount Vestiarion would allow; CompliR scales its recommended limits by tier regardless.
- `compliance_checks.source` becomes `"complir"` only when CompliR produced the stricter verdict, otherwise the name-screening source stays; the notes always carry both.
- Hosted CompliR URL pending (`https://complir.example` placeholder).
