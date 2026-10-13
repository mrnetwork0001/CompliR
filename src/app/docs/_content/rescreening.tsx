import Link from "next/link";
import { Code, Kv, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const WATCH = `POST /api/v1/watch                         # 0.05 USDC / 30 days via x402 · settled after the handler succeeds
{ "address": "0x…", "webhookUrl": "https://treasury.example/complir", "clientId": "treasury-7", "payeeBook": [ … ] }

→ 200  X-CompliR-Watch-Id: wat_…
{ "id": "wat_…", "address": "0x…", "webhookUrl": "…", "clientId": "treasury-7",
  "lastTier": null, "nextRescreenAt": 1760003600, "expiresAt": 1762592000, "createdAt": 1760000000 }`;

const WEBHOOK = `POST <your webhookUrl>
content-type: application/json
x-complir-event: tier.changed              # 8 s timeout; delivery is best-effort, the ledger entry is not

{
  "type": "tier.changed",
  "address": "0x…",
  "from": "LOW",                           # null on the first grade of a watch
  "to": "MEDIUM",
  "verdict": { "score": 37, "tier": "MEDIUM", "recommendedLimits": { … }, "reasons": [ … ], "rationale": "…",
               "eddRequested": [ … ], "nextRescreenAt": "…", "attestation": { … }, "decisionId": "dec_…", "screenedAt": "…" },
  "registryTx": null                       # tx hash once the registry write lands
}`;

const DRILL = `# Blacklist drill: run the exact reactor handler as if USDC had just emitted Blacklisted(addr).
# The subject is a real sanctioned wallet (Ronin Bridge exploiter, OFAC SDN + JP MOF) that USDC on Arc really blacklists,
# so the re-screen reads live chain facts - no overrides, no synthetic evidence.
curl -s -X POST http://localhost:3000/api/internal/events -H "Authorization: Bearer $CRON_SECRET" \\
  -H 'content-type: application/json' -d '{ "simulate": "0x098b716b8aaf21512996dc57eb0615e2383e2f96" }'
# The reverse event only exercises the UnBlacklisted path: the re-screen still reads the chain, so the tier
# stays HIGH until Circle really un-blacklists the address.
curl -s -X POST … -d '{ "simulate": "0x098b716b8aaf21512996dc57eb0615e2383e2f96", "kind": "UNBLOCKLISTED" }'`;

export const rescreening: DocPage = {
  slug: "rescreening",
  title: "Re-screening & webhooks",
  description: "Watches, adaptive cadence windows, the tier.changed webhook, the blocklist-event reactor and the drill that exercises it.",
  lead: (
    <>
      <strong>A grade is only as good as the day it was issued, so CompliR keeps re-grading.</strong> Watched addresses follow the cadence the analyst chose, USDC blocklist
      events trigger an immediate re-screen, and every tier change reaches your webhook with the full signed verdict.
    </>
  ),
  sections: [
    {
      id: "cadence",
      title: "Cadence windows",
      body: (
        <>
          <p>
            The analyst proposes <code>nextRescreenInSeconds</code>; code clamps it into the window for the tier. After a tier change the ceiling halves for the next cycle. The
            fallback (no model) always picks the ceiling.
          </p>
          <Table
            head={["Tier", "Min", "Max", "After a tier change"]}
            rows={[
              ["HIGH", "5 min", "1 h", "max 30 min"],
              ["MEDIUM", "15 min", "24 h", "max 12 h"],
              ["LOW", "1 h", "7 d", "max 3.5 d"],
            ]}
          />
          <p>
            Source: <code>RESCREEN_WINDOW_SECONDS</code> in <code>src/lib/analyst/guards.ts</code>.
          </p>
        </>
      ),
    },
    {
      id: "watch",
      title: "Watch an address",
      body: (
        <>
          <Code lang="http" code={WATCH} />
          <ul>
            <li>
              <strong>30 days per purchase.</strong> Re-registering the same address and client upserts the watch and extends it.
            </li>
            <li>
              <strong>Payee book travels with the watch,</strong> so lookalike and payee-change checks keep running on re-screens.
            </li>
            <li>
              <strong>Charged only after success:</strong> the handler runs first, then x402 settles; a failed registration is never charged.
            </li>
            <li>
              <strong>Schedule.</strong> The watcher runs every 10 minutes as a Vercel cron (<code>/api/internal/watcher</code>, bearer <code>CRON_SECRET</code>) or every 60 s as{" "}
              <code>worker/watcher.ts</code>. A due watch is re-screened with <code>kind: RESCREEN</code>; a failed re-screen is retried in 10 minutes and keeps the last tier.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "webhook",
      title: "The tier.changed webhook",
      body: (
        <>
          <Code lang="http" code={WEBHOOK} />
          <p>
            Before the POST, a <code>TIER_CHANGE</code> entry is appended to the ledger with <code>from</code>, <code>to</code>, <code>decisionId</code>, <code>watchId</code> and the
            trigger. Verify <code>verdict.attestation</code> exactly as you would a screen response; the <code>evidence</code> bundle is omitted from the webhook body and available
            at <code>GET /api/v1/decision/:decisionId</code>.
          </p>
        </>
      ),
    },
    {
      id: "reactor",
      title: "Blocklist-event reactor",
      body: (
        <>
          <p>
            Arc&apos;s USDC is Circle&apos;s FiatToken: <code>Blacklisted(address)</code> and <code>UnBlacklisted(address)</code> logs surface at the proxy{" "}
            <code>0x3600…0000</code> (the reactor also subscribes to <code>Blocklisted</code>/<code>UnBlocklisted</code> in case a future upgrade emits those). A tick polls new
            blocks and, for every affected address that is watched, on the Trust Map, or screened by anyone in the last 30 days (<code>EVENTS_SCREENED_DAYS</code>), runs a real
            re-screen with <code>clientId: &quot;events&quot;</code> and pushes <code>tier.changed</code> to every watch on it. Everything else is logged as ignored.
          </p>
          <Kv
            rows={[
              { k: "Schedule", v: "Vercel cron every 5 min (/api/internal/events) · worker/events.ts every 20 s (EVENTS_TICK_MS)" },
              { k: "Budget", v: "EVENTS_MAX_BLOCKS=500 per tick · EVENTS_RPC_BUDGET=12 calls · cursor only advances through contiguously fetched blocks" },
              { k: "Lag", v: "a lag above EVENTS_MAX_LAG=5000 blocks skips ahead: this is a live reactor, not an indexer; the cadence watcher is the baseline" },
              { k: "Visibility", v: <><code>GET /api/v1/network/events</code> lists the last events seen, whether a re-screen ran, tierFrom → tierTo, webhooks delivered, latency</> },
            ]}
          />
        </>
      ),
    },
    {
      id: "drill",
      title: "Simulate a blocklist event",
      body: (
        <>
          <Code lang="sh" code={DRILL} />
          <p>
            The drill runs the identical handler and is marked <code>simulated: true</code> in the event log; only the event is simulated. The re-screen reads the chain and the
            sanctions lists, so the verdict is the real one for that address. Trust Map re-grades are a third loop: recipients of 25 USDC or more are re-graded every 24 hours by the tailer. See the <Link href="/docs/trust-model">trust model</Link>{" "}
            for what these loops cannot see.
          </p>
        </>
      ),
    },
  ],
};
