import Link from "next/link";
import { Code, Kv, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const CHAIN = `// src/lib/ledger/decisionLog.ts
hash = keccak256( prevHash ‖ utf8(canonical(payload)) ‖ uint64be(seq) ‖ utf8(kind) )
genesis prevHash = 0x00…00 (32 bytes) · seq starts at 1 and is contiguous
canonical() = keys sorted recursively, arrays in order, no whitespace, undefined dropped, bigint → decimal string

// src/lib/ledger/anchor.ts — Merkle root over the hashes of every unanchored entry, in seq order
pair(a, b) = keccak256(min(a, b) ‖ max(a, b))          // sorted pairs, so proofs need no position bits
odd level  → last leaf is duplicated
root → AttestationRegistry.anchorRoot(root, fromSeq, toSeq)   // every ANCHOR_EVERY_N = 50 entries
→ ANCHOR ledger entry { root, fromSeq, toSeq, tx, count } and anchorTx set on each entry in the range`;

const ENTRY = `GET /api/v1/decision/dec_…
{
  "id": "dec_…", "seq": 1042, "kind": "SCREEN", "subject": "0x…", "clientId": "treasury-7",
  "payload": { "address", "score", "tier", "reasons", "recommendedLimits", "rationale", "eddRequested", "nextRescreenAt",
               "evidenceDepth", "collectedAt", "analyst": { "model", "fallback", "latencyMs" }, "guards": [ … ], "screenedAt",
               "priorTier", "clientId", "decisionHash", "attestation": { "signature", "attester", "validUntil" } },
  "prevHash": "0x…", "hash": "0x…", "createdAt": 1760000000, "anchorTx": null
}`;

const VERIFY_REPORT = `import { keccak256, stringToHex, verifyMessage } from "viem";
import { canonicalize } from "./src/lib/attest/canonical";      // or re-implement: sorted keys, no whitespace

const { report, hash, signature, signer } = await (await fetch("https://complir.example/api/v1/report")).json();
const recomputed = keccak256(stringToHex(canonicalize(report)));
console.log(recomputed === hash);                                                       // the hash is over the canonical JSON
console.log(await verifyMessage({ address: signer, message: hash, signature }));       // EIP-191 personal_sign over the hash string`;

export const ledgerReports: DocPage = {
  slug: "ledger-reports",
  title: "Ledger & reports",
  description: "The hash-chained decision log, its Merkle anchors on Arc, the verify endpoint, and how to check a signed daily report.",
  lead: (
    <>
      <strong>Every decision the oracle or the operator makes is one entry in a single hash chain, and the chain is periodically rooted on Arc.</strong> Screens, re-screens,
      tier changes, EDD answers, payouts, operator ticks, tips, refunds, reports and the anchors themselves all share the same formula and the same verify endpoint.
    </>
  ),
  sections: [
    {
      id: "chain",
      title: "Hash chain",
      body: (
        <>
          <Code lang="pseudo" code={CHAIN} />
          <Kv
            rows={[
              { k: "Kinds", v: "SCREEN · RESCREEN · TIER_CHANGE · EDD_RESPONSE · NOOP (USYC sweeps) · ANCHOR · PAYOUT · OPERATOR · TIP · REFUND · REPORT" },
              { k: "Append", v: "serialised in-process so seq is contiguous; id = dec_ + base36 time + seq + random" },
              { k: "Privacy", v: "payloads never include another client's book; EDD answers are logged only as keccak(answers); tip submitters are anonymised" },
              { k: "Anchoring today", v: "pending: anchorRoot needs the deployed registry and the attester key; entries accumulate with anchorTx null and anchor in one batch after the deploy" },
            ]}
          />
        </>
      ),
    },
    {
      id: "entry",
      title: "One entry",
      body: (
        <>
          <Code lang="json" code={ENTRY} />
          <p>
            The payload is the decision core that was hashed into <code>decisionHash</code> and signed; the <code>evidence</code> bundle lives on the attestation record and the
            verdict, so the ledger stays small. <Link href="/ledger">/ledger</Link> lists entries and <code>/log/:id</code> renders one with a replay of the verdict.
          </p>
        </>
      ),
    },
    {
      id: "verify",
      title: "Verify",
      body: (
        <>
          <Kv
            rows={[
              { k: "GET /api/v1/ledger/verify", v: "re-walks the chain from genesis: { ok, brokenAt, length }; brokenAt is the first seq whose prevHash, seq or recomputed hash does not match" },
              { k: "GET /api/v1/ledger?limit=50", v: "newest entries" },
              { k: "GET /api/v1/decision/:id", v: "one entry with its anchorTx" },
              { k: "A verdict", v: "decisionHash in the attestation == keccak256(canonical(payload)) of its ledger entry; signature recovers to the published attester" },
              { k: "An anchor", v: "recompute the Merkle root over hashes fromSeq..toSeq and compare with the Anchored(root, fromSeq, toSeq) event on Arc" },
            ]}
          />
        </>
      ),
    },
    {
      id: "report",
      title: "Signed daily report",
      body: (
        <>
          <p>
            Once per UTC day the agent generates a report from its own database, canonicalises and hashes the JSON, signs the hash string with the attester key as an EIP-191{" "}
            <code>personal_sign</code>, stores it, and appends a <code>REPORT</code> ledger entry carrying the same hash. The entry is anchored with the rest of the chain.
          </p>
          <Table
            head={["Where", "What"]}
            wide={[1]}
            rows={[
              [<Link key="r" href="/report">/report</Link>, "rendered latest report, “Copy markdown”, signature, archive"],
              [<code key="a">GET /api/v1/report</code>, "{ date, hash, signature, signer, ledgerId, createdAt, report, archive[] }; ?format=md"],
              [<code key="b">GET /api/v1/report/:date · :date.md</code>, "one day as JSON or markdown; latest is an alias"],
              [<code key="c">POST /api/internal/report?date=yesterday&force=1</code>, "regenerate (Bearer CRON_SECRET)"],
            ]}
          />
          <h3>How to verify a signature</h3>
          <Code lang="ts" code={VERIFY_REPORT} />
          <p>
            <code>signer</code> is the attester address, the same key that signs attestations. If the report is later regenerated with <code>force=1</code>, the hash changes and a
            new <code>REPORT</code> entry is appended; the old entry stays in the chain. The <Link href="/docs/refunds-report">refunds and report</Link> page lists what a report
            contains.
          </p>
        </>
      ),
    },
  ],
};
