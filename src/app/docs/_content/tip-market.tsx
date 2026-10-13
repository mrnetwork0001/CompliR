import Link from "next/link";
import { Code, Kv, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const API = `POST /api/v1/tips                 # x402 stake 0.05 USDC, settled FIRST · same-origin browser → unstaked tip (no stake)
{ "subject": "0x…", "category": "sanctions|mixer|scam|poisoning|stolen_funds|other",
  "claim": "10–2000 chars", "evidenceUrls": ["https://…"] /* ≤ 5 */, "evidenceTxs": ["0x…64hex"] /* ≤ 10 */ }
→ 201 { tip, demo, note, next }   X-CompliR-Tip-Id: tip_…

GET /api/v1/tips                  # free · { config, totals, leaderboard[10], items[50], time } · submitters anonymised as tipster-xxxxxx
GET /api/v1/tips/:id              # free · { tip }`;

const BOUNTY = `bounty = TIP_BOUNTY_USDC (0.25) × category × reputation       (6 dp)
category:   sanctions 2.0 · poisoning 1.5 · mixer, scam, stolen_funds, other 1.0
reputation: Laplace-smoothed (verified + 1) / (verified + rejected + 2) per submitter
            new 0.5 → ×0.75 · 3 verified / 0 rejected 0.8 → ×0.90 · perfect record 1.0 → ×1.00
// new sanctions tip 0.375 USDC · perfect tipster's sanctions tip 0.5 USDC · new "other" tip 0.1875 USDC
daily cap TIPS_DAILY_CAP_USDC (5): a VERIFIED tip beyond it stays VERIFIED and is paid on a later tick`;

export const tipMarket: DocPage = {
  slug: "tip-market",
  title: "Tip market",
  description: "Staked community risk intelligence: how a tip is staked over x402, verified deterministically, paid as a bounty, and fed back into verdicts.",
  lead: (
    <>
      <strong>Anyone who spots a risky address on Arc can tell CompliR, stake a few cents, and get paid in USDC the moment the tip verifies.</strong> Bad tips lose the stake.
      Verified tips become evidence (<code>COMMUNITY_TIP_VERIFIED</code>, 15 points) in every verdict issued afterwards, so the oracle buys intelligence as well as selling
      verdicts.
    </>
  ),
  sections: [
    {
      id: "stake",
      title: "The stake is the x402 payment",
      body: (
        <>
          <Code lang="http" code={API} />
          <ul>
            <li>
              <strong>Settled first.</strong> <code>POST /api/v1/tips</code> is wrapped with <code>settleFirst: true</code>: the 0.05 USDC stake settles before the tip is created,
              the payer becomes the submitter and the settle tx is <code>stakeTx</code>. If the handler then fails, x402 auto-refunds.
            </li>
            <li>
              <strong>Grace.</strong> An API tip whose stake does not show up in <code>payments</code> within 600 s (<code>TIPS_STAKE_GRACE_SECONDS</code>) is dropped: REJECTED,
              ledger <code>DROP</code>, nothing slashed.
            </li>
            <li>
              <strong>Unstaked tips.</strong> The <Link href="/tips">/tips</Link> page (same-origin) and deployments with <code>X402_DISABLED=1</code> accept unstaked tips marked{" "}
              <code>demo: true</code> / submitter <code>anonymous</code>; a verified bounty is recorded against the daily cap but nothing is sent.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "verification",
      title: "Verification matrix",
      body: (
        <>
          <p>
            Every 15 minutes (cron) or 5 minutes (<code>worker/tips.ts</code>) the tick re-screens the subject through the real pipeline (<code>clientId: tips</code>,{" "}
            <code>RESCREEN</code>, no on-chain write) and checks the evidence. No model is involved.
          </p>
          <Table
            head={["Check", "Strong", "Weak"]}
            wide={[1, 2]}
            rows={[
              ["Evidence tx hash", "receipt exists on Arc and touches the subject (from / to / log emitter / indexed topic)", "receipt exists but does not touch the subject"],
              ["Evidence URL", "host is ofac.treasury.gov, sanctionssearch.ofac.treas.gov, opensanctions.org, europa.eu, gov.uk or a subdomain", "any other http(s) URL"],
            ]}
          />
          <Table
            head={["Re-screen tier", "Corroboration", "Decision"]}
            rows={[
              ["HIGH", "any", <strong key="v1">VERIFIED</strong>],
              ["MEDIUM", "≥ 1 strong", <strong key="v2">VERIFIED</strong>],
              ["LOW", "none at all", <><strong>REJECTED</strong> → SLASHED when a stake was paid</>],
              ["anything else", "MEDIUM alone, LOW + something, re-screen failed", <strong key="r">NEEDS_REVIEW</strong>],
            ]}
          />
          <p>
            A human can settle <code>NEEDS_REVIEW</code> with <code>POST /api/internal/tips {`{ "review": "tip_…", "decision": "VERIFIED" | "REJECTED" }`}</code>. The submitter only
            ever sees tier, score, reason codes, the re-screen decision id and the corroboration result, never the evidence bundle or another client&apos;s data.
          </p>
        </>
      ),
    },
    {
      id: "bounty",
      title: "Bounty math",
      body: <Code lang="pseudo" code={BOUNTY} />,
    },
    {
      id: "payout",
      title: "Payout rails",
      body: (
        <>
          <Kv
            rows={[
              { k: "1 · circle", v: "Circle Developer-Controlled revenue wallet, transferUsdc({ role: \"revenue\" }), app-side spending policy, Gas Station-sponsored when a mainnet policy is active. Needs CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET." },
              { k: "2 · local", v: "viem ERC-20 transfer on the USDC interface from TIPS_PAYOUT_PRIVATE_KEY." },
              { k: "3 · dry-run", v: "nothing leaves the process (payoutTx null, payoutMode dry-run). The default without credentials, and the mode today." },
            ]}
          />
          <p>
            Every step is a hash-chained <code>TIP</code> entry (<code>SUBMIT</code>, <code>VERIFY</code>, <code>PAY</code>, <code>SLASH</code>, <code>REVIEW</code>,{" "}
            <code>DROP</code>) on <Link href="/ledger">/ledger</Link>, with the submitter anonymised. Public statuses: SUBMITTED → VERIFYING → VERIFIED → PAID, or REJECTED (no stake) /
            SLASHED (stake kept), or NEEDS_REVIEW. Verified tips feed <code>tipEvidenceFor(address)</code> for 180 days.
          </p>
        </>
      ),
    },
  ],
};
