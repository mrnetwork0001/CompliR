# Revenue yield: Circle Earn (default) and USYC (alternative)

x402 revenue lands as USDC in the Circle `revenue` wallet (`X402_PAY_TO`). Once an hour (and whenever the operator picks
`SWEEP_TO_YIELD` / `REDEEM_FROM_YIELD`) CompliR keeps a liquid float and parks the rest in yield.

**Backend.** `YIELD_BACKEND=earn` (default): a Circle Earn vault on Arc (Morpho USDC, ERC-4626, no allowlist).
`YIELD_BACKEND=usyc`: the USYC Teller (permissioned, ~100k minimum; kept as the alternative, see the end of this file).
USYC can only run dry for a hackathon-sized treasury, which is why Earn is the default (suggested by the Arc team:
"Earn Kit on mainnet, Morpho USDC vaults on Arc, no allowlist needed").

**Default is DRY-RUN.** Nothing is signed unless `YIELD_MODE=live`. Even live, funds only move when the planner says so.

## Circle Earn Kit, briefly

- Earn Kit is one of Arc's App Kits (launched 30 Sep 2026 with Onramp and Borrow Kits): USDC/EURC deposits into curated
  Morpho vaults; curators include Steakhouse Financial and Galaxy. Funds sit in the vault contracts, not with Circle,
  and lending positions can lose value. ([docs.arc.io › App Kit](https://docs.arc.io/app-kit),
  [docs.arc.io › Earn](https://docs.arc.io/app-kit/earn), [arc.io/app-kits](https://www.arc.io/app-kits),
  [Crypto Briefing](https://cryptobriefing.com/arc-earn-kit-sdk-morpho-vaults-usdc/),
  [Crypto Briefing, three kits](https://cryptobriefing.com/circle-arc-stablecoin-lending-kits/))
- SDK: `@circle-fin/earn-kit` (1.8.1; 1.7.0 added Arc mainnet `EarnChain.Arc`, chain id 5042) with
  `@circle-fin/adapter-viem-v2`. Functions: `exploreVaults`, `getVaults`, `getPosition`, `getDepositQuote`, `deposit`,
  `getWithdrawalQuote`, `withdraw`, `claimRewards` ([README](https://cdn.jsdelivr.net/npm/@circle-fin/earn-kit/README.md)).
- Under the hood the SDK calls the Earn Service API at `https://api.circle.com/v1/earnKit/*`
  (`@circle-fin/provider-earn-service` 1.7.1). Vault discovery is
  **`GET /v1/earnKit/vaults/explore?chain=ARC[&asset=USDC&sortBy=apy|tvl|name&minApy&minTvl&page&pageSize]`**, and it works
  without a key (the SDK's "permissionless (keyless) client path"; an API key is optional and server-only).
- Per-vault metadata (`EarnOpportunity`): `address`, `name`, `asset`/`assetAddress`, `apyProfile.{current,native,d7,d30,d90}`,
  `fee.{performance,management}`, `liquidityProfile.{totalDeposits,available,totalSupply,status}` where
  **`status: "active" | "low_liquidity"` is Circle's illiquid flag**, `riskSignals.{circleSentinel, warnings[{type, level:
  YELLOW|RED}], earnKitWarnings}`, `manager` (curator), `collateral[]`, `asOf`.
- **Minimums:** none documented by Earn Kit; Morpho V2 vaults take any amount > 0 shares. Withdrawal fees, if any,
  show in `getWithdrawalQuote().fees` (Circle fee only on the SDK's own path; we call the vault directly).
- **Withdrawal liquidity caveat:** a vault can only pay out what is idle or withdrawable from its markets right now
  (`liquidityProfile.available`). Morpho **Vault V2** returns `0` from `maxDeposit`/`maxWithdraw` by design, so on-chain
  max* calls are useless as a liquidity signal; we use Circle's `available` + `status` and simulate `redeem` before sending.

Why not the SDK itself: we only need the metadata (one keyless GET) plus three ERC-4626 calls, and the calls must go
through the Circle Developer-Controlled `revenue` wallet with our spending policy, which the SDK's viem adapter does not
do. Plain viem + ERC-4626 is enough, so no new dependency.

## Vaults on Arc mainnet (checked 2026-10-14)

`GET https://api.circle.com/v1/earnKit/vaults/explore?chain=ARC&pageSize=100` returned 30 vaults (24 USDC, 6 EURC), all
`protocol: MORPHO`. Those that matter:

| vault | address | APY | TVL (USDC) | available | Circle flags | used? |
|-------|---------|-----|-----------|-----------|--------------|-------|
| **Steakhouse Prime USDC** (steakUSDC) | `0xbeef0016cb2fd5c352ea7ca08a9f54739dfa7298` | 3.06% | 5.11M | 4.94M | active, Sentinel, no warnings | **chosen** |
| Galaxy USDC (arcUSDC) | `0x8e357432cc12ff425c36432f312968aeb16112af` | 3.07% | 89.8M | 4.94M | **low_liquidity** | refused (illiquid) |
| Keyrock Prime USDC | `0x5befab92a5a3d60f578cb51eeb4e4fd50a1e3123` | 3.06% | 75.1M | 4.94M | **low_liquidity**, no Sentinel | refused |
| Gauntlet USDC Prime | `0xdeccd53be5453215821184824b519e04c7e00bc7` | 3.06% | 87.5k | 0.1 | **low_liquidity** | refused |
| Bitwise Premium RWA USDC (PAPY) | `0x7610094b846657dcf166d59e42973db52c7015f9` | 4.00% | 149k | 16.3k | active, no Sentinel | refused while `YIELD_REQUIRE_SENTINEL=1` |
| Steakhouse Prime USDC (older) | `0xbeef0007d5a04246f5382957035df34f7e82102e` | 1.6% | 29.6k | 14.7k | YELLOW `not_whitelisted` | refused |
| many `Test*` / unnamed vaults | | 0% | ≤ 1 USDC | | RED `timelock` + `not_whitelisted` | refused |

On-chain checks (`cast`, `rpc.mainnet.arc.io`, block ~25.93M) for the chosen vault and runner-ups:

```
0xbeef0016…7298  asset()=0x3600…0000 (USDC)  name()="Steakhouse Prime USDC" symbol()="steakUSDC" decimals()=18
                 totalAssets()=5,106,082.32 USDC  convertToAssets(1e18)=1.000588 USDC  maxWithdraw(x)=0 maxDeposit(x)=0 (Vault V2)
                 liquidityAdapter()=0xF83d…6bF2  receiveSharesGate/sendSharesGate/receiveAssetsGate/sendAssetsGate = 0x0 (no allowlist)
                 performanceFee()=0 managementFee()=0  curator()=0x827e…eCdB (Steakhouse)
0x7610…15f9      asset()=USDC  "Bitwise Premium RWA USDC"  totalAssets()=149,315.53  gates 0x0  managementFee()>0  idle USDC 15,035
0x8e35…12af      asset()=USDC  "Galaxy USDC"  totalAssets()=89,766,516.77
```

Shares are 18-dp, assets are USDC 6-dp.

## Rules (src/lib/earn/planner.ts)

**How much.** Same float rule as before: `effective float = YIELD_FLOAT_USDC (5) + obligations due within 48 h`
(the operator adds pending GuardedTreasury invoices). Deposit `usdc − float` when ≥ `YIELD_MIN_SWEEP_USDC` (1), capped
at `YIELD_MAX_SWEEP_USDC` (25 = the revenue wallet's per-tx policy). Redeem the shortfall when below the float, capped
at what is held. **Never sweep when the float (balance read) or the obligations are unknown**, and never deposit when
the Earn metadata is unavailable.

**Where (deposit).** A vault must: take USDC; **not be flagged illiquid** (`low_liquidity`); carry no RED warning
(e.g. `timelock`) and not be `not_whitelisted`; be Circle Sentinel-covered (`YIELD_REQUIRE_SENTINEL=1`); have TVL ≥
`YIELD_MIN_TVL_USDC` (100k) and APY > 0; be in the revenue wallet's contract allowlist (when non-empty); and have
**available liquidity ≥ 2× (deposit + what we already hold there)** (`YIELD_LIQUIDITY_MULTIPLE`). Best current APY wins
(ties → larger TVL). `YIELD_VAULT` pins one vault (it still has to pass every rule).

**Where (redeem).** Among held vaults: available ≥ 2× the amount, lowest APY first; else any vault whose available
liquidity covers the amount (logged as thin liquidity); else nothing moves.

## Execution (src/lib/earn/sweep.ts)

From the Circle `revenue` wallet (SCA, Gas Station-sponsored) through `executeContract`:

```
DEPOSIT  USDC(0x3600…).approve(vault, assets)  →  vault.deposit(assets, receiver = revenue wallet)
REDEEM   shares = min(vault.previewWithdraw(assets), held)  →  eth_call simulate  →  vault.redeem(shares, wallet, wallet)
```

Guards before sending: the Circle revenue wallet address must equal `REVENUE_WALLET`/`X402_PAY_TO` (balances are read
for that address); `previewDeposit > 0`; the app-enforced spending policy (`checkSpend`) with the deposit amount counted
against per-tx/daily caps (`policyAmountUsdc`, no native value attached) and a **contract allowlist** for contract calls
(`SpendingPolicy.contractAllowlist`; plain transfers for tips/refunds are unaffected). The revenue wallet's contract
allowlist is currently `[USDC 0x3600…0000, Steakhouse Prime USDC 0xbeef0016…7298]`. To allow another vault:

```
npx tsx --env-file=.env.local scripts/circle/allow-contracts.ts revenue 0x<vault>
```

**Ledger.** Every tick appends one entry: `NOOP · YIELD_PLAN` when nothing executed (dry, NONE, or a failed attempt with
its error), `OPERATOR · YIELD_SWEEP` / `OPERATOR · YIELD_REDEEM` with the tx hashes when it moved funds. The operator
tick itself remains `OPERATOR · type=OPERATOR` (the /company log only reads those).

## Run it

- `POST|GET /api/internal/usyc` with `Authorization: Bearer $CRON_SECRET` (path kept for existing crons) → one tick.
- `npx tsx --env-file=.env.local worker/usyc.ts` (hourly loop) or `worker/all.ts` (job `yield`).
- The operator (`/api/internal/operator`, `worker/operator.ts`) proposes `SWEEP_TO_YIELD` / `REDEEM_FROM_YIELD` and runs
  the same tick with its effective float.
- `/company` → Reserves card: float, positions (vault name, address, shares, assets, APY, liquidity) and the target vault.

### Env

| var | default | notes |
|-----|---------|-------|
| `YIELD_BACKEND` | `earn` | `usyc` = legacy Teller sweep |
| `YIELD_MODE` | `dry` | `live` executes via the Circle revenue wallet |
| `YIELD_FLOAT_USDC` | `5` | cushion; operator adds obligations due 48 h |
| `YIELD_MIN_SWEEP_USDC` | `1` | |
| `YIELD_MAX_SWEEP_USDC` | `25` | keep ≤ `CIRCLE_REVENUE_POLICY_PER_TX_USDC` |
| `YIELD_MIN_TVL_USDC` | `100000` | |
| `YIELD_REQUIRE_SENTINEL` | `1` | `0` admits non-Sentinel vaults (e.g. Bitwise 4.0%) |
| `YIELD_LIQUIDITY_MULTIPLE` | `2` | |
| `YIELD_VAULT` | — | pin |
| `YIELD_EARN_API_URL` / `YIELD_EARN_API_KEY` | `https://api.circle.com` / — | |
| `REVENUE_WALLET` | `X402_PAY_TO` | must be the Circle revenue wallet for live |

### Demoing a real deposit

The revenue wallet holds ~2 USDC against a 5 USDC float, so the planner says `NONE` and nothing moves. Do not force it.
To see a live deposit, top up the revenue wallet (`0x9b0d…977e`) so its USDC exceeds `5 + obligations due 48 h + 1`
(e.g. send 10 USDC from your own wallet), then call `/api/internal/usyc`: it will approve + deposit the excess (≤ 25)
into Steakhouse Prime USDC and log `OPERATOR · YIELD_SWEEP` with both tx hashes. Alternatively, anyone can deposit
directly from their own wallet with `cast send 0x3600…0000 "approve(address,uint256)" 0xbeef0016…7298 <amt>` then
`cast send 0xbeef0016…7298 "deposit(uint256,address)" <amt> <you>` — that is outside CompliR and not logged.

## USYC (alternative backend, `YIELD_BACKEND=usyc`)

Every tick appends a `NOOP` entry with `payload.type = "USYC_SWEEP"`. Planner: `DEPOSIT` when `usdc − float ≥ minSweep`
(→ Teller.deposit), `REDEEM` when below float and USYC held (→ Teller.redeem), else `NONE`.


**Default is DRY-RUN.** Nothing is signed or sent unless `USYC_MODE=live`.

### Files

- `src/lib/usyc/sweep.ts` — `planSweep()` (pure), `runSweepOnce()`, `usycEnv()`, Teller ABI, default addresses.
- `src/lib/usyc/sweep.test.ts` — planner tests.
- `worker/usyc.ts` — hourly loop: `npx tsx --env-file=.env.local worker/usyc.ts`.
- `src/app/api/internal/usyc/route.ts` — `POST|GET /api/internal/usyc` with `Authorization: Bearer $CRON_SECRET`
  (add to `vercel.json` crons, e.g. `{ "path": "/api/internal/usyc", "schedule": "0 * * * *" }`).

### Env

| var | default | notes |
|-----|---------|-------|
| `USYC_MODE` | `dry` | `live` executes on-chain |
| `USYC_FLOAT_USDC` | `5` | USDC kept liquid (gas on Arc is paid in USDC; refunds) |
| `USYC_MIN_SWEEP_USDC` | `1` | never move less than this |
| `USYC_ADDRESS` | per chain (below) | USYC token |
| `USYC_TELLER_ADDRESS` | per chain (below) | Teller (USDC) |
| `USYC_ENTITLEMENTS_ADDRESS` | per chain (below) | informational |
| `REVENUE_PRIVATE_KEY` | — | **live only**; the wallet that receives x402 revenue (must equal `X402_PAY_TO`) |
| `REVENUE_WALLET` | key → `X402_PAY_TO` | address to read balances for in dry-run when there is no key |

### Contracts (Arc)

Verified 2026-10-11 against [docs.arc.io › Contract addresses](https://docs.arc.io/arc/references/contract-addresses)
and [developers.circle.com › USYC smart contracts](https://developers.circle.com/tokenized/usyc/smart-contracts);
on-chain check via `rpc.mainnet.arc.io`: USYC `symbol()="USYC"`, `decimals()=6`, Teller implementation exposes
`deposit(uint256,address)`, `redeem(uint256,address,address)`, `convertToShares`, `convertToAssets`, `preview*`.

| contract | Arc mainnet (5042) | Arc testnet (5042002) |
|----------|--------------------|-----------------------|
| USYC | `0x8a5D989Bbb96929F689B0200f435f53dA42bF490` | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` |
| USYC Teller (USDC) | `0x51A8CE47dC08ba5CD19c7aa84EA6fD6664f60f9b` | `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` |
| USYC Entitlements | `0xb69ecb156Dc0028198028c501340d5367845ca72` | `0xcc205224862c7641930c87679e98999d23c26113` |
| USYC Oracle | `0x4BC8d5aCD3d040d2903dD9C5B7048520c6ff537A` | `0x52b56c7642E71dc54714d879127d97cd0B3D4581` |
| USDC | `0x3600000000000000000000000000000000000000` | same |

Teller interface ([Circle quickstart](https://developers.circle.com/tokenized/usyc/subscribe-and-redeem)):

```solidity
function deposit(uint256 _assets, address _receiver) external returns (uint256 shares);  // after usdc.approve(teller, _assets)
function redeem(uint256 _shares, address _receiver, address _account) external returns (uint256 assets);
```

Live `DEPOSIT` = `USDC.approve(teller, amount)` → `teller.deposit(amount, wallet)`. Live `REDEEM` =
`teller.redeem(min(convertToShares(amount), usycBalance), wallet, wallet)`. Both are 6-dp.

### What is needed to go live

1. **Entitlement / KYB — mandatory.** USYC is a *permissioned* token: the token and the Teller query the Entitlements
   contract on every deposit, redeem and transfer, and revert for wallets that are not allow-listed. The allow-list is
   populated only after investor onboarding with Circle (formerly Hashnote): onboarding questionnaire → KYC/AML by the
   fund administrator → wallet screening + **wallet address whitelisting** → success email. USYC is offered only to
   entities that are **not U.S. Persons under Regulation S**. Sources:
   [Circle USYC overview](https://developers.circle.com/tokenized/usyc/overview) ("USYC is available only to entities
   that are not U.S. Persons… Eligibility restrictions apply"; onboarding via the Help Center *Investor Onboarding*
   article, questions to customer-support@circle.com) and
   [usyc.docs.hashnote.com](https://usyc.docs.hashnote.com/llms-full.txt) ("Entitlements are the gatekeepers… wallets
   associated with KYC'ed entities receive a Role that entitles them to hold and transfer the token", "Wallet screening
   provider whitelists wallet address provided").
   Until the revenue wallet is entitled, `USYC_MODE=live` will simply produce reverted `deposit` calls (the sweep logs
   the error and keeps running). Hashnote exposes a public check:
   `GET https://api.hashnote.com/v1/entitlements/token_access?address=<wallet>&symbol=USYC` (`checkEntitlement()` in
   `sweep.ts`; response field names are not documented, so it is best-effort).
2. `REVENUE_PRIVATE_KEY` for the x402 `X402_PAY_TO` wallet, funded with a little USDC for gas (Arc gas is USDC).
3. `YIELD_BACKEND=usyc`, `USYC_MODE=live`, and run either `worker/usyc.ts` or the cron hitting `/api/internal/usyc`.
4. Optional: tune `USYC_FLOAT_USDC` to cover expected refunds + gas for an hour.

### Caveats

- **Whitelisting is the blocker.** A hackathon wallet will not be entitled; keep DRY-RUN for the demo and show the
  logged plans (`/ledger` shows `NOOP · USYC_SWEEP` entries). Mention plainly that live mode is one onboarding away.
- USYC's price is > 1 USDC and accrues; `REDEEM` sizes shares with `convertToShares` and caps at the holding.
- The Entitlements contract can halt all USYC activity (sanctions/OFAC oracle via Chainalysis); a live sweep can fail
  for reasons outside our control — it is logged, never retried blindly (next hourly tick re-plans from balances).
- Nothing here touches customer funds: only CompliR's own x402 revenue is swept ("never holds funds" still holds).
