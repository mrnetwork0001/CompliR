# Circle Developer-Controlled Wallets + Gas Station in CompliR

CompliR's two service wallets on Arc are Circle **Developer-Controlled Wallets** (DCW), and on-chain registry writes can
be relayed through Circle's **contract-execution** API with **Gas Station** sponsorship. Raw-key signing stays as the
fallback. Nothing here needs credentials to run: without them every call reports `dry-run`.

| Role      | Purpose                                                                                     | Default type |
|-----------|---------------------------------------------------------------------------------------------|--------------|
| `revenue` | x402 `payTo` (set `X402_PAY_TO` to it); source wallet for the USYC sweep                     | SCA          |
| `ops`     | gas-paying relayer for `AttestationRegistry.attest(...)` (and `anchorRoot` if it is attester) | SCA          |

Code: `src/lib/circle/{client,wallets,execute}.ts`, signer switch in `src/lib/chain/registryWriter.ts` /
`anchorWriter.ts`, status endpoint `GET /api/internal/circle`, one-shot setup `scripts/circle/setup.ts`,
tests `src/lib/circle/circle.test.ts`. SDK: `@circle-fin/developer-controlled-wallets@10.8.1` (pinned).

## What Circle supports on Arc (verified 2026-10-11)

| Question | Answer | Source |
|---|---|---|
| DCW on Arc **mainnet**? | Yes. Blockchain id `ARC` (testnet `ARC-TESTNET`), account types EOA + SCA. The SDK enum has `Arc: "ARC"`. | https://developers.circle.com/wallets/supported-blockchains |
| Gas Station on Arc? | Yes, Arc Mainnet + Arc Testnet are listed for developer-controlled wallets. EVM sponsorship is ERC-4337 → wallet **must be SCA**. Billed to the developer's card: gas in USD + 5%. | https://developers.circle.com/wallets/gas-station |
| How is sponsorship switched on? | By an **active mainnet Gas Station policy** per network in the console (max spend/day, per-tx, ops/day, blocked addresses). No request field; once active it applies to every qualifying SCA transaction. Testnets have a preset policy (Arc Testnet: 50 USDC/day). | https://developers.circle.com/wallets/gas-station/policy-management · https://developers.circle.com/wallets/gas-station/send-a-gasless-transaction |
| What does "sponsored" mean on Arc, where gas *is* USDC? | With a policy: Circle's paymaster pays the USDC gas and bills you in USD. Without one (or for EOA wallets): the wallet's own USDC balance pays gas natively — so a funded wallet always works. | same as above + https://docs.arc.io |
| Circle **Paymaster** (user pays gas in USDC) on Arc? | Not listed (Arbitrum, Avalanche, Base, Ethereum, Optimism, Polygon, Unichain only). Irrelevant on Arc: USDC is already the gas token. | https://developers.circle.com/paymaster |
| Contract execution API | `POST /v1/w3s/developer/transactions/contractExecution` — `walletId`, `contractAddress`, `abiFunctionSignature`+`abiParameters` **or** `callData`, `feeLevel` (LOW/MEDIUM/HIGH) or explicit gas, `idempotencyKey`, `refId`. States: INITIATED → CLEARED → QUEUED → SENT → CONFIRMED → COMPLETE; failures FAILED/DENIED/CANCELLED/STUCK. SCA wallets only get a `txHash` at CONFIRMED. | https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/create-developer-transaction-contract-execution |
| Typed-data signing | `POST /v1/w3s/developer/sign/typedData` (`walletId`, `data` = EIP-712 JSON string, `memo`). EVM only. SCA signatures are ERC-1271-style — not what `ECDSA.recover` expects. | https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/sign-typed-data |
| Spending controls with per-tx / daily caps + allowlists | Exist as **Agent Wallets** (Agent Stack): a *different product* built on user-controlled 2-of-2 MPC wallets, driven only by the Circle CLI (`circle wallet limit set --chain ARC --policy-type stablecoin --per-tx … --daily … --weekly … --monthly …`, `--rule-type recipient-allowlist|contract-allowlist …`), **mainnet only**, each change confirmed by an email OTP. Arc (`ARC`) is supported. There is **no REST API** to attach such a policy to a developer-controlled wallet. | https://developers.circle.com/agent-stack/agent-wallets · https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/custom-policies · https://developers.circle.com/agent-stack/agent-wallets/supported-blockchains · https://developers.circle.com/agent-stack/circle-cli/command-reference |
| Entity secret | 32-byte secret you generate; registered once (SDK `registerEntitySecretCiphertext` or console Configurator); recovery file downloadable **only** during registration; the SDK re-encrypts a fresh ciphertext per request. | https://developers.circle.com/wallets/dev-controlled/entity-secret-management · https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet |

## Design

```
verdict ──signAttestation(ATTESTER_PRIVATE_KEY, EIP-712)──► attestation.signature   (local, off-chain, no gas)
                                                               │
             SIGNER_MODE=local  ─► viem writeContract(attest) from the attester key (pays USDC gas itself)
             SIGNER_MODE=circle ─► Circle ops wallet: createContractExecutionTransaction(callData=attest(...))
                                   → poll getTransaction until txHash → stored as registry_tx
                                   (Gas Station-sponsored if a mainnet ARC policy is active; else ops USDC pays)
                                   any failure / dry-run ─► falls back to the local path
```

* **`attest()` is permissionless** (`contracts/src/AttestationRegistry.sol`: "Callable by anyone; the signature is the
  authority"), so the attester key never needs gas — the Circle `ops` wallet relays. The attester key stays local
  because the registry verifies with `ECDSA.recover`, and an SCA wallet (needed for sponsorship) cannot produce such a
  signature.
* **`anchorRoot()` is `onlyAttester`.** In `circle` mode `anchorWriter.ts` reads `attester()` on-chain: if it equals
  the Circle `ops` wallet (owner ran `setAttester(ops)`; only sensible with `CIRCLE_ACCOUNT_TYPE=EOA`) the anchor goes
  through Circle; otherwise the local attester key anchors (`via: "local"` in the result). Anchoring runs once per
  `ANCHOR_EVERY_N` decisions, so its gas is negligible either way. `signTypedDataWithCircle()` is implemented for the
  alternative design (Circle EOA wallet *as* attester) but not wired into `pipeline.ts`.
  Trade-off: Circle-as-attester gives one fewer raw key but forfeits Gas Station (EOA) and makes every verdict a
  Circle API round-trip; relayer-only keeps verdict signing offline/instant and gets sponsorship. We chose relayer-only.
* **Spending controls** — enforced app-side in `src/lib/circle/wallets.ts` since DCW has no policy API:
  per role `perTxUsdc`, `dailyUsdc` (rolling 24h ledger `circle_spend`), `allowlist` (ops default = `REGISTRY_ADDRESS`;
  contract calls to anything else throw `SpendingPolicyError` before touching Circle). Stored in `circle_wallets.policy`
  (`applySpendingPolicy(role, …)`), surfaced by `/api/internal/circle` together with the equivalent Circle CLI command
  for Agent Wallets. Gas Station's own per-tx / per-day USD caps add a Circle-side ceiling on sponsored gas.
* **Calldata, not `abiParameters`**: `executeContract` encodes with viem and sends `callData`, avoiding Circle's loose
  parameter typing for `bytes`/`uint64` and keeping the local and Circle paths byte-identical.
* **Idempotent provisioning**: wallet set resolved by `CIRCLE_WALLET_SET_ID` → stored row → name → create; wallets
  looked up on Circle by `refId` (`complir:revenue`, `complir:ops`) before any create; rows persisted in
  `circle_wallets` (PK `role, blockchain`), so mainnet and testnet wallets coexist.

## Setup (flip from dry-run to live)

1. **API key** — https://console.circle.com → API Keys → create (toggle the console to **Mainnet** for Arc mainnet).
   `CIRCLE_API_KEY=…`
2. **Entity secret** — `node scripts/circle/setup.ts --generate-secret` → `CIRCLE_ENTITY_SECRET=<64 hex>`.
3. **Register it once** — `node --env-file=.env.local scripts/circle/setup.ts --register` (writes the recovery file to
   `.data/circle-recovery-<ts>.dat`; move it somewhere safe — it cannot be downloaded again). Console alternative:
   Wallets → Configurator → paste the ciphertext.
4. **Provision** — `node --env-file=.env.local scripts/circle/setup.ts [--balances]` → prints `CIRCLE_WALLET_SET_ID`,
   `X402_PAY_TO`/`REVENUE_WALLET` (= revenue wallet), `OWN_WALLETS`, the ops address and the policy to apply.
   (Or `POST /api/internal/circle {"provision":true}` with the CRON secret.)
5. **Fund** the ops wallet with a few USDC (gas) and **sponsor** it: console → Gas Station → Mainnet → new policy →
   blockchain ARC → max spend/day + per-tx (USD) → Create → **Activate**; add a card.
6. `SIGNER_MODE=circle`. Keep `ATTESTER_PRIVATE_KEY` (signs EIP-712 off-chain) and `REGISTRY_ADDRESS`.
7. Check `GET /api/internal/circle` (`Authorization: Bearer $CRON_SECRET`): `effectiveSigner: "circle"`, wallet
   addresses, live balances, policy, hints (e.g. "X402_PAY_TO should be the Circle revenue wallet …").
8. Optional, USYC: the revenue wallet must be whitelisted for the USYC Teller (docs/USYC.md); `transferUsdc()` /
   `executeContract({role:"revenue", …})` are available for a Circle-backed sweep (not yet wired into `usyc/sweep.ts`).

## Dry-run vs live

| | Without `CIRCLE_API_KEY`+`CIRCLE_ENTITY_SECRET` | With credentials |
|---|---|---|
| `circleStatus()` | `enabled:false, reason:"… unset → dry-run"` | `enabled:true, blockchain:"ARC"` |
| `ensureWallets()` | returns stored rows, `mode:"dry-run"`, never calls Circle | creates/fetches set + wallets |
| `executeContract()` | `{status:"dry-run", calldata, to, reason}` — no throw | `{status:"sent", txId, txHash, state, …}` |
| `transferUsdc()` / `signTypedDataWithCircle()` | `{status:"dry-run"}` | sent / signed |
| `SIGNER_MODE=circle` | one warning, then local signer (`signerMode()==="local"`) | Circle relay, local fallback on error |
| `scripts/circle/setup.ts` | prints the exact console steps, exit 0 | provisions and prints env values |

## Caveats / unverified

* Gas Station on Arc mainnet is documented as supported but we could not exercise it without an account; the mainnet
  policy must be created manually (no API) and sponsorship is capped by that policy. Transactions above the policy
  limits are **not** sponsored — the SCA then pays from its own USDC, so keep a small USDC float in `ops`.
* `transferUsdc()` identifies USDC by `tokenAddress=USDC_ADDRESS` + `blockchain`. On Arc USDC is also the native token;
  if Circle reports it as `isNative` the `tokenAddress` may need to be omitted (switch to `tokenId` from
  `getWalletTokenBalance`). Verify with one 0.01 USDC transfer before relying on it.
* An SCA's `txHash` only appears at `CONFIRMED`; `CIRCLE_TX_TIMEOUT_MS` (120 s) bounds the wait. `registryWriter`
  falls back to the local key on timeout, which can double-submit the same attestation — the contract rejects the
  second (`DecisionHashUsed`), so it is safe but wastes one gas unit of USDC.
* Wallet-set lookup by name uses the API response field `name`, which the SDK type omits; set `CIRCLE_WALLET_SET_ID`
  (printed by setup) to skip that lookup.
* Agent Wallets (CLI, MPC, OTP) were **not** adopted: they cannot be driven from a server without an interactive OTP
  session and are a separate custody model. Their policy syntax is printed as `cliHint` for parity only.
