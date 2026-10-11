# USYC revenue sweep (C15)

**What it does.** x402 revenue arrives as USDC in the revenue wallet (`X402_PAY_TO`). Once an hour the sweep reads the
wallet's USDC and USYC balances, keeps a small liquid float, and plans one of:

| action    | when                                              | amount                        |
|-----------|---------------------------------------------------|-------------------------------|
| `DEPOSIT` | `usdc − float ≥ minSweep`                         | `usdc − float` → Teller.deposit |
| `REDEEM`  | `usdc < float` and USYC held, shortfall ≥ minSweep | `min(float − usdc, usycValue)` → Teller.redeem |
| `NONE`    | otherwise                                         | —                             |

Every tick appends a `NOOP` entry with `payload.type = "USYC_SWEEP"` to the hash-chained decision log (balances, plan,
mode, tx hashes when live), so the treasury policy is as auditable as the verdicts.

**Default is DRY-RUN.** Nothing is signed or sent unless `USYC_MODE=live`.

## Files

- `src/lib/usyc/sweep.ts` — `planSweep()` (pure), `runSweepOnce()`, `usycEnv()`, Teller ABI, default addresses.
- `src/lib/usyc/sweep.test.ts` — planner tests.
- `worker/usyc.ts` — hourly loop: `npx tsx --env-file=.env.local worker/usyc.ts`.
- `src/app/api/internal/usyc/route.ts` — `POST|GET /api/internal/usyc` with `Authorization: Bearer $CRON_SECRET`
  (add to `vercel.json` crons, e.g. `{ "path": "/api/internal/usyc", "schedule": "0 * * * *" }`).

## Env

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

## Contracts (Arc)

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

## What is needed to go live (read this)

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
3. `USYC_MODE=live`, and run either `worker/usyc.ts` or the cron hitting `/api/internal/usyc`.
4. Optional: tune `USYC_FLOAT_USDC` to cover expected refunds + gas for an hour.

## Caveats

- **Whitelisting is the blocker.** A hackathon wallet will not be entitled; keep DRY-RUN for the demo and show the
  logged plans (`/ledger` shows `NOOP · USYC_SWEEP` entries). Mention plainly that live mode is one onboarding away.
- USYC's price is > 1 USDC and accrues; `REDEEM` sizes shares with `convertToShares` and caps at the holding.
- The Entitlements contract can halt all USYC activity (sanctions/OFAC oracle via Chainalysis); a live sweep can fail
  for reasons outside our control — it is logged, never retried blindly (next hourly tick re-plans from balances).
- "Earn Kit" (Arc App Kits, announced 30 Sep 2026) is USDC/EURC lending via Morpho, not USYC
  ([cryptobriefing](https://cryptobriefing.com/circle-arc-stablecoin-lending-kits/)); USYC remains the Teller flow above.
- Nothing here touches customer funds: only CompliR's own x402 revenue is swept ("never holds funds" still holds).
