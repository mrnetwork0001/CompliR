# Integration PRs — CompliR as a counterparty-screening provider

Prepared, **not submitted**, patches for three Tameion treasury agents. Each folder holds a `PATCH.diff` (applies cleanly
to the commit named in its `NOTES.md`, verified with `git apply --check`), a `PR.md` (title on line 3, body after
`# Body`) and `NOTES.md` (stack, files touched, what was and was not verified, open questions).

| Repo | Base commit | Patch | What it adds |
|---|---|---|---|
| [big14way/steward](https://github.com/big14way/steward) | `1f90e89` | 106+ / 4− lines, 7 files | Python: `agent/complir.py`; denylist first, then HIGH → `SCREEN_FAIL`, MEDIUM → lower per-tx cap (→ `ESCALATE`), LOW → pass |
| [duongnq2798/vestiarion](https://github.com/duongnq2798/vestiarion) | `13b0dc9` | 242+ / 5− lines, 7 files | TS: `src/lib/complir.ts`; runs beside OpenSanctions in the compliance sweep, stricter verdict wins, `recommendedLimits` caps the tiered limit, signed attestation stored in the signed ledger entry |
| [MusaAis/CeedeBooks](https://github.com/MusaAis/CeedeBooks) | `5b7498b` | 265+ / 1− lines, 10 files | Python: `agent/complir.py` gate in `payables.decide()`; Solidity: `BudgetEnforcerV2.setComplir()` + `require(ICompliR(complir).isAllowed(vendor, Tier.MEDIUM))` in `pay()`, `ICompliR.sol` vendored, 2 Foundry tests |

Every patch is additive and opt-in: with `COMPLIR_URL` unset (and `complir == address(0)`) behaviour is unchanged.

## Before submitting

1. Replace the placeholder `https://trycomplir.xyz` in each `PR.md` with the hosted URL once it exists
   (`grep -n trycomplir.xyz docs/integrations/*/PR.md`). For CeedeBooks also add the `AttestationRegistry` address after the mainnet deploy.
2. Decide whether to allowlist each team's agent address (free screenings during Tameion, `X402_DISABLED` per client is not
   implemented yet — today it is global), since every PR body promises it.
3. Optional: run the targets' own test suites in your fork before opening the PR (they were deliberately not run here;
   see each `NOTES.md` for what was verified instead).

## Submit (from your own GitHub account)

```bash
cd /tmp && export INTEG=/Users/mrnetwork/Test-It/complir/docs/integrations

submit() {   # submit <owner/repo> <folder>
  gh repo fork "$1" --clone --remote && cd "${1##*/}" || return 1
  git checkout -b complir-screening
  git apply --check "$INTEG/$2/PATCH.diff" && git apply "$INTEG/$2/PATCH.diff"
  git add -A && git commit -m "$(sed -n '3p' "$INTEG/$2/PR.md")"
  git push -u origin complir-screening
  gh pr create --title "$(sed -n '3p' "$INTEG/$2/PR.md")" \
               --body-file <(sed -n '/^# Body/,$p' "$INTEG/$2/PR.md" | tail -n +3)
  cd ..
}

submit big14way/steward       steward
submit duongnq2798/vestiarion vestiarion
submit MusaAis/CeedeBooks     ceedebooks
```

If a target has moved on since the base commit and `git apply --check` fails, `git apply --3way` usually resolves it; the
patches touch few lines outside the new files.

## Circle sample apps

Same idea for four [circlefin](https://github.com/circlefin) Arc sample apps, prepared 2026-10-14 and **not submitted**. Each `circle-<name>/` folder holds `PATCH.diff` (verified with `git apply --check` on a clean checkout of the base commit), `PR.md` and `NOTES.md`. These patches use only the free `GET /api/v1/attestation/<address>` lookup (no x402 client); the paid `POST /api/v1/screen` is named as the upgrade in every PR body.

| Repo | Base commit | Patch | What it adds |
|---|---|---|---|
| [circlefin/arc-escrow](https://github.com/circlefin/arc-escrow) | `d5006bc` | 147+ / 1− lines, 6 files | TS: `lib/complir.ts`, 403 gate in `validate-work` before `withdraw`; Solidity: `RefundProtocol.setComplir()` + `CompliRTierTooHigh` revert in `withdraw` / `earlyWithdrawByArbiter`, `ICompliR.sol` vendored (bytecode in `lib/constants.ts` not regenerated) |
| [circlefin/arc-fintech](https://github.com/circlefin/arc-fintech) | `0b10d38` | 107+ / 1− lines, 5 files | TS: `lib/complir.ts`; 403 gate in `/api/payout` and `/api/wallet/transfer`, beside the browser-side Circle Compliance Engine check; stricter verdict wins |
| [circlefin/arc-p2p-payments](https://github.com/circlefin/arc-p2p-payments) | `499d1f5` | 101+ / 1− lines, 5 files | TS: `lib/complir.ts`; `screenRecipientAction` server action called by `wallet-tab.tsx` before the passkey-signed user operation (UX guard; signing is client-side) |
| [circlefin/arc-ecommerce-payments](https://github.com/circlefin/arc-ecommerce-payments) | `be2017d` | 101+ / 0− lines, 5 files | TS: `lib/complir.ts`; 403 gate on `paymentInfo.receiver` in admin `capture` and on `paymentInfo.payer` in admin `refund` (contracts are pinned artifacts, no Solidity source) |

All four are opt-in: `COMPLIR_URL` unset means `complirCheck()` returns `{ allowed: true, reason: "disabled" }` before any I/O, and a CompliR outage fails open with a `console.warn`. Only arc-ecommerce-payments has a PR CI workflow (`tsc`, `eslint`, `next build`); none of the four was installed, built, linted or tested here, so that CI (or a local run in the fork) is the first real type-check.

Contribution policy, checked in each clone: none of the four repos has a `CONTRIBUTING.md`, a CLA bot config or a DCO/sign-off hook; each `SECURITY.md` only says to report vulnerabilities through Circle's HackerOne bug bounty. Circle may still ask for a CLA on the PR itself; sign it if the bot appears. Every file in these repos carries Circle's Apache-2.0 header, so the new `lib/complir.ts` files carry it too.

```bash
cd /tmp && export INTEG=/Users/mrnetwork/Test-It/complir/docs/integrations

# same submit() as above, then:
submit circlefin/arc-escrow             circle-escrow
submit circlefin/arc-fintech            circle-fintech
submit circlefin/arc-p2p-payments       circle-p2p-payments
submit circlefin/arc-ecommerce-payments circle-ecommerce-payments
```

Before submitting, replace `https://trycomplir.xyz` in the four `PR.md` bodies (`grep -n trycomplir.xyz docs/integrations/circle-*/PR.md`). For arc-escrow, decide whether to also recompile `RefundProtocol.sol` and refresh `REFUND_PROTOCOL_BYTECODE` / `REFUND_PROTOCOL_ABI_JSON` in `lib/constants.ts` in the same PR; the patch leaves them untouched and says so.
