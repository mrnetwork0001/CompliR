# CeedeBooks integration notes

Repo: https://github.com/MusaAis/CeedeBooks (found via GitHub search "CeedeBooks"; the X post returned 403) · main @ `5b7498b` (v1.2.9, 2026-10-11) · MIT.
Stack: Python 3.12 (FastAPI backend, `agent/` package with `from agent import …` imports, pytest with a `FakeChain` fixture in `agent/tests/conftest.py`; httpx 0.28, web3 8.0, groq), Foundry contracts (solc 0.8.20, `via_ir = true`, `src = "contracts"`, forge-std cloned into git-ignored `lib/`), vanilla-JS browser apps (`admin/`, `portal/`, `site/`) with Node test files. CI: `forge test -vv`, `pytest agent/tests`, node tests.

## Language deviation

The brief asked for a TS/JS check before proposing a payment. CeedeBooks has no TS/JS server side: payment proposals live in `agent/payables.py` (`decide()` → `process_invoice()`), and the JS is browser-only (admin/portal/proof page) with no key material. The check is therefore Python, matching the repo; the Solidity part is as specified.

## Where screening happens today

- Nothing continuous. `agent/payables.py::decide()` checks `chain.is_vendor_approved()` (the on-chain registry) and runway; `three_way_match()` checks PO/receipt/wallet. The contract's `pay()` re-checks `vendorApproved`, limits, commitment. README roadmap row G: "continuous vendor screening — planned".

## Files touched (265 insertions, 1 deletion)

| File | Why |
|---|---|
| `agent/complir.py` (new, 82 lines) | `screen()` async POST + x402 402→sign→retry (EIP-3009 via eth-account), `gate()` pure tier→escalation reason |
| `agent/payables.py` | import + 4 lines in `decide()` after the registry check |
| `agent/config.py` | `complir_url`, `complir_payer_private_key` (dataclass fields + `load()`) |
| `.env.example` | the two vars, commented, plus a pointer to `setComplir` |
| `agent/tests/test_complir.py` (new, 46 lines) | `gate` mapping, off without URL, `decide` escalates HIGH / pays LOW (monkeypatches `payables.complir.screen`, uses their `chain` fixture) |
| `contracts/interfaces/ICompliR.sol` (new, 44 lines) | vendored verbatim from CompliR `contracts/src/ICompliR.sol` |
| `contracts/BudgetEnforcerV2.sol` | import, `address public complir`, `ComplirSet` event, `setComplir` (onlyApprover), one `require` in `pay()` |
| `test/mocks/MockCompliR.sol` (new, 21 lines) | hand-set tiers, never expire |
| `test/BudgetEnforcerV2.t.sol` | 2 tests appended, same `_commitAndAdvance` helper and constants |
| `README.md` | one bullet in the V2 contracts section |

## Verification done

- `git apply --check` clean against `5b7498b`.
- Solidity: V2 + interface + mock + test copied into an isolated scratch Foundry project (forge 1.7.1, solc 0.8.20, via_ir, forge-std from the CompliR repo): `forge build` clean, `forge test --match-test CompliR` → 2/2 pass (`test_setComplir_onlyApprover`, `test_pay_revertsWhenCompliRGradesVendorHigh_zeroDisables`). Their other 33 V2 tests were not run (instructions), but `complir` defaults to zero so they are unaffected.
- Python: `ast.parse` syntax check only (their `pytest` was not run; `eth_account` is not installed locally, so the x402 signing path is unexecuted — it mirrors `packages/sdk/src/index.ts` and uses `Account.sign_typed_data(key, domain, types, message)` from eth-account ≥0.11, which web3 8.0 pulls in).

## Decisions and uncertainty

- Gate placed in `pay()` only, not `approveEscalation()`: the human approver keeps the last word, consistent with "the agent can park a payment; only the approver can release it". Easy to add to both via a shared `require` if they prefer fail-closed everywhere.
- `preflight()` (`POST /invoices/preflight`) was not changed, so a vendor's dry run can say `would_pay` while `decide()` later escalates on CompliR. `test_preflight.py` asserts `all(body["checks"].values())` on the happy path, so adding a `complir_ok` key is safe but needs a network call in a read-only endpoint; left as a follow-up and mentioned nowhere in the PR to keep it small — worth raising in review.
- `BudgetFactory` deploys `new BudgetEnforcerV2(...)`, so the gate exists only in enforcers created by a *redeployed* factory. The deployed v1 enforcer (the live pool) cannot gain it. Stated in the PR.
- The "Node tests check selectors against the compiled output" (CI comment) — only additive functions/events were introduced; no existing selector changed.
- Patch is 265 lines, above the 150 target, because it carries two integrations (Python + Solidity) plus their tests and the vendored interface (44). Without tests/interface it is ~110.
- Hosted CompliR URL and the registry address are pending (`https://complir.example` placeholder; registry deploys 13 Oct).
