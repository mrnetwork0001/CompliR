import Link from "next/link";
import { Code, Kv, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const ENTRY = `// kind: "OPERATOR" - one per tick, hash-chained like every other decision
{
  "type": "OPERATOR",
  "snapshot":   { "revenue": { … }, "reserves": { … }, "obligations": { … }, "screening": { … }, "pricing": { … }, "mode": { … }, "errors": { … } },
  "candidates": [{ "id": "c1", "type": "RUN_PAYOUTS", "params": { "pendingInvoices": 2, "amountUsdc": 35 }, "reason": "…" }, { "id": "c2", "type": "HOLD", … }],
  "rejected":   [{ "type": "SWEEP_TO_YIELD", "reason": "balance 2.02 below float 5 but no vault to redeem (effective float 5 = 5 cushion + 0 due 48 h)" }, { "type": "ADJUST_PRICE", "reason": "x402 disabled …" }],
  "chosen":     [{ "id": "c1", "type": "RUN_PAYOUTS", "ok": true, "result": { "mode": "dry-run", "paid": 1, "limited": 1, "held": 0, … } }],
  "rationale":  "…plain English, ≤ 160 words, cites the numbers in the snapshot…",
  "nextCheckInSeconds": 1800, "nextCheckAt": 1760001800,
  "meta": { "model": "0g:claude-opus-4-8", "fallback": false, "latencyMs": 2140, "guardNotes": [], "paused": false, "chainId": 5042 }
}`;

export const operator: DocPage = {
  slug: "operator",
  title: "The operator",
  description: "How the agent runs the company: snapshot, deterministic candidates, guard-railed choice, one signed OPERATOR entry per tick, and the pricing rails.",
  lead: (
    <>
      <strong>The company is run by an agent that can only choose among actions code has already allowed.</strong> Every tick it reads a snapshot of the books, code enumerates
      the candidate actions and why the rest are not allowed, the model picks and explains, code re-checks right before executing, and one signed ledger entry records all of
      it.
    </>
  ),
  sections: [
    {
      id: "tick",
      title: "Snapshot → candidates → guards → one entry",
      body: (
        <>
          <ol>
            <li>
              <strong>Snapshot.</strong> <code>companySnapshot()</code> reads revenue (the <code>payments</code> table), reserves (revenue wallet USDC and Circle Earn vault positions on Arc, Circle
              wallets), obligations (treasury invoices and daily headroom), screening volume and p95 latency, current prices and modes. Every section degrades to{" "}
              <code>null</code> with an error string; the function never throws.
            </li>
            <li>
              <strong>Candidates.</strong> <code>candidateActions()</code> is deterministic. It lists what is allowed now with a reason, and lists every rejected action with its
              reason. <code>HOLD</code> is always a candidate.
            </li>
            <li>
              <strong>Choice.</strong> The model (same client as the analyst) must call <code>submit_plan</code> with candidate ids, a rationale and the next check interval.
              Unknown ids are dropped, <code>HOLD</code> is never mixed with actions, an empty choice falls back to the deterministic plan, the interval is clamped to 15 min–6 h,
              the rationale is cut at 160 words. Without an LLM provider (<code>LLM_PROVIDER=0g</code> + <code>ZEROG_API_KEY</code>, or <code>ANTHROPIC_API_KEY</code>) the deterministic plan runs with <code>meta.fallback = true</code>.
            </li>
            <li>
              <strong>Execution.</strong> In the order payouts → prices → liquidity, <code>validateAction()</code> re-derives the candidates and rejects anything no longer allowed,
              then each executor honours its own mode (dry-run or live).
            </li>
            <li>
              <strong>Record.</strong> One <code>OPERATOR</code> entry with the snapshot summary, candidates, rejected, chosen with results, rationale and <code>nextCheckAt</code>.
              The <Link href="/company">company page</Link> renders the last ten.
            </li>
          </ol>
          <Code lang="json" code={ENTRY} />
        </>
      ),
    },
    {
      id: "actions",
      title: "What it may decide",
      body: (
        <>
          <Table
            head={["Action", "Allowed when", "Executor"]}
            wide={[1, 2]}
            rows={[
              [<code key="a">SWEEP_TO_YIELD</code>, "float and obligations are both known, usdc − (YIELD_FLOAT_USDC + obligations due in 48 h) ≥ min sweep (1 USDC), and a Circle Earn vault passes the rules (params carry the vault)", "Circle Earn tick from the Circle revenue wallet (dry-run unless YIELD_MODE=live)"],
              [<code key="b">REDEEM_FROM_YIELD</code>, "usdc is below the effective float, a vault position is held, and that vault has the liquidity to pay it", "same"],
              [<code key="c">RUN_PAYOUTS</code>, "pending invoices exist, daily cap has headroom, and a live treasury is not at zero reserves", "Guarded Payouts tick (dry-run until TREASURY_MODE=live)"],
              [<code key="d">ADJUST_PRICE</code>, "x402 is enabled; raise when paid calls in 24 h > 50 and p95 ≤ 8 s, lower when outside paid calls in 48 h = 0; inside bounds, step and cooldown", "operator_pricing table, read per request by the paid routes"],
              [<code key="e">HOLD</code>, "always", "no-op"],
            ]}
          />
          <p>
            A sweep is never planned blind: unknown reserves, unknown obligations or missing Earn vault metadata reject it. A paused service (<code>COMPLIR_PAUSED=1</code>) rejects
            everything but HOLD. Ledger entries written before 2026-10-14 call these actions <code>SWEEP_TO_USYC</code> / <code>REDEEM_FROM_USYC</code>.
          </p>
        </>
      ),
    },
    {
      id: "yield",
      title: "Where idle revenue goes",
      body: (
        <>
          <p>
            The yield backend is Circle Earn: Morpho USDC vaults on Arc, discovered through Circle&apos;s Earn API (the service behind <code>@circle-fin/earn-kit</code>) and used as
            plain ERC-4626 from the Circle revenue wallet (<code>USDC.approve</code> → <code>vault.deposit(assets, wallet)</code>; <code>vault.redeem(shares, wallet, wallet)</code>).
          </p>
          <Table
            head={["Rule", "Why"]}
            wide={[1]}
            rows={[
              ["refuse vaults Circle flags low_liquidity", "the revenue has to come back on demand; Circle's illiquid flag is the first gate"],
              ["available liquidity ≥ 2× (deposit + position)", "we could redeem the whole position twice over right now"],
              ["no RED warning, not unlisted, Circle Sentinel, TVL ≥ 100k, APY > 0", "skip timelock-less test vaults and unreviewed curators"],
              ["best current APY among the rest", "today: Steakhouse Prime USDC 0xbeef0016…7298"],
              ["float = YIELD_FLOAT_USDC (5) + obligations due 48 h; ≤ 25 USDC per deposit", "payouts and refunds never wait on a redeem; stays under the wallet's per-tx policy"],
            ]}
          />
          <p>
            Each executed move is its own ledger entry (<code>OPERATOR · YIELD_SWEEP</code> / <code>YIELD_REDEEM</code> with tx hashes); a plan that moves nothing is <code>NOOP ·
            YIELD_PLAN</code>. The /company Reserves card shows the position per vault (name, address, shares, assets, APY, liquidity). Details: <code>docs/YIELD.md</code>.
          </p>
        </>
      ),
    },
    {
      id: "pricing",
      title: "Pricing bounds",
      body: (
        <>
          <Kv
            rows={[
              { k: "screen", v: "0.005 – 0.05 USDC (config default 0.01)" },
              { k: "watch", v: "0.02 – 0.2 USDC / 30 days (config default 0.05)" },
              { k: "Step", v: "at most ±20 % per change; the operator proposes 10 % steps" },
              { k: "Cooldown", v: "at least 6 h between two changes of the same price" },
              { k: "Raise trigger", v: "OPERATOR_RAISE_CALLS_24H (50) paid calls in 24 h and p95 latency ≤ OPERATOR_MAX_P95_MS (8,000 ms)" },
              { k: "Lower trigger", v: "zero outside paid calls in 48 h and price above the floor" },
            ]}
          />
          <p>
            <code>validatePriceChange()</code> is a pure guard (bounds → step → cooldown) and runs again inside <code>setPrice()</code>. The current price is what the 402 advertises;
            a client that signed for less is rejected before anything runs.
          </p>
        </>
      ),
    },
    {
      id: "schedule",
      title: "Schedule and visibility",
      body: (
        <Kv
          rows={[
            { k: "Cron", v: <>hourly at :30 (<code>/api/internal/operator</code>, bearer <code>CRON_SECRET</code>) or <code>worker/operator.ts</code></> },
            { k: "Next check", v: "the agent's own interval (900–21,600 s) is recorded; the worker honours it, the Vercel cron is the floor" },
            { k: "Read", v: <><code>GET /api/v1/company</code> - snapshot + last ten decisions, cached 30 s · <Link href="/company">/company</Link> · <Link href="/ledger">/ledger</Link> kind OPERATOR</> },
            { k: "Model", v: <>LLM_MODEL (today <code>claude-opus-4-8</code> on the 0G Compute Router; <code>ANALYST_MODEL</code> for Anthropic), temperature 0.2, tool-forced structured output</> },
          ]}
        />
      ),
    },
  ],
};
