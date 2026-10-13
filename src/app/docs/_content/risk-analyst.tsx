import Link from "next/link";
import { Code, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const TOOL = `// The only way the model can answer: one forced tool call, zod-parsed, then guarded.
submit_decision({
  recommendedLimits: { maxPerTxUsdc: number, maxPerDayUsdc: number },
  rationale: string,
  eddRequested: string[],
  nextRescreenInSeconds: number,
  requestDepth: 2 | null,
  confidence: number            // 0–1, about limits/cadence, never about the tier
})`;

const FALLBACK = `Score 23 → MEDIUM. Driven by: funder 2hop sanctioned (+15, 0xSDN…); fresh wallet (+8). Limits set to the MEDIUM band default.
// eddRequested: "Please confirm the relationship with 0xSDN… and the source of funds behind it (FUNDER_2HOP_SANCTIONED)."
// nextRescreenInSeconds: top of the MEDIUM window (86,400 s, or 43,200 s after a tier change) · confidence 0.5`;

export const riskAnalyst: DocPage = {
  slug: "risk-analyst",
  title: "Risk analyst",
  description: "The guard-railed LLM step: what it is asked, the rules that clamp its answer, and the deterministic fallback.",
  lead: (
    <>
      <strong>The Risk Analyst writes the parts of a verdict a human would want in prose, and code has the last word on every one of them.</strong> It never sees a way to change
      the score or the tier; it chooses limits inside a band, questions to ask, when to look again, whether a second hop is worth the cost, and the rationale.
    </>
  ),
  sections: [
    {
      id: "input-output",
      title: "What it receives and returns",
      body: (
        <>
          <p>
            Input: the request, the evidence bundle, the rules&apos; score, tier and reasons, the prior tier and the current time. The system prompt fixes score and tier as inputs.
            Output is a single forced tool call:
          </p>
          <Code lang="ts" code={TOOL} />
        </>
      ),
    },
    {
      id: "guards",
      title: "Guard rules",
      body: (
        <>
          <Table
            head={["Guard", "Rule", "Note in the log"]}
            wide={[1, 2]}
            rows={[
              ["clampLimits", "0 ≤ tx ≤ band, 0 ≤ day ≤ band, day ≥ tx; HIGH is 0/0; non-numeric → band ceiling", "limits clamped to MEDIUM band: {…} → {…}"],
              ["clampRescreenSeconds", "into the tier window (HIGH 5 min–1 h, MEDIUM 15 min–24 h, LOW 1 h–7 d); ceiling halved after a tier change", "rescreen clamped into LOW window (tightened: tier changed)"],
              ["filterEdd", "none for LOW; strings only, trimmed, ≥ 8 chars, de-duplicated, max 3", "EDD dropped: LOW tier · EDD filtered: 5 → 3"],
              ["sanitizeRationale", "every 0x hex (6–64 chars), NK-… OpenSanctions id or Q… Wikidata id must appear in the evidence, reasons or request (prefix ≥ 10 chars allowed); else replaced; then cut at 120 words", "stripped unverified identifiers: …"],
              ["requestDepth", "honoured once; ignored at depth 2 or when the client pinned depth 1", "requestDepth ignored: client pinned depth 1"],
              ["clampConfidence", "0–1, default 0.5", "—"],
            ]}
          />
          <p>
            <code>applyGuards()</code> never throws. <code>guardTriggered</code> and the notes go into the decision core that is hashed and signed, so an overruled model is part of
            the record, not hidden by it.
          </p>
        </>
      ),
    },
    {
      id: "fallback",
      title: "Deterministic fallback",
      body: (
        <>
          <p>
            Without <code>ANTHROPIC_API_KEY</code>, on a model error, a timeout or a malformed tool call, <code>fallbackOutput()</code> produces the same shape and goes through the
            same guards. The verdict&apos;s <code>analyst.fallback</code> flag is true and the error is recorded.
          </p>
          <Code lang="text" code={FALLBACK} />
          <ul>
            <li>
              <strong>Limits</strong> — the band ceiling for the tier.
            </li>
            <li>
              <strong>Rationale</strong> — the score, the tier and the top three reasons with their weights and one identifier each, all taken from the evidence.
            </li>
            <li>
              <strong>EDD</strong> — none for LOW; otherwise one question per top reason (at most two), naming the path&apos;s last address.
            </li>
            <li>
              <strong>Cadence</strong> — the top of the window; halved after a tier change.
            </li>
          </ul>
          <p>
            The operator&apos;s model step follows the same pattern (<Link href="/docs/operator">The operator</Link>).
          </p>
        </>
      ),
    },
  ],
};
