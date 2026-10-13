import Link from "next/link";
import { Fig } from "@/components/figures/Fig";
import TimingDiagram from "@/components/figures/TimingDiagram";
import { Kv, Table } from "../_components/Doc";
import type { DocPage } from "./types";

export const howItWorks: DocPage = {
  slug: "how-it-works",
  title: "How it works",
  description: "The five-stage screening pipeline: evidence, deterministic rules, guard-railed analyst, EIP-712 attestation, ledger and registry.",
  lead: (
    <>
      <strong>A screen is one pass through five stages, and only one of them involves a language model.</strong> Evidence is collected from public sources, deterministic rules
      turn it into a score and a tier, the Risk Analyst explains and sets limits inside hard bands, the attester key signs, and the result is logged, stored and mirrored on-chain.
    </>
  ),
  intro: (
    <Fig n="01" label="One screen, as a capture" meta="lanes · typical 2–3 s · re-screen returns the cursor">
      <TimingDiagram />
    </Fig>
  ),
  sections: [
    {
      id: "stages",
      title: "The five stages",
      body: (
        <>
          <ol>
            <li>
              <strong>Evidence.</strong> Sources run concurrently, each behind a per-source timeout (4 s, <code>EVIDENCE_SOURCE_TIMEOUT_MS</code>). Phase 1: subject facts (first
              seen, tx count, USDC <code>isBlacklisted</code>, protocol blocklist, yente by address and name) alongside the funder trace; phase 2: the funders get the same checks in
              one batched yente call, plus the cross-client network signal and verified community tips. A source that fails contributes its neutral value, so a bundle is always
              produced.
            </li>
            <li>
              <strong>Rules.</strong> <code>scoreEvidence(bundle)</code> is pure: same bundle in, same score and reasons out. Weights are fixed (<Link href="/docs/reason-codes">reason
              codes</Link>), funder hits stack with diminishing returns, three hard hits floor the score at 61, and reasons are sorted so the output is byte-stable for hashing.
              Tier bands: LOW 0–20, MEDIUM 21–60, HIGH 61–100.
            </li>
            <li>
              <strong>Risk Analyst.</strong> Claude (<code>ANALYST_MODEL</code>) receives the bundle, score, tier and reasons and must call one tool, <code>submit_decision</code>. It
              returns limits, a rationale, EDD questions, a re-screen interval and optionally a request for the second hop. Every field is clamped or filtered in code before it
              is used; without an API key a deterministic fallback produces the same shape.
            </li>
            <li>
              <strong>Attestation.</strong> The replayable core of the decision is canonicalised and hashed (<code>decisionHash</code>), then signed as an EIP-712{" "}
              <code>Attestation</code> by the attester key. Validity follows the tier: LOW 7 days, MEDIUM 24 hours, HIGH 1 hour.
            </li>
            <li>
              <strong>Ledger, store, registry.</strong> A <code>SCREEN</code> (or <code>RESCREEN</code>) entry is appended to the hash chain, the verdict is stored for the free
              endpoints, an EDD request is opened when questions were asked, and the attestation is written to <code>AttestationRegistry</code> on Arc without blocking the response
              (<code>registryTx</code> is <code>null</code> until it lands; today the registry is pending deploy, so it stays <code>null</code>).
            </li>
          </ol>
        </>
      ),
    },
    {
      id: "depth",
      title: "One hop or two",
      body: (
        <>
          <p>
            The funder trace reads USDC <code>Transfer</code> logs from Arc&apos;s system emitter (<code>0xffff…fffE</code>, 18 dp) so native sends are seen, paging the public RPC
            in chunks of at most 9,999 blocks over a 50,000-block lookback. Hop 1 is always traced. Hop 2 costs more RPC and is only taken when it can change the answer:
          </p>
          <ul>
            <li>
              <strong>Never</strong> when the subject itself is sanctioned or blacklisted: it is already HIGH.
            </li>
            <li>
              <strong>Always</strong> when a hop-1 funder has a hit, the wallet is fresh (first seen under 7 days or fewer than 5 txs), the amount is 1,000 USDC or more, a
              payee-book lookalike matched, or the request pins <code>depth: 2</code>.
            </li>
            <li>
              <strong>On request</strong> when the analyst answers <code>requestDepth: 2</code> after seeing hop 1; the pipeline honours that once, re-scores, and asks the analyst
              again.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "llm-boundary",
      title: "What the model can and cannot decide",
      body: (
        <>
          <Table
            head={["Field", "Who decides", "Guard in code"]}
            wide={[2]}
            rows={[
              [<code key="s">score</code>, "rules", "pure function of the evidence; the model never sees a way to change it"],
              [<code key="t">tier</code>, "rules", "band of the score"],
              [<code key="l">recommendedLimits</code>, "analyst", "clamped into the tier band: LOW ≤ 10,000 / 50,000 USDC, MEDIUM ≤ 250 / 1,000, HIGH 0 / 0; day ≥ tx"],
              [<code key="n">nextRescreenAt</code>, "analyst", "clamped into the tier window: HIGH 5 min–1 h, MEDIUM 15 min–24 h, LOW 1 h–7 d; the ceiling halves after a tier change"],
              [<code key="e">eddRequested</code>, "analyst", "dropped for LOW; trimmed, de-duplicated, at most 3 questions of 8+ characters"],
              [<code key="r">rationale</code>, "analyst", "any 0x hash, address or sanctions id not present in the evidence is replaced with “[unverified identifier removed]”; cut at 120 words"],
              [<code key="d">requestDepth</code>, "analyst", "honoured once, ignored when depth is already 2 or the client pinned depth 1"],
            ]}
          />
          <p>
            Every clamp is recorded as a guard note in the decision log entry, so a reviewer can see when the model was overruled and by what.
          </p>
        </>
      ),
    },
    {
      id: "cadence",
      title: "Re-screen cadence",
      body: (
        <>
          <p>
            A verdict carries the next time the analyst wants to look again. Watched addresses are re-screened on that schedule by the watcher (every 10 minutes on Vercel,
            every 60 s as a worker) and a webhook fires on every tier change. Two other loops re-grade without being asked: the Trust Map tailer re-grades mainnet recipients every 24
            hours, and the blocklist reactor re-screens any watched, mapped or recently screened address within one tick of a USDC <code>Blacklisted</code> event.
          </p>
          <Kv
            rows={[
              { k: "HIGH", v: "re-screen between 5 min and 1 h · attestation valid 1 h" },
              { k: "MEDIUM", v: "re-screen between 15 min and 24 h · attestation valid 24 h" },
              { k: "LOW", v: "re-screen between 1 h and 7 d · attestation valid 7 d" },
              { k: "After a tier change", v: "the window ceiling halves for the next cycle" },
              { k: "Failed re-screen", v: "retried in 10 min; the last tier is kept" },
            ]}
          />
        </>
      ),
    },
  ],
};
