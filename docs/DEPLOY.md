# Deploying CompliR (Arc mainnet)

## 0. One-time: contracts + keys (needs a funded key)
```bash
DEPLOYER_PRIVATE_KEY=0x… OWNER_ADDRESS=0x… FUND_TREASURY_USDC=50 bash scripts/go-live.sh
# restart the app, then:
node --env-file=.env.local scripts/go-live-check.mjs            # local
node --env-file=.env.local scripts/go-live-check.mjs https://your-host   # hosted
```
`go-live.sh` deploys `AttestationRegistry` + `GuardedTreasury`, verifies on Sourcify (best effort), writes
`REGISTRY_ADDRESS`, `GUARDED_TREASURY_ADDRESS`, `ATTESTER_PRIVATE_KEY`, `TREASURY_PRIVATE_KEY`, `TREASURY_MODE=live`,
`OWN_WALLETS` into `.env.local`, optionally funds the treasury. `go-live-check.mjs` performs one real screen, waits for
the registry tx, runs a treasury + watcher tick, and prints explorer links.

## 1. Database
Local dev uses `file:./.data/complir.db`. For hosting, the Vercel app and the VM workers must share one DB:
create a Turso (libsql) database and set `DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN` in both places.

## 2. App → Vercel
```bash
npm i -g vercel && vercel link && vercel env pull   # or paste .env.local values in the dashboard (never commit them)
vercel --prod
```
`vercel.json` already schedules the internal routes (watcher, trustmap, treasury, usyc, operator, events, refunds, tips, report)
with `CRON_SECRET`. Set `PUBLIC_BASE_URL=https://<your-domain>`.

## 3. Workers + yente → a small VM (2 vCPU / 4 GB / 40 GB)
```bash
git clone … && cd complir && cp .env.local.example .env.local   # paste the same env as Vercel
docker compose -f docker-compose.prod.yml --env-file .env.local up -d
docker compose -f docker-compose.prod.yml logs -f workers
```
yente needs ~10 min to index the sanctions scope on first start. Workers run all loops in one process (`worker/all.ts`).
If you only have Vercel, the cron routes cover everything except sub-minute event reaction and continuous map tailing.

## 4. Circle (x402 revenue, wallets, gas sponsorship)
See `docs/CIRCLE_WALLETS.md`: API key → entity secret → `scripts/circle/setup.ts` → Gas Station policy for ARC →
`SIGNER_MODE=circle`, `X402_PAY_TO=<revenue wallet>`, `X402_DISABLED=0`. Make one real 0.01 USDC call with the SDK.

## 5. LLM
`ANTHROPIC_API_KEY` or the 0G Compute provider (`docs/LLM_PROVIDERS.md`). Without either, rationales use the deterministic fallback.

## 6. Checklist before the submission form
- [ ] `go-live-check.mjs` passes against the hosted URL (registry tx link printed)
- [ ] `/numbers` shows outside payers > 0 (own wallets listed in `OWN_WALLETS`)
- [ ] `/report` published for today, signature verifies
- [ ] `/company` shows a non-fallback operator decision
- [ ] README links: live URL, registry + treasury explorer links, video
