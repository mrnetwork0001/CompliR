# CompliR contracts

Foundry project for the on-chain half of CompliR: a registry of counterparty-risk attestations
on [Arc](https://docs.arc.io) (Circle's EVM L1, gas paid in USDC) and a reference integrator.

| Contract | Path | Purpose |
| --- | --- | --- |
| `ICompliR` | `src/ICompliR.sol` | Minimal read interface integrators copy. `tierOf`, `isAllowed`, events. |
| `AttestationRegistry` | `src/AttestationRegistry.sol` | Stores the latest tier per address. `Ownable2Step` + `Pausable`, attester role, EIP-712 `attest`, `attestDirect`, `attestBatch`, `revoke`, `anchorRoot`. |
| `GuardedTreasury` | `src/examples/GuardedTreasury.sol` | Example: releases USDC only to payees whose tier is `<= maxTier` and still valid. |

Tier enum (part of the ABI, mirrored in `src/lib/types.ts` / `src/lib/contracts/index.ts`):
`UNKNOWN=0, LOW=1, MEDIUM=2, HIGH=3`.

## EIP-712

Must stay byte-identical to `src/lib/attest/eip712.ts`. `test_typehash_matchesTypeScriptSigner` and
`test_viemSignedAttestation_isAcceptedOnArcChainId` pin both sides.

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
  name = "CompliR", version = "1"
Attestation(address subject,uint8 tier,uint8 score,bytes32 decisionHash,uint64 issuedAt,uint64 validUntil)
  typehash = 0x86d4b56447401a0aa7aea88cef207cd6ff21bb50dd72f46b5e5baccf75e854db
```

## Develop

```sh
forge build
forge test -vv
forge test --gas-report
forge fmt
```

Dependencies are vendored in `lib/` (`forge-std`, `openzeppelin-contracts` 5.4.0) via
`forge install ... --no-git`; there are no git submodules.

## Deploy

The deploy script reads two env vars and takes the gas payer from `--private-key` / `--account`:

| Var | Meaning |
| --- | --- |
| `OWNER_ADDRESS` | Cold admin key: rotates the attester, pauses, revokes. Becomes owner at deploy (no 2-step). |
| `ATTESTER_ADDRESS` | Hot key of the CompliR service (signs EIP-712 attestations, writes directly, anchors roots). |
| `ARC_RPC_URL` | HTTPS RPC for the target network. |
| `PRIVATE_KEY` | Broadcaster key. Needs **USDC** on Arc for gas (see below). |

### Arc testnet (chain id `5042002`)

```sh
export ARC_RPC_URL=https://rpc.testnet.arc.network
export PRIVATE_KEY=0x...
export OWNER_ADDRESS=0x...
export ATTESTER_ADDRESS=0x...

# dry run (simulates, prints addresses, no broadcast)
forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_RPC_URL --private-key $PRIVATE_KEY

# broadcast
forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_RPC_URL --private-key $PRIVATE_KEY --broadcast
```

Fund the broadcaster from the Circle faucet (<https://faucet.circle.com>, pick "Arc Testnet").
Explorer: <https://testnet.arcscan.app>.

### Arc mainnet (chain id `5042`)

Same command with a mainnet RPC. Use a hardware/keystore account rather than a raw key:

```sh
export ARC_RPC_URL=<arc mainnet rpc>
forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_RPC_URL --account <keystore-name> --sender <addr> --broadcast
```

`block.chainid` is logged before broadcasting; abort if it is not the chain you expect.

### Example treasury (optional)

```sh
export REGISTRY_ADDRESS=<AttestationRegistry from above>
export TOKEN_ADDRESS=0x3600000000000000000000000000000000000000   # USDC ERC-20 interface on Arc testnet
forge script script/Deploy.s.sol:DeployGuardedTreasury --rpc-url $ARC_RPC_URL --private-key $PRIVATE_KEY --broadcast
```

### Gas is USDC

On Arc the native gas token **is USDC**: the broadcaster needs a USDC balance, and fees show up in
dollars. The native balance is exposed with 18 decimals while the ERC-20 interface at
`0x3600…0000` uses 6, so a raw `eth_getBalance` is `10^12` times the ERC-20 amount. `forge` only
cares that `eth_getBalance` covers `gas * gasPrice`, so nothing special is needed beyond funding.

Because `attest(...)` is permissionless (the signature is the authority), the attester wallet
itself never needs gas: any relayer, or a paymaster / gas station, can submit it.

## Verify

Arc's explorer and Sourcify support are evolving; try these in order.

```sh
# Sourcify (if Arc's chain id is in the Sourcify registry)
forge verify-contract <ADDRESS> src/AttestationRegistry.sol:AttestationRegistry \
  --chain-id 5042002 --verifier sourcify \
  --constructor-args $(cast abi-encode "constructor(address,address)" $OWNER_ADDRESS $ATTESTER_ADDRESS)

# Blockscout-style explorer (arcscan)
forge verify-contract <ADDRESS> src/AttestationRegistry.sol:AttestationRegistry \
  --chain-id 5042002 --verifier blockscout --verifier-url https://testnet.arcscan.app/api \
  --constructor-args $(cast abi-encode "constructor(address,address)" $OWNER_ADDRESS $ATTESTER_ADDRESS)
```

Or pass `--verify --verifier sourcify` (or `--verifier blockscout --verifier-url ...`) directly to
`forge script ... --broadcast`. If neither works, upload the standard JSON input from
`out/AttestationRegistry.sol/AttestationRegistry.json` (`metadata` field) or run
`forge verify-contract --show-standard-json-input` and paste it into the explorer UI.
`bytecode_hash = "none"` and `cbor_metadata = false` keep the bytecode deterministic.

## Export ABIs to the app

```sh
forge build && node scripts/export-abi.mjs
```

Writes `src/lib/contracts/registryAbi.ts` and `src/lib/contracts/guardedTreasuryAbi.ts`
(`as const`, viem-typed). Re-run after any ABI change and commit the result.

## Notes on Arc

- `evm_version = "paris"` in `foundry.toml`: Arc's exact fork is not pinned here. Paris bytecode
  (no `PUSH0`/`MCOPY`/`TSTORE`) runs on any post-Merge EVM; bump to `cancun` once confirmed.
- Arc blocks are ~1s with deterministic finality (no reorgs), so a receipt is final.
- Mainnet details (RPC URL, explorer, Sourcify support) were not publicly documented at the time
  of writing; the chain id `5042` is taken from the project spec. Confirm before broadcasting.

## GuardedTreasury on mainnet (Guarded Payouts demo)

The `/payouts` page runs a treasury agent that pays invoices through `GuardedTreasury` — every
`release` is gated by `ICompliR.isAllowed(payee, MEDIUM)` on the live registry. It runs in
**dry-run** by default (verdicts and ledger are real, transfers are simulated) and flips to live
with env only.

1. **Deploy** (Arc mainnet, chain id `5042`, gas is USDC). The owner must be the treasury agent's
   key — it is the only account allowed to call `release`:

   ```sh
   export ARC_RPC_URL=https://rpc.mainnet.arc.io
   export REGISTRY_ADDRESS=<AttestationRegistry on mainnet>
   export TOKEN_ADDRESS=0x3600000000000000000000000000000000000000   # USDC ERC-20 interface (6 dp)
   export OWNER_ADDRESS=<address of TREASURY_PRIVATE_KEY>             # the treasury agent key
   export PRIVATE_KEY=<broadcaster key with a little USDC for gas>    # may be the same key

   forge script script/Deploy.s.sol:DeployGuardedTreasury --rpc-url $ARC_RPC_URL --private-key $PRIVATE_KEY            # simulate
   forge script script/Deploy.s.sol:DeployGuardedTreasury --rpc-url $ARC_RPC_URL --private-key $PRIVATE_KEY --broadcast
   ```

   The script requires `REGISTRY_ADDRESS` to have code on the target chain and prints
   `GuardedTreasury: 0x…`.

2. **Fund it** with at most 50 USDC via a plain ERC-20 transfer (the demo policy caps payouts at
   25 USDC each / 50 USDC per day, so this covers the three demo invoices: 10 paid + 25 limited):

   ```sh
   cast send 0x3600000000000000000000000000000000000000 "transfer(address,uint256)" <GuardedTreasury> 50000000 \
     --rpc-url $ARC_RPC_URL --private-key $PRIVATE_KEY
   cast call 0x3600000000000000000000000000000000000000 "balanceOf(address)(uint256)" <GuardedTreasury> --rpc-url $ARC_RPC_URL
   ```

   The agent key itself also needs a little USDC for gas (`release` ≈ 60k gas).

3. **Set env** on the app (`.env.local` / Vercel):

   ```
   REGISTRY_ADDRESS=<AttestationRegistry>
   ATTESTER_PRIVATE_KEY=<CompliR attester key>        # so verdicts are mirrored on-chain before release
   GUARDED_TREASURY_ADDRESS=<GuardedTreasury>
   TREASURY_PRIVATE_KEY=<owner key from step 1>
   TREASURY_MODE=live
   # optional policy overrides (defaults: MEDIUM / 25 / 50)
   TREASURY_MAX_TIER=MEDIUM
   TREASURY_PER_PAYOUT_CAP_USDC=25
   TREASURY_DAILY_CAP_USDC=50
   TREASURY_REQUIRE_ONCHAIN=1                         # default in live mode
   CRON_SECRET=<random>                               # protects /api/internal/treasury
   ```

4. **Flip to live.** With all four of `TREASURY_MODE=live`, `TREASURY_PRIVATE_KEY`,
   `GUARDED_TREASURY_ADDRESS`, `REGISTRY_ADDRESS` set, the next tick
   (`npx tsx --env-file=.env.local worker/treasury.ts`, a cron hitting `/api/internal/treasury`, or
   the "Run agent now" button) writes each verdict to the registry, simulates `release` (a HIGH
   payee reverts with `CompliR: payee tier too high` before any gas is spent), sends it, waits for
   the receipt and records the tx hash on `/payouts`. Remove `TREASURY_MODE=live` to go back to
   dry-run; pull funds back any time with `withdraw(to, amount)` from the owner key.

## GuardedTreasuryV2 - proof-of-screening on every payment

`src/examples/GuardedTreasuryV2.sol` keeps v1's `release(payee, amount)` and adds

```solidity
function releaseWithProof(address payee, uint256 amount, bytes32 decisionHash) external onlyOwner
```

which requires **both** `ICompliR.isAllowed(payee, maxTier)` **and**
`registry.recordOf(payee).decisionHash == decisionHash` - the caller names the exact verdict it is paying
against, and the contract only pays if that is the verdict currently stored on-chain for the payee. A
re-screen or revoke between the agent's decision and the release makes the call revert with
`CompliR: decisionHash mismatch` instead of paying under a verdict nobody looked at. It emits
`ReleasedWithProof(payee, amount, decisionHash, tier)` (`decisionHash` indexed). Ownership is `Ownable2Step`;
`withdraw` and `setMaxTier` are unchanged.

Tests: `test/GuardedTreasuryV2.t.sol` (matching hash pays; mismatched / stale hash, HIGH, UNKNOWN, expired,
revoked and non-owner all revert; v1 `release` still works). Deploy with the same env as v1:

```sh
forge script script/Deploy.s.sol:DeployGuardedTreasuryV2 --rpc-url $ARC_RPC_URL --private-key $PRIVATE_KEY --broadcast
forge verify-contract <ADDRESS> src/examples/GuardedTreasuryV2.sol:GuardedTreasuryV2 --chain-id 5042 --verifier sourcify \
  --constructor-args $(cast abi-encode 'constructor(address,address,address)' $REGISTRY_ADDRESS $TOKEN_ADDRESS $OWNER_ADDRESS)
```

**Arc mainnet (chain 5042):** `GuardedTreasuryV2` at `0x3B13186a1E4b1108eA5CB2f8853D84A2aeD71Cc5`
(deploy tx `0x39ee1cb39faa4dba9f010e45c8e3f5c89e9e5996660e6b259063a42cdb37af00`, Sourcify full match,
owner = treasury agent `0xc742…960c`, registry `0xA82EDb5e111c31C63E06EF0007f2fa1a9e7EB30d`, token USDC
`0x3600…0000`). v1 at `0x5465f31a6155E3eCCcC35f4E5bDC0e287763B0ee` stays deployed (empty) for reference.
The app's live executor (`src/lib/treasury/agent.ts`) now calls `releaseWithProof` with the verdict's
attestation `decisionHash`; the ABI is exported to `src/lib/contracts/guardedTreasuryV2Abi.ts`.
