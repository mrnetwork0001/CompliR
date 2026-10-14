# STEWARD integration notes

Repo: https://github.com/big14way/steward · main @ `1f90e89` (2026-10-11) · MIT.
Stack: Python 3.11 agent (`agent/`, asyncio, httpx, web3 7, eth-account 0.13, unittest), FastAPI API (`api/`), Next.js web, Foundry contracts (`AllowanceManager`, `AuditLog`). Flat imports inside `agent/` (`from config import …`); tests run with `cd agent && python -m unittest`. No linter config in the repo.

## Where screening happens

- `agent/screen.py` — `screen(addr) -> "denylist" | "clear"` against `DENYLIST` from env. Its own comment already says: *"ADAPT (stretch): also call a screening API paid via x402"*.
- `agent/main.py::_decide_one` builds `DecisionInput(payee_screen=screen.screen(...), per_tx_cap=a["perTxCap"], …)`.
- `agent/decision.py::apply_rules` — R1: `payee_screen != "clear"` → `SCREEN_FAIL`; R3: `requested > per_tx_cap` → `ESCALATE`; R4 partial comes from period/liquidity room, not from the per-tx cap.

## Files touched (106 insertions, 4 deletions)

| File | Why |
|---|---|
| `agent/complir.py` (new, 78 lines) | `verdict()` POST + x402 402→sign→retry (EIP-3009 via eth-account), `apply()` pure tier→inputs mapping |
| `agent/main.py` | 3 lines: import, one call to `complir.apply(...)`, pass `payee_screen` / `per_tx_cap` |
| `agent/config.py` | `COMPLIR_URL`, `COMPLIR_PAYER_PRIVATE_KEY`, `COMPLIR_TIMEOUT` |
| `agent/.env.example` | the two vars, commented |
| `agent/decision.py` | comment only: `"complir_high"` added to the `payee_screen` value list |
| `agent/test_decision.py` | `test_complir_tiers_map_onto_rules` (unittest, same `inp()` helper) |
| `README.md` | one table cell + one paragraph under "The decision engine" |

## Decisions and uncertainty

- MEDIUM is mapped to a lowered `per_tx_cap` (→ R3 `ESCALATE`, owner decides) rather than to `PARTIAL`. Their `PARTIAL` is driven by period/liquidity room; reaching it from a per-tx limit would mean editing `apply_rules`, which is hashed into every decision. Offered the alternative in the PR.
- `DecisionInput` is unchanged on purpose (it is canonical-JSON-hashed and mirrored by the SDK and web). The CompliR `decisionId` is only in the agent log; adding it to the saved `rec` dict in `db.save_decision` would be a 1-line follow-up if they want it in Activity.
- x402 signing in Python mirrors `packages/sdk/src/index.ts` (scheme `exact`, `eip155:*`, `PAYMENT-REQUIRED` base64 header with JSON-body fallback, 1 USDC cap). Not executed here (`eth_account` not installed locally); `Account.sign_typed_data(key, domain, types, message)` is the eth-account ≥0.11 signature. Syntax-checked with `ast.parse`.
- The agent's own signer may be a Circle wallet (`SIGNER=circle`); the x402 purse is a separate local key by design (0.01 USDC per call). Without it a 402 is logged and ignored.
- Fail-open on outage (warn, continue) matches how they treat a stale signals cache; CompliR never loosens a decision.
- Hosted CompliR URL is still pending (`https://trycomplir.xyz` placeholder); the user should fill it into the PR body before submitting.
