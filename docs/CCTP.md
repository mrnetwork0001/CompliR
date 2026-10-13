# CCTP inbound screening

CompliR tails Circle's CCTP v2 on Arc and screens **both ends** of every inbound USDC bridge ≥ `CCTP_MIN_USDC`
(default 100): the **source-chain sender** (who burned on Ethereum / Base / Arbitrum / …) and the **Arc recipient**
(who received the mint). A recipient that took bridged USDC from a sanctioned or USDC-blacklisted sender gets the
reason code `INBOUND_FLAGGED` (+20) on its next screen - the cross-chain hop no longer hides the funder.

Code: `src/lib/cctp/` (`tailer.ts`, `sender.ts`, `store.ts`, `abi.ts`) · worker `worker/cctp.ts` (60 s) ·
cron `POST /api/internal/cctp` (every minute, `CRON_SECRET`) · public `GET /api/v1/inbound`, `GET /api/v1/inbound/{address}`.

## Contracts and events

Arc mainnet (domain **26**), from [docs.arc.io › Contract addresses › CCTP](https://docs.arc.io/arc/references/contract-addresses)
and [developers.circle.com/cctp/evm-smart-contracts](https://developers.circle.com/cctp/evm-smart-contracts) (same CREATE2
addresses on every CCTP v2 EVM chain except EDGE):

| contract | address |
|----------|---------|
| MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| TokenMinterV2 | `0xfd78EE919681417d192449715b2594ab58f5D002` |

Events (circlefin/evm-cctp-contracts `src/v2/MessageTransmitterV2.sol`, `src/v2/BaseTokenMessenger.sol`):

```solidity
event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody);
event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected);
```

We tail `MessageReceived` on the MessageTransmitterV2 and decode `messageBody` as **BurnMessageV2**
(`src/messages/v2/BurnMessageV2.sol`):

| field | type | index |
|-------|------|-------|
| version | uint32 | 0 |
| burnToken | bytes32 | 4 |
| mintRecipient | bytes32 | 36 |
| amount | uint256 | 68 |
| messageSender | bytes32 | 100 |
| maxFee / feeExecuted / expirationBlock | uint256 | 132 / 164 / 196 |
| hookData | bytes | 228 |

`messageSender` is the source-chain wallet that called `depositForBurn`; `mintRecipient` is the Arc address that
received the mint; `sourceDomain` comes from the event. Verified live 2026-10-14: 220 `MessageReceived` logs in the
last 50k Arc blocks; sample tx `0x92cc25bc…` decodes to sourceDomain 3 (Arbitrum), burnToken = Arbitrum USDC
`0xaf88…5831`, 5000 USDC, and matches the `MintAndWithdraw(…, 5000e6, 0x3600…0000, 0)` in the same tx.

Domains ([developers.circle.com/cctp/supported-domains](https://developers.circle.com/cctp/supported-domains)): Ethereum 0,
Avalanche 1, OP 2, Arbitrum 3, Solana 5, Base 6, Polygon 7, Unichain 10, Linea 11, Codex 12, Sonic 13, World Chain 14,
Monad 15, Sei 16, XDC 18, HyperEVM 19, Ink 21, Plume 22, Arc 26, Injective 29, Morph 30. The full map (with USDC
addresses from [developers.circle.com/stablecoins/usdc-contract-addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)
and public RPCs) is `SOURCE_CHAINS` in `src/lib/cctp/abi.ts`.

## What a tick does

1. `getLogs(MessageReceived)` from the cursor (`cctp_meta.cursor_block`, first run: head − `CCTP_LOOKBACK_BLOCKS`) for up
   to `CCTP_MAX_BLOCKS` blocks (public RPC cap 10k), bisecting on range/result errors.
2. Decode; skip non-v1 bodies and mints below `CCTP_MIN_USDC`; skip (tx, logIndex) already recorded.
3. **Source sender**: OpenSanctions via yente (`CryptoWallet.publicKey`, same matcher as every subject screen) ‖ the
   source chain's USDC `isBlacklisted(sender)` over a public RPC (Ethereum `ethereum-rpc.publicnode.com`, Base
   `mainnet.base.org`, Arbitrum `arb1.arbitrum.io/rpc`, OP `mainnet.optimism.io`, Polygon `polygon-rpc.com`, …).
   Each check has a 4 s timeout and degrades to "not flagged" with its status recorded (`sender_checks`).
   Non-EVM sources (Solana, Injective) get the sanctions check only.
4. **Arc recipient**: the real pipeline, `screen({ address, clientId: "cctp", amountUsdc })` - attested, ledgered,
   mirrored to the registry like any other screen. `"cctp"` is an internal client id (never traction, never "held
   elsewhere"). A recipient screened by this tailer in the last `CCTP_RESCREEN_HOURS` reuses that verdict. At most
   `CCTP_MAX_SCREENS` fresh screens per tick; when the budget is spent the cursor parks before the unprocessed mint.
5. Row in `cctp_inbound`: tx, block, block_time, source_domain, source_chain, source_sender, recipient, amount_usdc,
   burn_token, sender_sanctions (json), sender_blacklisted, sender_checks, recipient_decision_id, recipient_tier,
   recipient_score, **flagged** (= sender sanctioned or blacklisted).

## Evidence and rule

`EvidenceBundle.inbound = { flaggedCount, lastAt, sources[], windowDays, seen }` is read from `cctp_inbound` for the
subject (as recipient) inside `CCTP_WINDOW_DAYS` (30), concurrently with the other sources behind the 4 s guard
(`src/lib/evidence/collect.ts`). Rule (`src/lib/scoring/rules.ts`): `INBOUND_FLAGGED` +20 when `flaggedCount > 0`
and the last flagged mint is within 30 days. Evidence carries counts and source chains only.

## API

- `GET /api/v1/inbound?limit=50` - last inbound mints screened (public). Sender masked `0x1234…abcd`; sanctions
  side is `{ sanctioned, datasets[], blacklisted, checks }`; recipient verdict `{ decisionId, tier, score }`.
- `GET /api/v1/inbound/{address}` - the same rows for one Arc recipient.

## Env

```
CCTP_MIN_USDC=100            # screen mints ≥ this
CCTP_LOOKBACK_BLOCKS=3000    # first tick starts here behind head (~2 blocks/s)
CCTP_MAX_BLOCKS=9999         # per tick
CCTP_MAX_SCREENS=5           # fresh recipient screens per tick
CCTP_RESCREEN_HOURS=6        # reuse a recipient verdict younger than this
CCTP_MAX_LAG=50000           # skip ahead if the cursor is further behind
CCTP_SOURCE_TIMEOUT_MS=4000  # yente / source-chain RPC timeout
CCTP_WINDOW_DAYS=30          # INBOUND_FLAGGED lookback
CCTP_MESSAGE_TRANSMITTER=    # override (default Arc mainnet 0x81D4…4B64)
```

Run locally: `npx tsx --env-file=.env.local worker/cctp.ts`, or one tick:
`curl -X POST -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/internal/cctp`.
