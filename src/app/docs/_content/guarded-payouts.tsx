import Link from "next/link";
import { Code, Kv, Status, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const DECIDE = `// src/lib/treasury/policy.ts - pure; the agent proposes, the policy decides, the contract re-checks on-chain.
HIGH, or any tier above policy.maxTier          → HOLD everything                          (bound: tier)
signed attestation expired                       → HOLD, re-screen required                 (bound: attestation_expired)
live mode: registry has no valid entry           → HOLD, release would revert               (bound: attestation_missing)
else pay = min(amount, analyst maxPerTx, per-payout cap 25, daily headroom 50 − spent today)
     pay == amount → PAY · 0 < pay < amount → LIMIT (rest held) · pay == 0 → HOLD`;

const RELEASE = `// contracts/src/examples/GuardedTreasury.sol - the integration is the require.
function release(address payee, uint256 amount) external onlyOwner {
    require(compliR.isAllowed(payee, maxTier), "CompliR: payee tier too high");
    (,, bytes32 decisionHash) = compliR.tierOf(payee);
    token.safeTransfer(payee, amount);
    emit Released(payee, amount, decisionHash);
}`;

const LIVE_ENV = `REGISTRY_ADDRESS=<AttestationRegistry on Arc mainnet>
ATTESTER_PRIVATE_KEY=<CompliR attester key>        # verdicts are mirrored on-chain before release
GUARDED_TREASURY_ADDRESS=<GuardedTreasury>
TREASURY_PRIVATE_KEY=<owner key; the only account allowed to call release>
TREASURY_MODE=live
TREASURY_MAX_TIER=MEDIUM                            # optional overrides (defaults MEDIUM / 25 / 50)
TREASURY_PER_PAYOUT_CAP_USDC=25
TREASURY_DAILY_CAP_USDC=50
TREASURY_REQUIRE_ONCHAIN=1                          # default in live mode
CRON_SECRET=<random>                                # protects /api/internal/treasury`;

export const guardedPayouts: DocPage = {
  slug: "guarded-payouts",
  title: "Guarded payouts",
  description: "The treasury agent that pays invoices through GuardedTreasury: policy, PAY / LIMIT / HOLD, dry-run versus live, and the steps to go live.",
  lead: (
    <>
      <strong>Guarded Payouts is a treasury agent that cannot pay a payee its own oracle did not clear.</strong> Every invoice is screened, a pure policy decides PAY, LIMIT or
      HOLD, and on-chain <code>GuardedTreasury.release</code> re-checks <code>isAllowed</code> so a wrong agent still cannot move USDC to a HIGH address.
    </>
  ),
  intro: (
    <p>
      Status today: <Status kind="live">live on Arc mainnet</Status> - <code>GuardedTreasury</code> at <code>0x5465f31a6155E3eCCcC35f4E5bDC0e287763B0ee</code> (verified). First live tick: PAID 10 USDC (<a href="https://explorer.arc.io/tx/0x83732d7451aca960b7c446d099e6bc9a521b81a8e2f0fd231457bf9add7af930" target="_blank" rel="noopener noreferrer">tx</a>), LIMITED to the 10 USDC cap (<a href="https://explorer.arc.io/tx/0xeb2a6ba05f058a2e3a7c4ab6958f5e665b35be0f876251173ac8c59b4072a34c" target="_blank" rel="noopener noreferrer">tx</a>), HELD for a sanctioned payee (no tx). The page is{" "}
      <Link href="/payouts">/payouts</Link>.
    </p>
  ),
  sections: [
    {
      id: "policy",
      title: "Policy",
      body: (
        <>
          <Kv
            rows={[
              { k: "maxTier", v: "MEDIUM - mirrors GuardedTreasury.maxTier; HIGH is never paid, LOW-only is one setMaxTier away" },
              { k: "Per payout", v: "25 USDC (TREASURY_PER_PAYOUT_CAP_USDC)" },
              { k: "Per day", v: "50 USDC (TREASURY_DAILY_CAP_USDC), rolling from the payouts recorded today" },
              { k: "requireAttestationOnChain", v: "true in live mode by default: the registry must hold a valid, non-expired entry at or below maxTier, which is exactly what release reads" },
              { k: "Payee book", v: "every payee paid before is trusted; a new address that merely resembles one is a lookalike and the verdict says so" },
            ]}
          />
          <Code lang="pseudo" code={DECIDE} />
          <p>
            The smallest cap wins and names itself in the reason (<code>bound</code>): <code>analyst_max_per_tx</code>, <code>per_payout_cap</code> or <code>daily_cap</code>. Every
            reason ends with the analyst&apos;s rationale, so the payouts page explains itself.
          </p>
        </>
      ),
    },
    {
      id: "tick",
      title: "One tick",
      body: (
        <>
          <ol>
            <li>
              Load pending invoices (nothing is seeded; invoices come from /payouts or the API, oldest first).
            </li>
            <li>
              Screen the payee with <code>clientId: treasury-agent</code> and the trusted payee book; the screen does not write on-chain by itself.
            </li>
            <li>
              Live only: mirror the attestation to the registry and wait for it, then read <code>tierOf(payee)</code> back.
            </li>
            <li>
              <code>decidePayout()</code> → PAY / LIMIT / HOLD with the amount, the held remainder and the bound.
            </li>
            <li>
              Execute: dry-run returns <code>null</code>; live simulates <code>release</code> (a HIGH payee reverts with <code>CompliR: payee tier too high</code> before gas is
              spent), sends it, waits for the receipt (Arc finality is deterministic) and records the tx hash.
            </li>
            <li>
              Append a <code>PAYOUT</code> ledger entry and settle the invoice (<code>PAID</code>, <code>LIMITED</code> with the rest re-queued, or <code>HELD</code>).
            </li>
          </ol>
          <Table
            head={["Outcome", "Means", "Example"]}
            wide={[1, 2]}
            rows={[
              [<strong key="p">PAID</strong>, "full amount released", "10 USDC to a LOW payee under every cap"],
              [<strong key="l">LIMITED</strong>, "part released, remainder held and re-queued", "120 USDC invoice, LOW payee → 25 USDC (per-payout cap), 95 held"],
              [<strong key="h">HELD</strong>, "nothing released; reason names the bound", "unknown vendor graded HIGH → held by tier"],
            ]}
          />
        </>
      ),
    },
    {
      id: "contract",
      title: "The contract",
      body: (
        <>
          <Code lang="solidity" code={RELEASE} />
          <p>
            <code>Ownable</code>: only the treasury agent&apos;s key can call <code>release</code>; <code>setMaxTier</code> tightens or loosens the policy (UNKNOWN never pays);{" "}
            <code>withdraw</code> pulls funds back any time. CompliR never holds this float. See <Link href="/docs/solidity">Solidity</Link> for the full example.
          </p>
        </>
      ),
    },
    {
      id: "go-live",
      title: "Dry-run → live",
      body: (
        <>
          <p>
            Mode is decided by env alone: live needs all four of <code>TREASURY_MODE=live</code>, <code>TREASURY_PRIVATE_KEY</code>, <code>GUARDED_TREASURY_ADDRESS</code> and{" "}
            <code>REGISTRY_ADDRESS</code>; <code>GET /api/v1/payouts</code> lists what is still missing in <code>missingForLive</code>.
          </p>
          <ol>
            <li>
              Deploy <code>AttestationRegistry</code> on Arc mainnet (5042), then <code>GuardedTreasury</code> with <code>OWNER_ADDRESS</code> = the treasury agent key and{" "}
              <code>TOKEN_ADDRESS = 0x3600…0000</code> (<code>contracts/README.md</code>). Gas is USDC.
            </li>
            <li>
              Fund the treasury with at most 50 USDC via a plain ERC-20 transfer (covers the demo: 10 paid + 25 limited) and give the agent key a little USDC for gas (
              <code>release</code> ≈ 60k gas).
            </li>
            <li>Set the env below and redeploy.</li>
            <li>
              The next tick (<code>worker/treasury.ts</code>, the cron every 15 min, or &quot;Run agent now&quot; on the page) runs live. Remove <code>TREASURY_MODE=live</code> to
              return to dry-run.
            </li>
          </ol>
          <Code lang="env" code={LIVE_ENV} />
        </>
      ),
    },
  ],
};
