import Link from "next/link";
import { Kv } from "../_components/Doc";
import type { DocPage } from "./types";

export const trustModel: DocPage = {
  slug: "trust-model",
  title: "Trust model & FAQ",
  description: "What you have to trust, what you can verify, what the data cannot see, and eight questions integrators ask first.",
  lead: (
    <>
      <strong>You do not have to trust CompliR&apos;s word; you have to trust a key, a formula and public data, and all three are checkable.</strong> CompliR never holds funds,
      the score is a pure function of the evidence, every verdict is signed and replayable, and the numbers it publishes exclude its own activity.
    </>
  ),
  sections: [
    {
      id: "principles",
      title: "Four commitments",
      body: (
        <ul>
          <li>
            <strong>Never holds funds.</strong> There is no custody, vault or quarantine. The paid endpoints receive 0.01 or 0.05 USDC through an EIP-3009 authorization settled by
            Circle&apos;s facilitator; the only USDC CompliR controls is its own revenue, swept to its own wallets. Your treasury, or your contract, pays.
          </li>
          <li>
            <strong>Deterministic score.</strong> <code>scoreEvidence()</code> has no clock, no randomness and no model in it. Same evidence bundle, same score, same reasons, same
            bytes. The LLM sees the score as an input and cannot return a different one.
          </li>
          <li>
            <strong>Signed and replayable.</strong> Every verdict is EIP-712 signed by one attester key, carries the hash of its decision core, and is an entry in a hash chain whose
            roots are anchored on Arc. Verification needs the attester address and the formula, nothing from CompliR.
          </li>
          <li>
            <strong>Honest numbers.</strong> <Link href="/numbers">/numbers</Link> and the daily report exclude <code>OWN_WALLETS</code> and every internal client id, list what was
            excluded, link every outside payer to a transaction, and list refunds and mistakes rather than hide them.
          </li>
        </ul>
      ),
    },
    {
      id: "limits",
      title: "What the data cannot see",
      body: (
        <>
          <Kv
            rows={[
              { k: "Public RPC caps", v: "eth_getLogs is limited to 10,000 blocks and 2,000 results per query on the public Arc endpoints, so the funder trace pages in 9,999-block chunks over a 50,000-block lookback (≈ 7 h at ~2 blocks/s). A wallet funded only earlier than that shows no funders at hop 1. Explorer APIs sit behind a Cloudflare challenge for non-browser clients and are not used." },
              { k: "Per-source timeouts", v: "each evidence source has 4 s; a slow or down source contributes its neutral value and the bundle records what was checked. A verdict is never withheld for a missing source, which also means a CLEAN can be a clean-so-far." },
              { k: "Thin sanctions coverage", v: "yente indexes OpenSanctions' sanctions collection only (PEPs and other datasets are off by default). Address matches need a listed CryptoWallet; name matches need a supplied name and ≥ 0.7 confidence. Most Arc addresses are simply absent from any list." },
              { k: "No protocol blocklist", v: "Arc documents USDC's own blocklist (isBlacklisted) but no separate protocol-level contract, so PROTOCOL_BLOCKLISTED never fires today." },
              { k: "Reactor lag", v: "the blocklist reactor polls (20 s as a worker, 5 min as a cron) and skips ahead above 5,000 blocks of lag; it is a live reactor, not an indexer." },
              { k: "Network signal", v: "“held elsewhere” and “shared funder” only exist once several integrators screen overlapping books; on a young deployment they are usually empty." },
              { k: "Rationale", v: "prose from a model, bounded by the guards; it can be dull or wrong in emphasis, never in identifiers (unverified ones are stripped) and never in score or tier." },
            ]}
          />
          <p>
            Demo overrides (<code>.data/overrides.json</code>) exist so HIGH can be shown on our own wallets; a real sanctioned address is never paid or used in a test.
          </p>
        </>
      ),
    },
    {
      id: "faq",
      title: "FAQ",
      body: (
        <>
          <h3>Can CompliR move or freeze my money?</h3>
          <p>No. It has no approval, no custody and no hook into your transfer. It answers a question; your code or your contract acts.</p>

          <h3>What if CompliR is down when I need to pay?</h3>
          <p>
            Off-chain: your call fails and you decide (the SDK throws <code>CompliRError</code>). On-chain: <code>isAllowed</code> reads the registry, which keeps working with the
            last stored attestation until it expires (LOW 7 d, MEDIUM 24 h, HIGH 1 h); after that it fails closed.
          </p>

          <h3>Can the LLM mark someone HIGH, or clear a sanctioned address?</h3>
          <p>
            Neither. Score and tier come from the rules before the model runs, and the model&apos;s output is limits, questions, cadence and prose, each clamped in code. A direct
            sanctions, USDC blacklist or protocol blocklist hit floors the score at 61.
          </p>

          <h3>How do I know a verdict was not altered after the fact?</h3>
          <p>
            Recompute <code>decisionHash</code> from the ledger payload, check it equals the one inside the signed attestation, recover the signer, and check the entry&apos;s hash and
            its batch root on Arc. Details on <Link href="/docs/ledger-reports">Ledger & reports</Link>.
          </p>

          <h3>What do you store about my payee book?</h3>
          <p>
            Lookalike and payee-change checks run against the book you send; hop-1 funders of your payees are remembered per client id so <code>NETWORK_SHARED_FUNDER</code> can be
            answered for you. The cross-client signal exposes only counts and the subject&apos;s own funder; no other client&apos;s id, payee or book ever leaves the network module.
          </p>

          <h3>Will I be charged if the screen fails?</h3>
          <p>
            No. The handler runs before settlement on screen and watch; a non-2xx is never charged (<code>X-CompliR-Payment: not-charged</code>). Where settlement must come first
            (the tip stake), a failure after it queues an automatic refund and says so in the error.
          </p>

          <h3>Why is the registry address empty?</h3>
          <p>
            The contracts are built and tested (45 Foundry tests) but not yet deployed on Arc mainnet. Until then <code>registryTx</code> is <code>null</code>, the EIP-712 domain
            uses the zero address as <code>verifyingContract</code>, and signatures still verify offline. The <Link href="/docs/mainnet-checklist">mainnet checklist</Link> is the
            deploy order.
          </p>

          <h3>Is this legal advice or a compliance program?</h3>
          <p>
            No. It is a risk signal built from public data and your own payee book, with its limits listed above. Treat a LOW as &quot;nothing found&quot;, a HIGH as &quot;do not pay
            without a human&quot;, and read the reasons.
          </p>
        </>
      ),
    },
  ],
};
