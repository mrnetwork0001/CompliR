# Title

agent: optional CompliR counterparty screening after the denylist

# Body

## What this adds

A second screening input for the decide loop, behind one env var. `agent/complir.py` calls [CompliR](https://github.com/mrnetwork0001/complir) (`POST /api/v1/screen`, one x402 call of 0.01 USDC on Arc) and maps the verdict onto the rules engine without touching the rules themselves:

| CompliR tier | STEWARD outcome |
|---|---|
| `HIGH` | `payee_screen = "complir_high"` → **R1 `SCREEN_FAIL`**, escalated, cannot be approved (same path as the denylist) |
| `MEDIUM` | `per_tx_cap = min(allowance cap, CompliR's recommended per-tx limit)` → a larger request takes **R3 `ESCALATE`**, the owner decides |
| `LOW` | nothing changes |

The local denylist still runs first and still wins. Both inputs (`payee_screen`, `per_tx_cap`) are already fields of `DecisionInput`, so the hashed, replayable decision record shows exactly what the agent decided on; CompliR's `decisionId` is in the agent log. No new dependency: `httpx`, `eth-account` and `web3` are already in `agent/requirements.txt`.

## Why

The README's "Wrong vendor" row is a denylist checked once per decision plus Arc's protocol blocklist. Both are one-hop and static: a payee funded by a sanctioned wallet two hops back, a fresh wallet that is a lookalike of an existing contractor, or an address Circle blacklisted yesterday all pass. CompliR grades the address every time it is screened (2-hop USDC funder trace on Arc, OpenSanctions/yente, USDC `isBlacklisted`, lookalike match against your payee book) and returns a limit STEWARD's existing caps can adopt, plus an EIP-712 attestation signed by CompliR and mirrored to its registry on Arc, so a third party can verify why a payment was held.

## How to enable

```
# agent/.env
COMPLIR_URL=https://trycomplir.xyz          # the hosted URL (ask us; mainnet 13 Oct)
COMPLIR_PAYER_PRIVATE_KEY=0x...              # a small USDC purse on Arc that pays 0.01 USDC per screen over x402
```

Without `COMPLIR_PAYER_PRIVATE_KEY`, a 402 is logged and the payee is screened by the denylist only. During Tameion we can allowlist your agent address so the key is not needed; see below.

## Opt-in and non-breaking

- `COMPLIR_URL` unset (the default, and `.env.example`): `complir.verdict()` returns `None` before any I/O and `complir.apply()` returns its inputs unchanged. Every existing test passes unchanged; `test_complir_tiers_map_onto_rules` covers the mapping.
- CompliR unreachable, slow (15 s timeout) or unpaid: logged at WARNING, decision proceeds exactly as today. CompliR can only ever make a decision stricter, never looser.
- No change to `apply_rules`, `canonical_json`, `AllowanceManager`, the API or the web app. No new rule codes.

## Usage

```python
# agent/main.py, _decide_one — the whole wiring
payee_screen, per_tx_cap = complir.apply(
    complir.verdict(a["payee"], m["amount"]),   # None unless COMPLIR_URL is set
    screen.screen(a["payee"]),                   # denylist first, unchanged
    a["perTxCap"],
)
i = DecisionInput(..., per_tx_cap=per_tx_cap, payee_screen=payee_screen, ...)
# HIGH   → R1 SCREEN_FAIL  (recorded, escalated, cannot be approved)
# MEDIUM → cap lowered     (over it: R3 ESCALATE, owner decides)
# LOW    → unchanged
```

## Docs

- CompliR README and verdict shape: https://github.com/mrnetwork0001/complir#readme
- This integration (patch, notes): https://github.com/mrnetwork0001/complir/tree/main/docs/integrations/steward
- On-chain variant if you ever want `AllowanceManager` to refuse a HIGH payee itself: `require(ICompliR(COMPLIR).isAllowed(payee, ICompliR.Tier.MEDIUM))` (`contracts/src/ICompliR.sol` in our repo).

## Free screenings during Tameion

Every Tameion team gets free screenings for the event: send us your agent address (or your contractor list for a shadow report of what the denylist passed that we would have held) and we switch x402 off for it, no signup. Happy to adjust the tier mapping or move the MEDIUM case onto `PARTIAL` instead of `ESCALATE` if you prefer.
