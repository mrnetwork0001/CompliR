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

1. Replace the placeholder `https://complir.example` in each `PR.md` with the hosted URL once it exists
   (`grep -n complir.example docs/integrations/*/PR.md`). For CeedeBooks also add the `AttestationRegistry` address after the mainnet deploy.
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
