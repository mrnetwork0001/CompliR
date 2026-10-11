# Title

Optional CompliR vendor screening: agent check + on-chain gate in V2

# Body

## What this adds

Two opt-in pieces, both off by default:

**(a) Agent, before a payment is proposed** — `agent/complir.py` + 3 lines in `payables.decide()`. After the vendor-registry check and before the runway check, the vendor wallet is graded by [CompliR](https://github.com/mrnetwork0001/complir) (`POST /api/v1/screen`, one x402 call of 0.01 USDC on Arc: 2-hop USDC funder trace on Arc, OpenSanctions, USDC `isBlacklisted`, lookalike check). The verdict is mapped onto your existing outcomes:

| CompliR tier | CeedeBooks |
|---|---|
| `HIGH` | `ESCALATE` — the approver decides; the reason (with CompliR's `decisionId`) is in the hashed reasoning |
| `MEDIUM`, amount above CompliR's recommended per-payment limit | `ESCALATE`, same |
| `MEDIUM` within the limit, or `LOW` | unchanged: `pay` |

**(b) Contract, `BudgetEnforcerV2`** — an approver-settable `complir` address (zero = disabled). When set, `pay()` additionally requires `ICompliR(complir).isAllowed(vendor, ICompliR.Tier.MEDIUM)`, i.e. the vendor has a current CompliR attestation on Arc at tier LOW or MEDIUM. A HIGH or expired/absent attestation reverts with `"CompliR: vendor tier too high"`, whatever the agent was convinced of — the same guarantee style as the vendor registry and the limits. `contracts/interfaces/ICompliR.sol` is vendored (44 lines, MIT). Two Foundry tests cover it (`setComplir` is approver-only; HIGH reverts, MEDIUM pays, zero disables).

## Why

The vendor registry proves the approver once accepted an address; it cannot see what happened to that wallet since (funded by a sanctioned address, blacklisted by Circle, cloned as a lookalike). Your roadmap row G lists "continuous vendor screening" as planned; this is a drop-in for it that keeps the decision inside the contract when you want it there.

## How to enable

```
# .env
COMPLIR_URL=https://complir.example      # the hosted URL (ask us; mainnet 13 Oct)
COMPLIR_PAYER_PRIVATE_KEY=0x...          # small USDC purse that pays 0.01 USDC per screen over x402 (not the treasury wallet)
```
```
# on-chain, from the approver wallet (admin site tx or cast)
BudgetEnforcerV2.setComplir(<CompliR AttestationRegistry on Arc>)   # setComplir(address(0)) turns it off again
```

## Opt-in and non-breaking

- `COMPLIR_URL` unset: `complir.screen()` returns `None` before any I/O, `complir.gate(None, …)` is `None`, `decide()` is unchanged. CompliR unreachable or unpaid: logged, vendor passes as today. The check only ever makes a decision stricter.
- Contract: `complir` defaults to `address(0)`, so every existing V2 test and the factory flow behave exactly as before; the constructor, `BudgetFactory.createBusiness` and every existing selector are unchanged. The gate is only in `pay()` (the agent's path); `approveEscalation` (the human path) is deliberately left alone so an approver can still override.
- The deployed v1 `BudgetEnforcer` is not touched. New V2 instances need the factory redeployed with the new V2 bytecode (one `forge script`), which I left to you.
- `pytest` additions: 4 tests in `agent/tests/test_complir.py` using your `chain` fixture; no new Python dependency (`httpx`, `web3`/`eth-account` already pinned).

## Usage

```python
# agent/payables.py, decide() — the whole wiring
if not chain.is_vendor_approved(invoice.vendor_wallet):
    return Decision.ESCALATE, "Vendor not registered on-chain"
blocked = complir.gate(await complir.screen(invoice.vendor_wallet, invoice.amount_usdc), invoice.amount_usdc)
if blocked:                       # HIGH, or MEDIUM above its recommended limit
    return Decision.ESCALATE, blocked
```
```solidity
// contracts/BudgetEnforcerV2.sol, pay()
require(complir == address(0) || ICompliR(complir).isAllowed(vendor, ICompliR.Tier.MEDIUM), "CompliR: vendor tier too high");
```

## Docs

- CompliR README, verdict shape and `ICompliR`: https://github.com/mrnetwork0001/complir#readme
- This integration: https://github.com/mrnetwork0001/complir/tree/main/docs/integrations/ceedebooks

## Free screenings during Tameion

Free for every Tameion team during the event: send us your agent address and we switch x402 off for it (no purse key needed), or your vendor list for a shadow report. The registry address for `setComplir` lands with our mainnet deploy on 13 Oct; we will post it in this PR.
