# Public risk dataset (`/stats`, `/api/v1/stats`)

One signed row per UTC day, computed from CompliR's own tables and nothing else. Open data for analysts who want a
daily pulse of counterparty risk on Arc as seen by one oracle. Free, no key.

**Sample, not census.** The row describes what the CompliR tailer observed in its block windows (USDC `Transfer`
logs around graded wallets and their counterparties) plus what clients asked us to screen. It is not all of Arc,
and quiet tailer ticks are not counted. Read `caveats` before citing a number.

## Routes

| Route | Returns |
|---|---|
| `GET /api/v1/stats` | `{ signer, count, headline, days: [...], csv }` - last 30 days, newest first (`?days=1..365`, `?format=csv`) |
| `GET /api/v1/stats/<YYYY-MM-DD>.json` (or no suffix) | `{ date, final, hash, signature, signer, createdAt, headline, stats }` |
| `GET /api/v1/stats/<YYYY-MM-DD>.csv` | that day as CSV (header + 1 row) |
| `GET /api/v1/stats/latest.json` / `latest.csv` | newest row / every stored day (up to 365) as CSV |
| `GET\|POST /api/internal/stats` | cron (`CRON_SECRET`), 00:10 UTC: computes today, and closes yesterday if its row is not final yet. `?date=YYYY-MM-DD\|today\|yesterday`, `&force=1` |
| `/stats` | the page: headline, 30-day strip, tier mix, reason codes, downloads, signature, caveats |

A day is recomputed (and re-signed) on every run until the UTC day ends; after that the stored row is kept unless
`force=1`.

## Row schema (`stats`, version 1)

```jsonc
{
  "version": 1, "generator": "complir-stats", "date": "2026-10-13",
  "period": { "from": "2026-10-13T00:00:00.000Z", "to": "2026-10-14T00:00:00.000Z", "final": false },
  "generatedAt": "…", "chain": { "chainId": 5042, "explorerUrl": "…", "usdc": "0x3600…" }, "signer": "0xc742…",
  "graded":  { "addresses": 16, "screenings": 32, "byTier": { "LOW": 14, "MEDIUM": 1, "HIGH": 1 }, "share": { "LOW": 0.875, "MEDIUM": 0.0625, "HIGH": 0.0625 } },
  "observed": { "wallets": 155, "candidatesNow": 145, "nodesNow": 10 },
  "volume":  { "usdc": 194466.07, "edges": 25, "flaggedUsdc": 0, "flaggedShare": 0, "flaggedEdges": 0, "flaggedWalletsNow": 1 },
  "tierChanges": { "total": 1, "map": 0, "watch": 1, "up": 0, "down": 0 },
  "reasons": [ { "code": "NO_HISTORY", "count": 15, "share": 0.4688 }, … ],           // top 12
  "bridged": { "available": false, "table": null, "transfers": 0, "usdc": 0, "flaggedUsdc": 0, "flaggedShare": 0 },
  "clients": { "outside": 3, "internal": 23, "unknown": 6, "distinctClientIds": 7, "outsidePayers": 0 },
  "tailer":  { "ticks": 2, "lastTickAt": "…", "cursorBlock": 25818533, "blocksScanned": 200 },
  "side":    { "tips": 2, "tipsVerified": 2, "payouts": 2, "payoutsHeld": 1, "paidCalls": 0, "usdcPaid": 0 },
  "caveats": [ "…" ]
}
```

| Field | Source | Definition |
|---|---|---|
| `graded.addresses` | `screenings` | distinct addresses screened that day; `byTier` uses the **last** screening of each address that day; `share` = byTier / addresses |
| `graded.screenings` | `screenings` | rows that day (every `/api/v1/screen`, watcher re-screen, map grade) |
| `observed.wallets` | `trustmap_candidates.last_seen_at`, `trustmap_nodes.last_graded_at`, edge endpoints | distinct wallets the tailer touched that day |
| `observed.candidatesNow` / `nodesNow` | `trustmap_candidates`, `trustmap_nodes` | table sizes at computation time (not per day) |
| `volume.usdc` / `edges` | `trustmap_edges.created_at` | USDC on Transfer edges persisted that day (graded nodes and their counterparties, in the tailer's windows) |
| `volume.flaggedUsdc` / `flaggedShare` / `flaggedEdges` | edges × flagged set | an edge is flagged when either end is in the flagged set; share = flaggedUsdc / usdc |
| flagged set | `trustmap_nodes`, that day's `screenings` | tier `HIGH`, or a reason code in `SANCTIONS_DIRECT`, `USDC_BLACKLISTED`, `PROTOCOL_BLOCKLISTED` - evaluated at computation time (`flaggedWalletsNow`) |
| `tierChanges.map` / `watch` | `trustmap_tier_changes.at`, `decisions(kind=TIER_CHANGE)` | regrades on the map / on watched addresses; `up` = to a stricter tier |
| `reasons` | `screenings.reason_codes` | code counts over that day's screenings (one screening can carry several), `share` = count / screenings |
| `bridged.*` | `cctp_inbound` **if the table exists** | inbound bridged USDC and the share minted to a flagged recipient; `available=false` and zeros otherwise |
| `clients.outside` / `internal` / `unknown` | `screenings.payer`, `client_id` | internal = our own UI/workers (`INTERNAL_CLIENT_IDS`) or own wallets; `outsidePayers` = distinct x402 payers that are not ours |
| `tailer.ticks` | `trustmap_inflow.at`, `trustmap_edges.created_at`, `trustmap_meta.last_tick` | distinct tick timestamps that wrote rows that day (quiet ticks are invisible) |
| `side.*` | `tips`, `treasury_invoices`, `payments` | community tips submitted / verified, treasury payouts decided / held, outside paid calls and USDC |

Shares are rounded to 4 decimals, USDC to 6.

## CSV

`/api/v1/stats/latest.csv` is flat, one row per day, newest first, CRLF, RFC 4180 quoting. Columns (47), in
order: `date, final, graded_addresses, screenings, tier_low, tier_medium, tier_high, share_low, share_medium,
share_high, observed_wallets, candidates_now, nodes_now, volume_usdc, volume_edges, flagged_usdc, flagged_share,
flagged_edges, flagged_wallets_now, tier_changes, tier_changes_map, tier_changes_watch, tier_up, tier_down,
top_reasons, bridged_available, bridged_transfers, bridged_usdc, bridged_flagged_usdc, bridged_flagged_share,
clients_outside, clients_internal, clients_unknown, distinct_client_ids, outside_payers, tailer_ticks,
tailer_last_tick_at, cursor_block, tips, tips_verified, payouts, payouts_held, paid_calls, usdc_paid, hash,
signature, signer`. Booleans are `1`/`0`; `top_reasons` is `CODE:count;CODE:count;…`.

## Signature

Same scheme as the daily report (`src/lib/reports`): `hash = keccak256(utf8(canonical(stats)))` where canonical
JSON has recursively sorted keys and no whitespace; `signature` is EIP-191 `personal_sign` by the attester over the
hash string. `hash`, `signature`, `signer` and `createdAt` live beside `stats`, never inside it.

```ts
import { keccak256, stringToHex, verifyMessage } from "viem";
const r = await (await fetch("https://<host>/api/v1/stats/2026-10-13.json")).json();
const canon = (v) => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  : JSON.stringify(v);
const hash = keccak256(stringToHex(canon(r.stats)));            // === r.hash
await verifyMessage({ address: r.signer, message: hash, signature: r.signature }); // true
```

Storage: `stats_daily (date PK, json, hash, signature, signer, created_at)`, created by `src/lib/stats/compute.ts`.

## Monthly rollup

`src/lib/reports/monthly.ts` folds the daily reports and these rows into one signed transparency document per
month: `GET /api/v1/report/monthly/<YYYY-MM>(.md)`, `/report?period=month`, published by
`POST /api/internal/report?period=month` (and automatically on the first daily run after a month ends). Tailer
uptime in that document = days with `tailer.ticks > 0` over days elapsed.
