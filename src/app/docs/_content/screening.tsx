import Link from "next/link";
import { Code, Kv, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const REQUEST = `POST /api/v1/screen
Content-Type: application/json
PAYMENT-SIGNATURE: <x402 payload>        # omitted on the first call; the 402 tells you what to sign

{
  "address":    "0x000000000000000000000000000000000000dead",   // required, EVM address (lower-cased)
  "name":       "Acme Supplies Ltd",                             // optional, 2–200 chars, name-based sanctions matching
  "amountUsdc": 120,                                             // optional, ≥ 0; ≥ 1,000 forces the second hop
  "payeeBook":  [{ "label": "Lela", "address": "0x12ab…9f3c" }], // optional, ≤ 500 entries; lookalike + payee-change detection
  "clientId":   "treasury-7",                                    // optional, ≤ 100 chars; scopes the network signal and watches
  "depth":      2                                                // optional, 1 | 2; otherwise the pipeline decides
}`;

const VERDICT = `{
  "address": "0x…", "score": 37, "tier": "MEDIUM",
  "recommendedLimits": { "maxPerTxUsdc": 250, "maxPerDayUsdc": 1000 },
  "reasons": [
    { "code": "FUNDER_2HOP_SANCTIONED", "weight": 15,
      "evidence": { "hop": 2, "count": 1, "hits": [{ "funder": "0xSDN", "path": ["0xSDN", "0xB", "0x…"], "txs": ["0x…"], "sanctions": [ … ] }] } },
    { "code": "FRESH_WALLET", "weight": 8, "evidence": { "firstSeen": "2026-10-06T…", "txCount": 3, "triggers": { "youngerThan7d": true, "fewerThan5Txs": true } } }
  ],
  "rationale": "…written by the Risk Analyst, identifiers verified against the evidence…",
  "eddRequested": ["Please confirm the relationship with 0xB and the source of funds behind it."],
  "edd": { "id": "edd_…", "url": "https://complir.example/edd/edd_…" },
  "nextRescreenAt": "2026-10-10T03:00:00Z",
  "attestation": {
    "typedData": { "domain": { "name": "CompliR", "version": "1", "chainId": 5042, "verifyingContract": "0x…" },
                   "types": { "Attestation": [ … ] }, "primaryType": "Attestation",
                   "message": { "subject": "0x…", "tier": 2, "score": 37, "decisionHash": "0x…", "issuedAt": 1760000000, "validUntil": 1760086400 } },
    "signature": "0x…", "attester": "0x…", "validUntil": 1760086400, "registryTx": null
  },
  "decisionId": "dec_…", "screenedAt": "2026-10-09T…",
  "evidence": { "subject": { … }, "funders": [ … ], "lookalikes": [], "payeeChanged": null, "concentration": null,
                "priorTier": null, "network": { … }, "communityTips": [], "depth": 2, "collectedAt": 1760000000 }
}`;

export const screening: DocPage = {
  slug: "screening",
  title: "Screening & verdicts",
  description: "The screen request, the verdict it returns, what each field means and the limit bands per tier.",
  lead: (
    <>
      <strong>A screen is one POST with an address; the answer is a verdict you can act on, verify and replay.</strong> Everything the pipeline looked at is in the response,
      including the evidence, so the same decision can be reproduced later from the ledger entry.
    </>
  ),
  sections: [
    {
      id: "request",
      title: "Request",
      body: (
        <>
          <p>
            <code>POST /api/v1/screen</code> costs 0.01 USDC over <Link href="/docs/x402">x402</Link>. Same-origin browser calls (the hosted Explorer) are free; with{" "}
            <code>X402_DISABLED=1</code> every call is free. The response carries <code>X-CompliR-Decision-Id</code>.
          </p>
          <Code lang="http" code={REQUEST} />
          <p>
            Validation errors are 400 with <code>{`{ "error": { "code": "VALIDATION_ERROR", "message", "details" } }`}</code> and are never charged. A paused service answers 503{" "}
            <code>SERVICE_PAUSED</code>.
          </p>
        </>
      ),
    },
    {
      id: "response",
      title: "Response",
      body: <Code lang="json" code={VERDICT} />,
    },
    {
      id: "anatomy",
      title: "Verdict anatomy",
      body: (
        <Kv
          rows={[
            { k: "score", v: "0–100 integer from the deterministic rules. Sum of reason weights, clamped; a hard hit floors it at 61." },
            { k: "tier", v: "LOW 0–20 · MEDIUM 21–60 · HIGH 61–100. On-chain enum: UNKNOWN 0, LOW 1, MEDIUM 2, HIGH 3." },
            { k: "recommendedLimits", v: "Per-tx and per-day USDC the analyst recommends, always inside the tier band (below). Adopt them directly or take the minimum with your own policy." },
            { k: "reasons[]", v: "Each { code, weight, evidence }. Codes are a closed set; evidence carries whatever a reviewer needs to click: paths, tx hashes, entity ids, timestamps. Sorted by weight desc, code asc." },
            { k: "rationale", v: "Plain English from the Risk Analyst (≤ 120 words). Identifiers it cites are checked against the evidence; unknown ones are removed." },
            { k: "eddRequested", v: "0–3 Enhanced Due Diligence questions, MEDIUM/HIGH only. When present, `edd.url` is a public page the counterparty can answer; answers are hashed into the ledger and trigger a re-screen." },
            { k: "nextRescreenAt", v: "ISO time the analyst chose inside the tier window. Watches use it as their schedule." },
            { k: "attestation", v: "EIP-712 typed data, signature, attester address, validUntil and the registry tx (null until the on-chain write lands). Verify offline with the SDK or MCP." },
            { k: "decisionId", v: "Id of the SCREEN / RESCREEN entry in the hash-chained log: GET /api/v1/decision/:id or /log/:id." },
            { k: "evidence", v: "The full bundle the rules scored: subject facts, hop-1 and hop-2 funders with paths, lookalikes, payee change, concentration, prior tier, anonymised network signal, community tips, depth and collectedAt." },
          ]}
        />
      ),
    },
    {
      id: "limits",
      title: "Limit bands",
      body: (
        <>
          <p>
            The analyst picks values inside the band for the tier; <code>clampLimits</code> guarantees it can never recommend more, never a negative or non-numeric value, and that
            the daily limit is at least the per-transaction limit. HIGH is always 0 / 0.
          </p>
          <Table
            head={["Tier", "Score", "Max per tx", "Max per day", "Attestation valid"]}
            rows={[
              [<span key="l" className="badge badgeLOW">LOW</span>, "0–20", "10,000 USDC", "50,000 USDC", "7 days"],
              [<span key="m" className="badge badgeMEDIUM">MEDIUM</span>, "21–60", "250 USDC", "1,000 USDC", "24 hours"],
              [<span key="h" className="badge badgeHIGH">HIGH</span>, "61–100", "0", "0", "1 hour"],
            ]}
          />
          <p>
            These are also the defaults when the model is unavailable: the fallback returns the band ceiling, the top of the re-screen window, and a rationale that cites the top
            three reasons.
          </p>
        </>
      ),
    },
    {
      id: "free-reads",
      title: "Free reads after a screen",
      body: (
        <ul>
          <li>
            <strong>GET /api/v1/attestation/:address</strong> — the latest stored verdict and attestation (<code>source: &quot;store&quot;</code>); an address never seen is screened
            once (<code>source: &quot;fresh&quot;</code>).
          </li>
          <li>
            <strong>GET /api/v1/decision/:id</strong> — the ledger entry: payload, prev/this hash, anchor tx.
          </li>
          <li>
            <strong>GET /api/v1/network/:address</strong> — the anonymised cross-client signal (held elsewhere, concentration hint, blocklist events).
          </li>
          <li>
            <strong>GET /api/v1/badge/:address.svg</strong> — a &quot;Screened by CompliR&quot; badge from the stored attestation.
          </li>
        </ul>
      ),
    },
  ],
};
