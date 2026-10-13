import Link from "next/link";
import {
  FRESH_WALLET_MAX_AGE_SECONDS,
  FRESH_WALLET_MAX_TX_COUNT,
  FUNDER_STACK_DECAY,
  HARD_HIT_CODES,
  HARD_HIT_FLOOR,
  NETWORK_HELD_ELSEWHERE_SINGLE_WEIGHT,
  NETWORK_SHARED_FUNDER_MIN_PAYEES,
  PRIOR_HIGH_TIER_LOOKBACK_SECONDS,
  SANCTIONS_NAME_MIN_CONFIDENCE,
  WEIGHTS,
} from "@/lib/scoring/rules";
import type { ReasonCode } from "@/lib/types";
import { Code, Kv, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const DESCRIPTIONS: Record<ReasonCode, { what: string; source: string }> = {
  SANCTIONS_DIRECT: { what: "The address, or the entity resolved from the optional name, is a hit in OpenSanctions (self-hosted yente).", source: "yente /match: CryptoWallet.publicKey, or Person/Organization name" },
  USDC_BLACKLISTED: { what: "Circle's USDC contract on Arc answers isBlacklisted(address) == true.", source: "FiatTokenV2.isBlacklisted, 1 RPC call" },
  PROTOCOL_BLOCKLISTED: { what: "Listed on the Arc protocol blocklist contract. No such contract is documented today, so PROTOCOL_BLOCKLIST_ADDRESS is empty and this never fires.", source: "PROTOCOL_BLOCKLIST_ADDRESS (unset)" },
  FUNDER_1HOP_SANCTIONED: { what: "A wallet that sent USDC to the subject is sanctioned.", source: "funder trace (hop 1) + yente" },
  FUNDER_2HOP_SANCTIONED: { what: "A wallet that funded one of the subject's funders is sanctioned.", source: "funder trace (hop 2) + yente" },
  FUNDER_1HOP_BLACKLISTED: { what: "A hop-1 funder is USDC-blacklisted or protocol-blocklisted.", source: "funder trace + isBlacklisted" },
  FUNDER_2HOP_BLACKLISTED: { what: "A hop-2 funder is USDC-blacklisted or protocol-blocklisted.", source: "funder trace + isBlacklisted" },
  FRESH_WALLET: { what: "First seen under 7 days ago, or fewer than 5 transactions.", source: "RPC nonce + first incoming USDC transfer" },
  NO_HISTORY: { what: "No on-chain footprint on Arc at all (never seen, zero txs). Takes precedence over FRESH_WALLET.", source: "RPC" },
  LOOKALIKE_OF_KNOWN_PAYEE: { what: "Address poisoning: the subject shares the first 4 and last 4 hex characters with a payee in your book, or is ≥ 0.8 similar by normalised Levenshtein, but is a different address.", source: "your payeeBook" },
  PAYEE_ADDRESS_CHANGED: { what: "Same payee label as before, new address (compared with the previous book on a re-screen).", source: "your payeeBook" },
  HIGH_CONCENTRATION: { what: "A hop-1 funder of the subject also funded several other payees or graded nodes across the network.", source: "network store (NETWORK_MIN_CONCENTRATION, default 3)" },
  PRIOR_HIGH_TIER: { what: "CompliR itself graded this address HIGH within the last 30 days.", source: "own attestation history" },
  NETWORK_HELD_ELSEWHERE: { what: "Other integrators rated this address HIGH in the last 7 days. Evidence is a count only; no other client is identifiable.", source: "shared screenings store (internal client ids excluded)" },
  NETWORK_SHARED_FUNDER: { what: "The subject shares a hop-1 funder with 3 or more of your own payees.", source: "your payee funders (client-scoped)" },
  COMMUNITY_TIP_VERIFIED: { what: "A staked tip about this address was verified by the agent in the last 180 days. Evidence carries tip ids, categories and strength only.", source: "tip market" },
  CLEAN: { what: "Explicit positive: no signal from any source. Score 0.", source: "—" },
};

const ORDER: ReasonCode[] = [
  "SANCTIONS_DIRECT", "USDC_BLACKLISTED", "PROTOCOL_BLOCKLISTED",
  "FUNDER_1HOP_SANCTIONED", "FUNDER_1HOP_BLACKLISTED", "FUNDER_2HOP_SANCTIONED", "FUNDER_2HOP_BLACKLISTED",
  "LOOKALIKE_OF_KNOWN_PAYEE", "PRIOR_HIGH_TIER", "NETWORK_HELD_ELSEWHERE", "PAYEE_ADDRESS_CHANGED", "COMMUNITY_TIP_VERIFIED",
  "NO_HISTORY", "HIGH_CONCENTRATION", "FRESH_WALLET", "NETWORK_SHARED_FUNDER", "CLEAN",
];

const STACK = `// Repeated hits at the same hop and signal stack with diminishing returns.
weight(i) = round(base × ${FUNDER_STACK_DECAY} ^ i)      // i = 0, 1, 2 … per (hop, signal)
// two sanctioned hop-1 funders: 30 + 15 = 45 · three: 30 + 15 + 8 = 53

score = clamp(0, 100, Σ weights)
if (any of ${HARD_HIT_CODES.join(" | ")}) score = max(score, ${HARD_HIT_FLOOR})
tier  = score ≤ 20 ? LOW : score ≤ 60 ? MEDIUM : HIGH`;

export const reasonCodes: DocPage = {
  slug: "reason-codes",
  title: "Reason codes",
  description: "Every reason code the rules can emit, its weight, its source, and how weights combine into the score.",
  lead: (
    <>
      <strong>The rulebook is seventeen codes with fixed weights, and the weights below are read from the code that scores.</strong> Every verdict lists the codes that fired with
      the evidence behind each one; nothing else can move the score.
    </>
  ),
  sections: [
    {
      id: "table",
      title: "Codes and weights",
      body: (
        <>
          <Table
            head={["Code", "Weight", "What it means", "Source"]}
            wide={[2, 3]}
            rows={ORDER.map((code) => [
              <code key="c">{code}</code>,
              <strong key="w">
                {code === "NETWORK_HELD_ELSEWHERE" ? `${NETWORK_HELD_ELSEWHERE_SINGLE_WEIGHT} / ${WEIGHTS[code]}` : WEIGHTS[code]}
              </strong>,
              DESCRIPTIONS[code].what,
              <span key="s" className="small">{DESCRIPTIONS[code].source}</span>,
            ])}
          />
          <p>
            <code>NETWORK_HELD_ELSEWHERE</code> scores {NETWORK_HELD_ELSEWHERE_SINGLE_WEIGHT} for exactly one other client and {WEIGHTS.NETWORK_HELD_ELSEWHERE} for two or more.{" "}
            <code>NETWORK_SHARED_FUNDER</code> needs {NETWORK_SHARED_FUNDER_MIN_PAYEES} of your payees on the same funder. Source: <code>src/lib/scoring/rules.ts</code>.
          </p>
        </>
      ),
    },
    {
      id: "aggregation",
      title: "How weights combine",
      body: (
        <>
          <Code lang="pseudo" code={STACK} />
          <Kv
            rows={[
              { k: "Hard-hit floor", v: `${HARD_HIT_CODES.join(", ")} each weigh 100 and force the score to at least ${HARD_HIT_FLOOR}, the bottom of HIGH.` },
              { k: "Name matches", v: `A sanctions hit matched on a name needs matcher confidence ≥ ${SANCTIONS_NAME_MIN_CONFIDENCE}; address matches always count.` },
              { k: "Fresh wallet", v: `first seen < ${FRESH_WALLET_MAX_AGE_SECONDS / 86_400} days or < ${FRESH_WALLET_MAX_TX_COUNT} txs; NO_HISTORY wins when both are zero.` },
              { k: "Prior HIGH", v: `looks back ${PRIOR_HIGH_TIER_LOOKBACK_SECONDS / 86_400} days in CompliR's own history.` },
              { k: "Determinism", v: "“now” is the bundle's collectedAt, never the clock; funders are de-duplicated by (hop, address) and sorted before scoring; reasons are sorted (weight desc, code asc)." },
              { k: "CLEAN", v: "returned alone with weight 0 when nothing fired; evidence records depth and how many funders were checked." },
            ]}
          />
          <p>
            Worked example: a fresh wallet (8) whose hop-2 funder is sanctioned (15) scores 23 → MEDIUM. Add a verified community tip (15) and it is 38, still MEDIUM; a tip can
            corroborate but never reach HIGH on its own. A direct USDC blacklist flag is 100 → HIGH regardless of anything else.
          </p>
          <p>
            Rules decide score and tier; the <Link href="/docs/risk-analyst">Risk Analyst</Link> decides everything else.
          </p>
        </>
      ),
    },
  ],
};
