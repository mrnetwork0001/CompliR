import HeroLattice from "@/components/HeroLattice";
import type { Metadata } from "next";
import Link from "next/link";
import { LiveNumbers } from "@/components/LiveNumbers";
import { LiveDemo } from "@/components/LiveDemo";
import { GITHUB_URL } from "@/components/Nav";
import { Fig } from "@/components/figures/Fig";
import TimingDiagram from "@/components/figures/TimingDiagram";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "CompliR - Counterparty risk oracle on Arc. Compiled to signed verdicts.",
  description:
    "Grade any counterparty in one call. Signed EIP-712 verdicts a contract can check, mirrored on-chain, re-graded continuously, replayable from a hash-chained log. Never holds funds.",
};

const CHAIN_ID = 5042;

const CURL = `curl -s -X POST https://complir.example/api/v1/screen \\
  -H 'Content-Type: application/json' \\
  -d '{ "address": "0xPayee", "amountUsdc": 120 }'
# → 402 + x402 requirements; your client pays 0.01 USDC and retries
# → { "tier": "MEDIUM", "score": 37, "recommendedLimits": {...}, "attestation": {...} }`;

const SDK = `import { CompliR } from "@complir/sdk";
const c = new CompliR({ wallet }); // Circle agent wallet on Arc pays via x402

const v = await c.screen("0xPayee", { amountUsdc: 120, payeeBook });
if (v.tier === "HIGH") hold();
else pay(Math.min(amount, v.recommendedLimits.maxPerTxUsdc));
await c.watch("0xPayee", { webhook }); // tier.changed events`;

const SOL = `require(
  ICompliR(registry).isAllowed(payee, ICompliR.Tier.MEDIUM),
  "CompliR: payee tier too high"
);
// true iff tier != UNKNOWN && tier <= MEDIUM && validUntil > block.timestamp`;

const STEPS = [
  {
    n: "01",
    title: "Collect evidence",
    spec: "6 sources · per-source timeout",
    body: "OpenSanctions (yente), Circle USDC isBlacklisted, the Arc protocol blocklist, on-chain activity, a 2-hop USDC funder trace with tx hashes, and a lookalike check against your payee book. A source that fails is recorded, never assumed clean.",
  },
  {
    n: "02",
    title: "Score deterministically",
    spec: "0–100 · rules, not a model",
    body: "LOW 0–20, MEDIUM 21–60, HIGH 61–100. Every point is attributed to a reason code with its evidence. Two runs over the same evidence produce the same score.",
  },
  {
    n: "03",
    title: "Analyst, clamped",
    spec: "LLM · ≤120 words · 3 EDD questions",
    body: "A Risk Analyst reads the evidence, writes the rationale, proposes limits, asks up to three EDD questions and picks the re-screen cadence. Code clamps every field to the tier band. The analyst cannot move the score.",
  },
  {
    n: "04",
    title: "Attest and log",
    spec: "EIP-712 · registry · hash chain",
    body: "Attestation(subject, tier, score, decisionHash, issuedAt, validUntil) is signed, mirrored in AttestationRegistry on Arc, and appended to a hash-chained decision log whose roots are Merkle-anchored on-chain.",
  },
];

const ANATOMY: [string, string][] = [
  ["score", "0–100, deterministic"],
  ["tier", "LOW / MEDIUM / HIGH"],
  ["recommendedLimits", "maxPerTxUsdc, maxPerDayUsdc - clamped to the tier band"],
  ["reasons[]", "code, weight and evidence: tx hashes, funder paths, sanctions entity ids"],
  ["rationale", "written by the Risk Analyst, ≤120 words"],
  ["eddRequested[]", "up to three questions to ask the counterparty instead of refusing"],
  ["nextRescreenAt", "cadence the analyst picked: HIGH hourly → LOW weekly"],
  ["attestation", "EIP-712 typed data, signature, attester, validUntil, registryTx"],
  ["decisionId", "replayable entry in the hash-chained log: /log/<id>"],
];

const PRODUCTS = [
  { href: "/map", title: "Arc Trust Map", body: "Every counterparty receiving meaningful USDC on Arc mainnet, graded and re-graded as the chain moves.", tag: "live", px: 7, stat: "re-graded every tick" },
  { href: "/payouts", title: "Guarded Payouts", body: "A treasury agent pays through GuardedTreasury. Paid, limited or held, each with a signed reason.", tag: "demo", px: 5, stat: "isAllowed(payee, MEDIUM)" },
  { href: "/explorer", title: "Explorer", body: "One address in. Dial, reasons, 2-hop funder graph, analyst rationale, signed attestation out.", tag: "tool", px: 6, stat: "POST /api/v1/screen" },
  { href: "/shadow", title: "Shadow Report", body: "Paste a payee book and recent payments. See what the denylist missed, as a report you can share.", tag: "free", px: 4, stat: "≤ 50 addresses" },
  { href: "/badge", title: "Screened-by Badge", body: "An SVG badge for receipts and READMEs. Links to the live attestation JSON.", tag: "free", px: 3, stat: "SVG · cached 60 s" },
  { href: "/tips", title: "Tip Market", body: "Staked community intelligence. A verified tip earns a bounty; a bad one loses its stake.", tag: "x402", px: 4, stat: "stake 0.05 USDC" },
];

const DIFFERENT = [
  { title: "Signed", body: "Every verdict is an EIP-712 attestation you can verify offline against the published attester address." },
  { title: "Replayable", body: "Every decision is an entry in a hash-chained log with the evidence it was built on. Re-walk the chain any time." },
  { title: "On-chain", body: "AttestationRegistry on Arc mirrors the tier. A contract checks isAllowed(payee, MEDIUM) in one call." },
  { title: "Continuous", body: "Re-graded on a cadence the agent picks: HIGH hourly, MEDIUM daily, LOW weekly. tier.changed webhooks." },
  { title: "Pay per call", body: "0.01 USDC via x402 with the Circle facilitator. No API keys, no contracts, no sales call." },
  { title: "Never holds funds", body: "CompliR is an oracle. Your USDC never touches us; the treasury that moves money stays yours." },
];

const PRICING: { endpoint: string; price: string; what: string }[] = [
  { endpoint: "POST /api/v1/screen", price: "0.01 USDC", what: "full verdict + signed attestation" },
  { endpoint: "POST /api/v1/watch", price: "0.05 USDC / 30 d", what: "adaptive re-screening + tier.changed webhooks" },
  { endpoint: "GET /api/v1/attestation/:address", price: "free", what: "latest attestation JSON" },
  { endpoint: "GET /api/v1/badge/:address.svg", price: "free", what: "screened-by badge, cached 60 s" },
  { endpoint: "POST /api/v1/shadow", price: "free", what: "shadow report, ≤50 addresses" },
  { endpoint: "feed · numbers · ledger · decision", price: "free", what: "public records, addresses masked" },
];

const FAQ: [string, string][] = [
  [
    "Do you hold funds?",
    "No. CompliR is a read-only oracle. The only USDC that moves is the per-call x402 fee you pay to our revenue wallet. Guarded Payouts uses a separate GuardedTreasury contract that you deploy and own.",
  ],
  [
    "What data sources do you use?",
    "OpenSanctions via yente (address and name matching), Circle's USDC contract isBlacklisted(), the Arc protocol blocklist, Arc RPC for activity and a 2-hop USDC funder trace, our own prior verdicts, and the payee book you send for lookalike and address-change detection.",
  ],
  [
    "Can the LLM change a score?",
    "No. Deterministic rules own the score and tier. The Risk Analyst writes the rationale, proposes limits, EDD questions and a re-screen cadence; code clamps all of it to the tier band and the analyst's output never feeds back into the score.",
  ],
  [
    "How do I verify a verdict offline?",
    "Recover the signer of attestation.typedData + attestation.signature (EIP-712 domain CompliR v1, chainId 5042, the registry as verifyingContract) and compare with the attester address from /api/v1/health. The SDK does this in one call: CompliR.verifyAttestation(v.attestation).",
  ],
  [
    "What if yente or the RPC is down?",
    "Every evidence source runs behind a timeout. A source that fails is recorded as timeout_or_error in the decision record and is never silently treated as clean. If no RPC is configured, chain sources are skipped and the verdict says so. COMPLIR_PAUSED is a kill switch that returns 503 and makes no charge.",
  ],
  [
    "Mainnet or testnet?",
    "Arc mainnet (chain id 5042). Nothing on this site is mocked: the example addresses are a real sanctioned wallet (the Ronin Bridge exploiter, on the OFAC SDN and JP MOF lists - read-only, we never pay it) and our own live attester / treasury wallet. The hero lattice, the timing readouts and the live verdict all come from the ledger and the Trust Map on Arc.",
  ],
];

/* ─── Small pieces ─────────────────────────────────────────────────────── */

function SecBar({ n, label, meta }: { n: string; label: string; meta?: string }) {
  return (
    <div className="sec-bar">
      <span className="sec-n">{n}</span>
      <span>{label}</span>
      {meta && <span className="sec-meta">{meta}</span>}
    </div>
  );
}

function SpecTile({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        <span className="stat-unit">{unit}</span>
      </span>
    </div>
  );
}

function Pixels({ on, total = 8 }: { on: number; total?: number }) {
  return (
    <span className="pixels" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={`px ${i < on ? "on" : ""}`} />
      ))}
    </span>
  );
}

/* ─── Page ─────────────────────────────────────────────────────────────── */

export default function Landing() {
  return (
    <div className={styles.page}>
      {/* 1. Hero */}
      <section className={`${styles.section} ${styles.hero}`}>
        <div className={styles.heroGrid}>
        <div className={styles.heroText}>
        <p className="kicker">
          <span className="live-dot" aria-hidden="true" />
          Counterparty risk oracle · Arc mainnet {CHAIN_ID} · USDC
        </p>
        <h1 className={styles.h1}>
          The risk layer money on Arc <em className="grad">runs</em> on.
        </h1>
        <p className={styles.sub}>
          One call before every payment. Deterministic score, signed EIP-712 verdict, mirrored on-chain, re-graded on a cadence, replayable from a hash-chained
          log. Run end to end by an agent. Never holds funds.
        </p>
        <div className={styles.ctas}>
          <Link href="/app" className="btn btnPrimary btnLg">Launch App</Link>
          <Link href="/company" className="btn btnLg">Meet the operator</Link>
          <Link href="/check" className={styles.ctaText}>Check an address →</Link>
          <Link href="/map" className={styles.ctaText}>Arc, live →</Link>
          <Link href="/payouts" className={styles.ctaText}>Watch an agent pay safely →</Link>
        </div>
        </div>
        <div className={styles.heroArt}><HeroLattice /></div>
        </div>
        <div className={`stats ${styles.stats}`}>
          <LiveNumbers />
          <SpecTile label="Hops traced" value="2" unit="upstream" />
          <SpecTile label="Settlement" value="<1" unit="s · x402" />
          <SpecTile label="Price" value="0.01" unit="USDC / screen" />
        </div>
      </section>

      {/* 2. Pipeline */}
      <section className={`${styles.section} reveal`}>
        <SecBar n="01" label="Pipeline" meta="POST /api/v1/screen" />
        <h2 className={styles.h2}>
          Evidence in. <em className="grad">Signed</em> verdict out.
        </h2>
        <TimingDiagram fig={{ n: "02", label: "Pipeline timing" }} />
        <ol className={`rail ${styles.steps}`}>
          {STEPS.map((s) => (
            <li key={s.n} className={styles.step}>
              <span className="rail-n">{s.n}</span>
              <div className={styles.stepHead}>
                <h3 className={styles.stepTitle}>{s.title}</h3>
                <span className={styles.stepSpec}>{s.spec}</span>
              </div>
              <p className={styles.stepBody}>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* 3. Problem */}
      <section className={`${styles.section} reveal`}>
        <SecBar n="02" label="Failure modes" meta="status quo" />
        <h2 className={styles.h2}>Screening today is a yes/no at payment time.</h2>
        <p className={styles.lead}>
          A denylist lookup, one hop deep, checked once, never re-checked, from a vendor whose reasoning you cannot reproduce. An agent that pays a hundred
          suppliers a day inherits every one of those blind spots.
        </p>
        <dl className={styles.fails}>
          <div>
            <dt className={styles.failK}>one hop</dt>
            <dd>The payee is clean; the wallet that funded it was funded by a sanctioned one. Nobody looked.</dd>
          </div>
          <div>
            <dt className={styles.failK}>one moment</dt>
            <dd>A payee graded LOW in March is paid in October on March&apos;s answer.</dd>
          </div>
          <div>
            <dt className={styles.failK}>one bit</dt>
            <dd>Allow or deny. No limits, no questions, no path for a legitimate new counterparty to prove itself.</dd>
          </div>
          <div>
            <dt className={styles.failK}>black box</dt>
            <dd>The verdict cannot be verified, replayed, or checked by a contract before funds move.</dd>
          </div>
        </dl>
        <p className={styles.aside}>
          Athens once banned every Megarian from its markets with a single decree and no appeal. Modern denylists are not much more granular. CompliR grades,
          limits, asks, and re-grades instead.
        </p>
      </section>

      {/* 4. Live demo */}
      <section className={`${styles.section} reveal`}>
        <SecBar n="03" label="Live verdict" meta="sanctioned wallet · real pipeline" />
        <h2 className={styles.h2}>
          Screened <em className="grad">seconds</em> ago.
        </h2>
        <p className={styles.lead}>
          This page just screened a real sanctioned wallet (the Ronin Bridge exploiter, OFAC SDN) through the real pipeline. Dial, reasons with evidence, 2-hop funder graph, analyst rationale, signed
          attestation.
        </p>
        <Fig n="03" label="Live verdict" live meta="verdict · live · clientId web-landing · depth 2 · x402" className={styles.sheet}>
          <div className={styles.sheetBody}>
            <LiveDemo />
          </div>
        </Fig>
      </section>

      {/* 5. Anatomy */}
      <section className={`${styles.section} reveal`}>
        <SecBar n="04" label="Verdict anatomy" meta="one JSON object" />
        <h2 className={styles.h2}>Nine fields. Each one actionable.</h2>
        <dl className={`dl ${styles.anatomy}`}>
          {ANATOMY.map(([k, v]) => (
            <div key={k}>
              <dt>
                <code>{k}</code>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.asideMono}>
          Full shape and reason codes in the <Link href="/docs">docs</Link>.
        </p>
      </section>

      {/* 6. Integration */}
      <section className={`${styles.section} reveal`}>
        <SecBar n="05" label="Integration" meta="HTTP · SDK · Solidity · MCP" />
        <h2 className={styles.h2}>One line in your stack.</h2>
        <div className={styles.three}>
          <div className={`card ${styles.codeCard}`}>
            <span className="kicker">agents</span>
            <p className={styles.codeNote}>Any x402-aware HTTP client. No API key.</p>
            <pre><code>{CURL}</code></pre>
          </div>
          <div className={`card ${styles.codeCard}`}>
            <span className="kicker">treasuries</span>
            <p className={styles.codeNote}><code>@complir/sdk</code> with offline attestation verification.</p>
            <pre><code>{SDK}</code></pre>
          </div>
          <div className={`card ${styles.codeCard}`}>
            <span className="kicker">contracts</span>
            <p className={styles.codeNote}><code>ICompliR.sol</code> against AttestationRegistry on Arc.</p>
            <pre><code>{SOL}</code></pre>
          </div>
        </div>
      </section>

      {/* 7. Products */}
      <section className={`${styles.section} reveal`}>
        <SecBar n="06" label="Products" meta="all backed by the public API" />
        <h2 className={styles.h2}>Six surfaces, one oracle.</h2>
        <div className={styles.products} role="list">
          {PRODUCTS.map((p, i) => (
            <Link key={p.href} href={p.href} className={styles.product} role="listitem">
              <span className={styles.productN}>{String(i + 1).padStart(2, "0")}</span>
              <span className={styles.productPx}>
                <Pixels on={p.px} />
              </span>
              <span className={styles.productMain}>
                <h3 className={styles.productTitle}>
                  {p.title}
                  <span className="tag">{p.tag}</span>
                </h3>
                <p className={styles.productBody}>{p.body}</p>
              </span>
              <span className={styles.productStat}>{p.stat}</span>
              <span className={styles.productGo}>{p.href} →</span>
            </Link>
          ))}
        </div>
      </section>

      {/* 8. Properties */}
      <section className={`${styles.section} reveal`}>
        <SecBar n="07" label="Properties" meta="not another black box" />
        <h2 className={styles.h2}>
          Anyone can <em className="grad">check</em> the work.
        </h2>
        <dl className={styles.props}>
          {DIFFERENT.map((d, i) => (
            <div key={d.title} className={styles.prop}>
              <dt className={styles.propTitle}>
                <span className={styles.propN}>{String(i + 1).padStart(2, "0")}</span>
                {d.title}
              </dt>
              <dd className={styles.propBody}>{d.body}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.asideMono}>
          Two hops, not one. Re-graded on a cadence the agent picks. Replay any decision at <Link href="/ledger">/ledger</Link>.
        </p>
      </section>

      {/* 9. The company */}
      <section className={`${styles.section} reveal`}>
        <SecBar n="08" label="The company" meta="operator · treasury · ledger" />
        <h2 className={styles.h2}>
          A company <em className="grad">run</em> by an agent.
        </h2>
        <p className={styles.lead}>
          CompliR is the first company on Arc run end to end by an agent. It sells risk screening, holds in Circle wallets, pays its contributors through a
          treasury that refuses tainted payees, and signs every decision into a ledger.
        </p>
        <Fig n="04" label="The company" meta="earns · holds · pays">
        <div className={styles.company}>
          <div className={styles.companyCol}>
            <span className="kicker"><b>earns</b> · x402 revenue</span>
            <dl className="dl">
              <div><dt>price</dt><dd className="mono">0.01 USDC / screen</dd></div>
              <div><dt>rail</dt><dd className="mono">x402 · Circle facilitator</dd></div>
              <div><dt>refunds</dt><dd className="mono">automatic on error / pause</dd></div>
              <div><dt>report</dt><dd className="mono">signed daily · <Link href="/report">/report</Link></dd></div>
            </dl>
          </div>
          <div className={styles.companyCol}>
            <span className="kicker"><b>holds</b> · Circle wallets</span>
            <dl className="dl">
              <div><dt>custody</dt><dd className="mono">developer-controlled wallets</dd></div>
              <div><dt>policy</dt><dd className="mono">per-tx · daily · allowlist</dd></div>
              <div><dt>idle</dt><dd className="mono">USYC sweep (operator decides)</dd></div>
              <div><dt>books</dt><dd className="mono">public · <Link href="/company">/company</Link></dd></div>
            </dl>
          </div>
          <div className={styles.companyCol}>
            <span className="kicker"><b>pays</b> · GuardedTreasury</span>
            <dl className="dl">
              <div><dt>gate</dt><dd className="mono">isAllowed(payee, MEDIUM)</dd></div>
              <div><dt>cap</dt><dd className="mono">attested maxPerTxUsdc</dd></div>
              <div><dt>held</dt><dd className="mono">HIGH · signed reason</dd></div>
              <div><dt>watch</dt><dd className="mono">live · <Link href="/payouts">/payouts</Link></dd></div>
            </dl>
          </div>
        </div>
        </Fig>
        <ul className={styles.builtList} aria-label="Built on Circle and Arc">
          <li><span className="chip">x402 facilitator</span><span>pay-per-call in USDC, no keys</span></li>
          <li><span className="chip">Circle wallets</span><span>agent wallets with spending policies</span></li>
          <li><span className="chip">Circle contracts</span><span>AttestationRegistry + GuardedTreasury</span></li>
          <li><span className="chip">USDC isBlacklisted</span><span>read from the token contract</span></li>
          <li><span className="chip chip-warn">Gateway / USYC</span><span>planned: idle revenue sweep</span></li>
        </ul>
      </section>

      {/* 10. Pricing */}
      <section className={`${styles.section} reveal`}>
        <SecBar n="09" label="Pricing" meta="x402 on Arc · first call returns 402" />
        <h2 className={styles.h2}>
          Pay per <em className="grad">call</em>. Nothing else.
        </h2>
        <Fig n="05" label="Price list" meta="USDC on Arc · settled by x402 in < 1 s" className={styles.priceWrap}>
          <table className={`table ${styles.priceTable}`}>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {PRICING.map((r) => (
                <tr key={r.endpoint}>
                  <td>
                    <span className={`mono ${styles.priceEp}`}>{r.endpoint}</span>
                    <span className={styles.priceWhat}>{r.what}</span>
                  </td>
                  <td className={styles.priceVal}>{r.price === "free" ? <span className="tag tag-acc">free</span> : <span className="mono">{r.price}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Fig>
        <p className={`alert alertInfo ${styles.aside}`}>
          <strong>Free for Tameion teams during the event.</strong> Send us a payee list and we will return a shadow report; integrate and screen for free until the deadline.
        </p>
      </section>

      {/* 11. FAQ */}
      <section className={`${styles.section} reveal`}>
        <SecBar n="10" label="FAQ" />
        <div className={styles.faq}>
          {FAQ.map(([q, a]) => (
            <details key={q} className={styles.faqItem}>
              <summary>
                <span>{q}</span>
                <span className={styles.faqMark} aria-hidden="true">+</span>
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* 12. Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <span className={styles.footerName}>CompliR</span>
            <p className={styles.footerLine}>
              Counterparty risk oracle for money moving on Arc. One call grades any recipient from on-chain
              history and sanctions data, signs the verdict so a contract can check it, and re-grades it as
              things change. Never holds funds.
            </p>
          </div>
          <nav className={styles.footerLinks} aria-label="Footer">
            <Link href="/app">Launch App</Link>
            <Link href="/company">Company</Link>
            <Link href="/map">Map</Link>
            <Link href="/tips">Tips</Link>
            <Link href="/report">Report</Link>
            <Link href="/payouts">Payouts</Link>
            <Link href="/check">Check</Link>
            <Link href="/shadow">Shadow</Link>
            <Link href="/badge">Badge</Link>
            <Link href="/ledger">Ledger</Link>
            <Link href="/docs">Docs</Link>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href="/api/v1/health" target="_blank" rel="noopener noreferrer">API health</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
