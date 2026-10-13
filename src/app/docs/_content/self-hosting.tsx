import Link from "next/link";
import { Code, Kv, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const RUN = `cp .env.example .env.local                               # Arc mainnet 5042 values are active; X402_DISABLED=1 for dev
docker compose -f docker/yente/docker-compose.yml up -d   # OpenSanctions matcher (optional; degrades gracefully)
npm install && npm run dev                               # http://localhost:3000

npm test · npm run typecheck · npm run lint · npm run build · cd contracts && forge test`;

const CRONS = `// vercel.json — each path is POST|GET /api/internal/<worker> with Authorization: Bearer $CRON_SECRET
{ "crons": [
  { "path": "/api/internal/watcher",  "schedule": "*/10 * * * *" },
  { "path": "/api/internal/trustmap", "schedule": "*/5 * * * *"  },
  { "path": "/api/internal/treasury", "schedule": "*/15 * * * *" },
  { "path": "/api/internal/usyc",     "schedule": "0 * * * *"    },
  { "path": "/api/internal/operator", "schedule": "30 * * * *"   },
  { "path": "/api/internal/events",   "schedule": "*/5 * * * *"  },
  { "path": "/api/internal/refunds",  "schedule": "*/10 * * * *" },
  { "path": "/api/internal/tips",     "schedule": "*/15 * * * *" },
  { "path": "/api/internal/report",   "schedule": "5 0 * * *"    }
] }`;

const WORKERS = `# Long-running alternative to crons (Railway / Fly / a VM). Each loop calls the same function as its route.
npx tsx --env-file=.env.local worker/watcher.ts     # every 60 s: due re-screens, webhooks, anchor-if-due
npx tsx --env-file=.env.local worker/trustmap.ts    # tail Arc, grade recipients
npx tsx --env-file=.env.local worker/events.ts      # blocklist reactor, EVENTS_TICK_MS = 20 s
npx tsx --env-file=.env.local worker/treasury.ts    # guarded payouts
npx tsx --env-file=.env.local worker/operator.ts    # operator ticks on its own nextCheck interval
npx tsx --env-file=.env.local worker/tips.ts        # verify + pay tips, 5 min
npx tsx --env-file=.env.local worker/usyc.ts        # hourly sweep plan
npx tsx --env-file=.env.local worker/report.ts      # 00:05 UTC report, back-fills on start, drains refunds every 5 min`;

const YENTE = `docker compose -f docker/yente/docker-compose.yml up -d     # yente 5.5.0 + single-node Elasticsearch 9.4.2, 2 GB heap
curl -s http://localhost:8000/healthz                       # first start downloads + indexes the sanctions collection (~5–10 min)
curl -s http://localhost:8000/catalog | head -c 600
# refresh: curl -X POST "http://localhost:8000/updatez?token=$YENTE_UPDATE_TOKEN&sync=true"   (yente also polls hourly)`;

export const selfHosting: DocPage = {
  slug: "self-hosting",
  title: "Self-hosting & deployment",
  description: "Run CompliR yourself: the env reference grouped by concern, Vercel crons versus long-running workers, and the yente sanctions container.",
  lead: (
    <>
      <strong>CompliR is one Next.js app, one SQLite/libSQL database, nine background loops and an optional sanctions container.</strong> Everything is env-driven; nothing is
      hard-coded. Without keys every external loop reports dry-run and the app still answers verdicts.
    </>
  ),
  sections: [
    {
      id: "run",
      title: "Run locally",
      body: (
        <>
          <Code lang="sh" code={RUN} />
          <p>
            Without <code>ATTESTER_PRIVATE_KEY</code> the process generates an ephemeral attester key at start (signatures still verify, but change on restart). Without{" "}
            <code>ANTHROPIC_API_KEY</code> the analyst and operator run their deterministic fallbacks. Without yente, sanctions lookups contribute their neutral value.
          </p>
        </>
      ),
    },
    {
      id: "env",
      title: "Environment reference",
      body: (
        <>
          <h3>Network</h3>
          <Kv
            mono
            rows={[
              { k: "ARC_CHAIN_ID", v: "5042 (mainnet) · 5042002 (testnet)" },
              { k: "ARC_RPC_URL", v: "https://rpc.mainnet.arc.io (public, no key; eth_getLogs ≤ 10,000 blocks / 2,000 results per query)" },
              { k: "ARC_EXPLORER_URL", v: "https://explorer.arc.io" },
              { k: "ARC_BLOCKSCOUT_API", v: "optional; the explorer API sits behind a Cloudflare challenge for non-browser clients, leave empty → RPC fallback" },
              { k: "USDC_ADDRESS", v: "0x3600000000000000000000000000000000000000 (both networks)" },
              { k: "REGISTRY_ADDRESS", v: "AttestationRegistry; empty until deployed" },
              { k: "PROTOCOL_BLOCKLIST_ADDRESS", v: "empty; no protocol-level blocklist contract is documented" },
            ]}
          />
          <h3>Evidence tunables (optional)</h3>
          <Kv
            mono
            rows={[
              { k: "ARC_USDC_EMITTER / _DECIMALS", v: "system emitter 0xffff…fffE at 18 dp (default); tracing the ERC-20 address would miss native sends" },
              { k: "EVIDENCE_LOOKBACK_BLOCKS", v: "50000 (≈ 7 h of history per traced wallet at ~2 blocks/s)" },
              { k: "EVIDENCE_GETLOGS_CHUNK", v: "9999 (public RPC hard cap is 10,000)" },
              { k: "EVIDENCE_SOURCE_TIMEOUT_MS", v: "4000 per source" },
              { k: "YENTE_URL / YENTE_DATASET / YENTE_THRESHOLD", v: "http://localhost:8000 · default · 0.7" },
              { k: "OVERRIDES_PATH / OVERRIDES_JSON", v: ".data/overrides.json — demo overrides on our own wallets; never a real sanctioned address" },
            ]}
          />
          <h3>Keys and data</h3>
          <Kv
            mono
            rows={[
              { k: "ATTESTER_PRIVATE_KEY", v: "signs EIP-712 attestations and daily reports; sends registry writes in local signer mode" },
              { k: "ANTHROPIC_API_KEY / ANALYST_MODEL", v: "Risk Analyst + operator; default model claude-sonnet-5-5" },
              { k: "DATABASE_URL / DATABASE_AUTH_TOKEN", v: "file:./.data/complir.db (libSQL; a Turso URL + token for hosted)" },
            ]}
          />
          <h3>Payments (x402)</h3>
          <Kv
            mono
            rows={[
              { k: "X402_DISABLED", v: "1 = free; 0 = charge" },
              { k: "X402_NETWORK / X402_PAY_TO", v: "CAIP-2 (defaults to eip155:$ARC_CHAIN_ID) · revenue address" },
              { k: "X402_FACILITATOR_URL", v: "https://api.circle.com/v1/facilitator/x402" },
              { k: "X402_FACILITATOR_API_KEY | X402_SELLER_PRIVATE_KEY", v: "exactly one: Circle Console key, or a seller proof signed by the payTo key" },
              { k: "X402_ASSET_NAME / _VERSION / X402_PENDING_POLLS", v: "USDC / 2 / 3" },
              { k: "PRICE_SCREEN_USDC / PRICE_WATCH_USDC", v: "0.01 / 0.05" },
            ]}
          />
          <h3>Ops</h3>
          <Kv
            mono
            rows={[
              { k: "COMPLIR_PAUSED", v: "1 = kill switch: screens answer 503 SERVICE_PAUSED, operator holds" },
              { k: "ANCHOR_EVERY_N", v: "50 ledger entries per Merkle anchor" },
              { k: "PUBLIC_BASE_URL", v: "absolute URL used in x402 resources, EDD links, badges and ERC-8004 metadata" },
              { k: "OWN_WALLETS", v: "comma-separated; excluded from /numbers and listed in every report" },
              { k: "CRON_SECRET", v: "bearer for every /api/internal/* route" },
            ]}
          />
          <h3>Loops</h3>
          <Kv
            mono
            rows={[
              { k: "TREASURY_*", v: "MODE (live), PRIVATE_KEY, GUARDED_TREASURY_ADDRESS, MAX_TIER (MEDIUM), PER_PAYOUT_CAP_USDC (25), DAILY_CAP_USDC (50), REQUIRE_ONCHAIN" },
              { k: "TRUSTMAP_*", v: "MIN_USDC (25), REGRADE_HOURS (24), MAX_PER_TICK (5), SEED_DEMO (1)" },
              { k: "USYC_*", v: "MODE (dry), FLOAT_USDC (5), MIN_SWEEP_USDC (1); REVENUE_WALLET / REVENUE_PRIVATE_KEY; USYC_ADDRESS / TELLER / ENTITLEMENTS default to Arc mainnet" },
              { k: "EVENTS_*", v: "TICK_MS (20000), MAX_BLOCKS (500), MAX_LAG (5000), RPC_BUDGET (12), SCREENED_DAYS (30)" },
              { k: "NETWORK_*", v: "WINDOW_DAYS (7), MIN_CONCENTRATION (3)" },
              { k: "OPERATOR_*", v: "RAISE_CALLS_24H (50), MAX_P95_MS (8000)" },
              { k: "REFUND_*", v: "PRIVATE_KEY, DAILY_CAP_USDC (5), MAX_ATTEMPTS (3), AUTO_PROCESS (1)" },
              { k: "TIPS_* / TIP_BOUNTY_USDC", v: "STAKE_USDC (0.05), BOUNTY 0.25, DAILY_CAP_USDC (5), PAYOUT_PRIVATE_KEY, STAKE_GRACE_SECONDS (600)" },
              { k: "REPORT_NOTES_PATH / REPORT_INTEGRATIONS_DIR", v: ".data/report-notes.json · docs/integrations" },
            ]}
          />
          <h3>Circle and identity</h3>
          <Kv
            mono
            rows={[
              { k: "SIGNER_MODE", v: "local | circle (circle relays attest() through the ops wallet; falls back to local)" },
              { k: "CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET", v: "both required for anything but dry-run" },
              { k: "CIRCLE_WALLET_SET_ID / _NAME / ACCOUNT_TYPE / FEE_LEVEL / TX_TIMEOUT_MS", v: "complir · SCA (Gas Station-sponsorable) · MEDIUM · 120000" },
              { k: "CIRCLE_OPS_POLICY_* / CIRCLE_REVENUE_POLICY_*", v: "app-enforced per-tx / daily caps and allowlists: ops 1 / 10 USDC, revenue 25 / 100 USDC" },
              { k: "ERC8004_IDENTITY_REGISTRY / _OWNER_PRIVATE_KEY / _AGENT_ID", v: "0x8004A169… on Arc mainnet · falls back to the attester key · set after registration" },
            ]}
          />
          <p>
            The full file with comments is <code>.env.example</code>; <code>src/lib/config.ts</code> validates the core set with zod and treats blank values as unset.
          </p>
        </>
      ),
    },
    {
      id: "vercel",
      title: "Vercel and crons",
      body: (
        <>
          <p>
            The app deploys as a standard Next.js project. Background work runs as Vercel crons that hit the internal routes with <code>CRON_SECRET</code>; the Vercel cron
            schedule is the floor, and each route runs exactly one tick.
          </p>
          <Code lang="json" code={CRONS} />
          <Table
            head={["Loop", "Cron", "Worker", "What one tick does"]}
            wide={[3]}
            rows={[
              ["watcher", "10 min", "60 s", "re-screen due watches, push tier.changed, anchor the ledger when ANCHOR_EVERY_N is reached"],
              ["trustmap", "5 min", "loop", "tail new blocks, grade ≤ 5 recipients ≥ 25 USDC, re-grade after 24 h"],
              ["events", "5 min", "20 s", "poll USDC Blacklisted / UnBlacklisted logs, re-screen affected addresses, webhooks"],
              ["treasury", "15 min", "loop", "screen + decide + (dry-run or live) release pending invoices"],
              ["operator", "hourly :30", "own interval", "snapshot → candidates → model → execute → one OPERATOR entry"],
              ["tips", "15 min", "5 min", "verify submitted tips, pay bounties, drop stale stakes"],
              ["refunds", "10 min", "via report worker", "send queued refunds up to the daily cap"],
              ["usyc", "hourly", "hourly", "plan DEPOSIT / REDEEM / NONE, log a NOOP · USYC_SWEEP entry, execute only when live"],
              ["report", "00:05 UTC", "00:05 UTC", "generate, hash, sign and ledger the previous day"],
            ]}
          />
          <Code lang="sh" code={WORKERS} />
          <p>
            Hosting is pending; the local database is a file, so a hosted deployment needs a libSQL URL (<code>DATABASE_URL</code> + <code>DATABASE_AUTH_TOKEN</code>) that every
            cron invocation can reach.
          </p>
        </>
      ),
    },
    {
      id: "yente",
      title: "yente (OpenSanctions)",
      body: (
        <>
          <Code lang="sh" code={YENTE} />
          <p>
            <code>docker/yente/manifest.yml</code> indexes only the <strong>sanctions</strong> collection so the first build is small; switch to <code>scope: default</code> and a
            4 GB heap for PEPs and the rest. CompliR queries <code>/match/{"{dataset}"}</code> with <code>CryptoWallet.publicKey</code> for every subject and funder and a name query
            when a name was supplied; a result counts when <code>match</code> is true or the score reaches <code>YENTE_THRESHOLD</code>. The public catalog is CC BY-NC 4.0; commercial
            use needs an OpenSanctions delivery token. The <Link href="/docs/mainnet-checklist">mainnet checklist</Link> covers what to flip after the app is up.
          </p>
        </>
      ),
    },
  ],
};
