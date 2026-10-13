"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { TipsResponse } from "@/app/api/v1/tips/route";
import type { PublicTip, TipCategory, TipStatus, TipsTickResult } from "@/lib/tips";
import { HexLink } from "@/components/HexLink";
import { TierBadge } from "@/components/TierBadge";
import { HttpError, apiFetch, fmtRelative, fmtTime, postJson } from "@/components/api";
import styles from "./TipMarket.module.css";

const REFRESH_MS = 15_000;
const STATUS_CLASS: Record<TipStatus, string> = { PAID: "badgeLOW", VERIFIED: "badgeLOW", NEEDS_REVIEW: "badgeMEDIUM", SUBMITTED: "badgeNeutral", VERIFYING: "badgeNeutral", REJECTED: "badgeHIGH", SLASHED: "badgeHIGH" };
const CATEGORY_LABEL: Record<TipCategory, string> = { sanctions: "Sanctions link", mixer: "Mixer / tumbler", scam: "Scam / fraud", poisoning: "Address poisoning", stolen_funds: "Stolen funds", other: "Other" };

function errMsg(e: unknown): string {
  return e instanceof HttpError ? `${e.code}: ${e.message}${e.details ? ` ${JSON.stringify(e.details)}` : ""}` : e instanceof Error ? e.message : String(e);
}
const usdc = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC`;

export function TipMarket() {
  const [data, setData] = useState<TipsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(
    () =>
      apiFetch<TipsResponse>("/api/v1/tips")
        .then((d) => { setData(d); setError(null); setUpdatedAt(Date.now()); })
        .catch((e: unknown) => setError(errMsg(e))),
    [],
  );
  useEffect(() => {
    void load();
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const c = data?.config;
  const live = c ? c.payoutMode !== "dry-run" : false;
  const explorer = c?.explorerUrl ?? "";

  return (
    <div className="container">
      <div className={styles.head}>
        <div>
          <p className="kicker">oracle · tip market · x402 stake</p>
          <h1>Tip Market — earn USDC for risk intelligence</h1>
          <p className="muted">
            Seen an address linked to sanctions, a mixer, a scam, address poisoning or stolen funds? Tell CompliR, stake a little USDC, get paid when the
            tip verifies. Verified tips feed every verdict the oracle issues from then on.
          </p>
        </div>
        <span className={`${styles.modeBadge} ${live ? styles.modeLive : styles.modeDry}`} title={c?.payoutReason ?? ""}>
          <span className={styles.dot} aria-hidden="true" />
          {c ? (live ? `PAYOUTS LIVE (${c.payoutMode})` : "PAYOUTS DRY-RUN") : "…"}
        </span>
      </div>

      {error && <div className="alert alertError" role="alert">Could not load the market: {error}</div>}

      <HowItWorks data={data} />
      <Totals data={data} />

      <div className={styles.grid}>
        <div className="card">
          <SubmitForm data={data} onDone={load} />
        </div>
        <div>
          <Leaderboard data={data} />
          <div className="card" style={{ marginTop: 16 }}>
            <RunVerifier onDone={load} />
          </div>
        </div>
      </div>

      <TipsTable data={data} explorer={explorer} />
      <p className="muted small" style={{ marginTop: 8 }} aria-live="polite">
        {updatedAt ? `Updated ${fmtRelative(updatedAt)}` : "Loading…"} · refreshes every 15s · verifier runs every 5 min (worker/tips.ts or cron → /api/internal/tips)
      </p>

      <section className={`card ${styles.explain}`}>
        <h2>How a tip is verified</h2>
        <p style={{ marginTop: 8 }}>
          No judgement calls: the agent <strong>re-screens the subject</strong> through the normal CompliR pipeline (sanctions, USDC blocklist, funder graph —
          logged as a replayable <code>RESCREEN</code>), then checks the evidence. A tx hash that exists on Arc <em>and touches the subject</em> is strong corroboration;
          so is a URL on an official list ({c?.strongDomains.join(", ") ?? "OFAC, OpenSanctions, EU, UK"}). Anything else is weak.
        </p>
        <ul style={{ marginTop: 8, paddingLeft: 20 }}>
          <li><span className="badge badgeLOW">VERIFIED</span> re-screen is <TierBadge tier="HIGH" size="sm" />, or <TierBadge tier="MEDIUM" size="sm" /> with at least one strong corroboration → bounty paid.</li>
          <li><span className="badge badgeHIGH">SLASHED</span> re-screen is <TierBadge tier="LOW" size="sm" /> and the tip carries no corroboration → the stake is kept.</li>
          <li><span className="badge badgeMEDIUM">NEEDS_REVIEW</span> everything in between → a human decides via <code>POST /api/internal/tips {"{"}review, decision{"}"}</code>.</li>
        </ul>
        <p className="muted small" style={{ marginTop: 8 }}>
          Bounty = base {c ? usdc(c.bountyUsdc) : "0.25 USDC"} × category multiplier (sanctions ×2, poisoning ×1.5) × reputation factor (0.5 → 1.0). Every submit,
          verdict, payout and slash is a <code>TIP</code> entry in the hash-chained <Link href="/ledger">decision ledger</Link>. Submitters never see client data —
          only tier, score, reason codes and the re-screen id. Submitters are shown anonymised. Daily payout cap {c ? usdc(c.dailyCapUsdc) : "5 USDC"}.
        </p>
        <pre><code>{`# stake 0.05 USDC via x402 (the payment IS the stake) — any x402 client
curl -X POST https://<your-complir-host>/api/v1/tips \\
  -H 'Content-Type: application/json' -H 'PAYMENT-SIGNATURE: <base64 x402 v2 payload>' \\
  -d '{"subject":"0x…","category":"sanctions","claim":"…","evidenceUrls":["https://sanctionssearch.ofac.treas.gov/…"],"evidenceTxs":["0x…"]}'`}</code></pre>
      </section>
    </div>
  );
}

function HowItWorks({ data }: { data: TipsResponse | null }) {
  const c = data?.config;
  return (
    <div className={styles.steps}>
      <div className={styles.step}>
        <div className={styles.stepNum}>1</div>
        <div className={styles.stepTitle}>Submit + stake <span className={styles.stepAmount}>{c ? usdc(c.stakeUsdc) : "0.05 USDC"}</span></div>
        <div className="muted small">Address, category, what you saw, evidence (tx hashes, URLs). The x402 payment is the stake — no account, no form.</div>
      </div>
      <div className={styles.step}>
        <div className={styles.stepNum}>2</div>
        <div className={styles.stepTitle}>Verified pays <span className={styles.stepAmount}>{c ? `~${usdc(c.bountyRange.min)}–${usdc(c.bountyRange.max)}` : "~0.25–0.5 USDC"}</span></div>
        <div className="muted small">The agent re-screens the address and checks your evidence. Verified → bounty paid in USDC on Arc to the wallet that staked, the same day.</div>
      </div>
      <div className={styles.step}>
        <div className={styles.stepNum}>3</div>
        <div className={styles.stepTitle}>Bad tips lose the stake</div>
        <div className="muted small">LOW re-screen with no corroboration → stake kept, reputation down. Good tipsters earn up to 2× the base bounty.</div>
      </div>
    </div>
  );
}

function Totals({ data }: { data: TipsResponse | null }) {
  const t = data?.totals;
  const c = data?.config;
  const cell = (label: string, value: string, sub?: string) => (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  );
  const open = t ? t.byStatus.SUBMITTED + t.byStatus.VERIFYING + t.byStatus.NEEDS_REVIEW : 0;
  return (
    <div className={styles.totals}>
      {cell("Verified", t ? String(t.byStatus.VERIFIED + t.byStatus.PAID) : "—", t ? `${t.byStatus.PAID} paid` : undefined)}
      {cell("Slashed", t ? String(t.byStatus.SLASHED + t.byStatus.REJECTED) : "—", t ? `${usdc(t.slashedUsdc)} kept` : undefined)}
      {cell("Paid out", t ? usdc(t.paidUsdc) : "—", c ? `${usdc(c.spentTodayUsdc)} of ${usdc(c.dailyCapUsdc)} today` : undefined)}
      {cell("Open", t ? String(open) : "—", t ? `${t.byStatus.NEEDS_REVIEW} need review · ${t.total} total` : undefined)}
    </div>
  );
}

interface SubmitResponse { tip: PublicTip; demo: boolean; note: string; next: string }

function SubmitForm({ data, onDone }: { data: TipsResponse | null; onDone: () => Promise<void> }) {
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<TipCategory>("scam");
  const [claim, setClaim] = useState("");
  const [urls, setUrls] = useState("");
  const [txs, setTxs] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SubmitResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const demoSubject = data?.config.demoSubject ?? "0x000000000000000000000000000000000000dead";

  const submit = async (payload: { subject: string; category: TipCategory; claim: string; evidenceUrls: string[]; evidenceTxs: string[] }) => {
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await postJson<SubmitResponse>("/api/v1/tips", payload);
      setRes(r);
      await onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const split = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    void submit({ subject: subject.trim(), category, claim: claim.trim(), evidenceUrls: split(urls), evidenceTxs: split(txs) });
  };
  const demo = () => {
    setSubject(demoSubject); setCategory("sanctions"); setUrls("https://sanctionssearch.ofac.treas.gov/"); setTxs("");
    const text = "Demo tip: this wallet appears on a sanctions list and is USDC-blocklisted (synthetic demo entry in .data/overrides.json).";
    setClaim(text);
    void submit({ subject: demoSubject, category: "sanctions", claim: text, evidenceUrls: ["https://sanctionssearch.ofac.treas.gov/"], evidenceTxs: [] });
  };

  return (
    <div>
      <h2>Submit a tip</h2>
      <p className="muted small">
        From this page tips are <strong>unstaked demo tips</strong> (no wallet, no payout address): they are verified like any other, but a verified bounty is only
        recorded. API clients stake {data ? usdc(data.config.stakeUsdc) : "0.05 USDC"} via x402 and get paid to the staking wallet.
      </p>
      <form className={styles.form} onSubmit={onSubmit}>
        <div className={styles.row}>
          <div>
            <label className={styles.label} htmlFor="tip-subject">Address</label>
            <input id="tip-subject" className="input mono" placeholder="0x…" value={subject} onChange={(e) => setSubject(e.target.value)} required pattern="^0x[0-9a-fA-F]{40}$" autoComplete="off" />
          </div>
          <div>
            <label className={styles.label} htmlFor="tip-category">Category</label>
            <select id="tip-category" className="input" value={category} onChange={(e) => setCategory(e.target.value as TipCategory)}>
              {(data?.config.categories ?? Object.keys(CATEGORY_LABEL)).map((k) => (
                <option key={k} value={k}>{CATEGORY_LABEL[k as TipCategory] ?? k} {data ? `(×${data.config.categoryMultiplier[k] ?? 1})` : ""}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={styles.label} htmlFor="tip-claim">What did you see? (10–2000 chars)</label>
          <textarea id="tip-claim" className={`input ${styles.textarea}`} value={claim} onChange={(e) => setClaim(e.target.value)} minLength={10} maxLength={2000} required placeholder="e.g. Received USDC from a wallet named in the OFAC SDN update of … ; tx 0x… moved funds into a known mixer." />
        </div>
        <div className={styles.row}>
          <div>
            <label className={styles.label} htmlFor="tip-urls">Evidence URLs (≤5, one per line)</label>
            <textarea id="tip-urls" className={`input ${styles.textarea}`} style={{ minHeight: 60 }} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://sanctionssearch.ofac.treas.gov/…" />
          </div>
          <div>
            <label className={styles.label} htmlFor="tip-txs">Evidence tx hashes on Arc (≤10, one per line)</label>
            <textarea id="tip-txs" className={`input mono ${styles.textarea}`} style={{ minHeight: 60 }} value={txs} onChange={(e) => setTxs(e.target.value)} placeholder="0x…" />
          </div>
        </div>
        <div className={styles.actions}>
          <button type="submit" className="btn btnPrimary" disabled={busy}>{busy ? "Submitting…" : "Submit demo tip (stake 0)"}</button>
          <button type="button" className="btn" onClick={demo} disabled={busy} title={`Submits a sanctions tip about ${demoSubject} (synthetic HIGH)`}>Demo: tip about {demoSubject.slice(0, 6)}…{demoSubject.slice(-4)}</button>
        </div>
      </form>
      {err && <div className={`alert alertError ${styles.result}`} role="alert">{err}</div>}
      {res && (
        <div className={`alert alertInfo ${styles.result}`} role="status">
          <strong>Submitted <code>{res.tip.id}</code></strong> as <code>{res.tip.submitter}</code> · {res.note} {res.next}
        </div>
      )}
    </div>
  );
}

function Leaderboard({ data }: { data: TipsResponse | null }) {
  const rows = data?.leaderboard ?? [];
  return (
    <div className="card">
      <h2>Leaderboard</h2>
      <p className="muted small">Anonymised submitters, ranked by verified tips. Reputation (0–1) scales the bounty.</p>
      {!data ? (
        <span className="skeleton" style={{ width: "80%", marginTop: 10 }} />
      ) : rows.length === 0 ? (
        <p className="muted" style={{ marginTop: 10 }}>No tipsters yet — be the first.</p>
      ) : (
        <div className="tableWrap" style={{ marginTop: 8 }}>
          <table className="table">
            <thead><tr><th>#</th><th>Tipster</th><th>Verified</th><th>Slashed</th><th>Earned</th><th>Rep.</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.submitter}>
                  <td className={styles.rank}>{i + 1}</td>
                  <td><code>{r.submitter}</code></td>
                  <td>{r.verified}</td>
                  <td>{r.rejected}</td>
                  <td>{usdc(r.earnedUsdc)}</td>
                  <td><span className={styles.rep} title={`reputation ${r.reputation}`}><span style={{ width: `${Math.round(r.reputation * 100)}%` }} /></span>{r.reputation.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RunVerifier({ onDone }: { onDone: () => Promise<void> }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TipsTickResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await apiFetch<TipsTickResult>("/api/internal/tips", { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
      setRes(r);
      await onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div>
      <h2>Run verifier now</h2>
      <p className="muted small">Dev convenience: one tick of <code>POST /api/internal/tips</code> with your <code>CRON_SECRET</code> — verifies submitted tips and pays verified ones.</p>
      <div className={styles.runRow}>
        <input className="input" type="password" placeholder="CRON_SECRET" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" aria-label="CRON_SECRET" />
        <button type="button" className="btn btnPrimary" onClick={() => void run()} disabled={busy || !secret}>{busy ? "Running…" : "Run verifier"}</button>
      </div>
      {err && <div className={`alert alertError ${styles.result}`} role="alert">{err}</div>}
      {res && (
        <div className={`alert alertInfo ${styles.result}`} role="status">
          <strong>{(res.payoutMode ?? "dry-run").toUpperCase()} tick:</strong> {res.verified} verified, {res.rejected} rejected, {res.needsReview} need review, {res.paid} paid{res.deferred ? `, ${res.deferred} deferred` : ""}{res.dropped ? `, ${res.dropped} dropped` : ""}{res.failed ? `, ${res.failed} failed` : ""}.
        </div>
      )}
    </div>
  );
}

function TipsTable({ data, explorer }: { data: TipsResponse | null; explorer: string }) {
  const items = data?.items ?? [];
  return (
    <div className="card">
      <h2>Recent tips</h2>
      {!data ? (
        <span className="skeleton" style={{ width: "100%", marginTop: 10 }} />
      ) : items.length === 0 ? (
        <p className="muted" style={{ marginTop: 10 }}>No tips yet.</p>
      ) : (
        <div className="tableWrap" style={{ marginTop: 8 }}>
          <table className="table">
            <thead><tr><th>When</th><th>Subject</th><th>Category</th><th>Claim</th><th>Status</th><th>Re-screen</th><th>Bounty</th><th>Tipster</th></tr></thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td title={fmtTime(t.createdAt)}>{fmtRelative(t.createdAt)}</td>
                  <td><HexLink value={t.subject} explorerUrl={explorer} /></td>
                  <td><span className={styles.cat}>{t.category}</span></td>
                  <td className={styles.claim} title={t.claim}>{t.claim.length > 90 ? `${t.claim.slice(0, 90)}…` : t.claim}{t.evidenceUrls.length + t.evidenceTxs.length > 0 && <span className="muted small"> · {t.evidenceUrls.length} url, {t.evidenceTxs.length} tx</span>}</td>
                  <td>
                    <span className={`badge ${STATUS_CLASS[t.status]}`} title={t.verdict?.reason ?? t.status}>{t.status}</span>
                    {t.verdict?.by === "human" && <span className="muted small"> (human)</span>}
                  </td>
                  <td>
                    {t.verdict?.tier ? <TierBadge tier={t.verdict.tier} size="sm" /> : <span className="muted">—</span>}
                    {t.verdict?.decisionId && <> <Link href={`/log/${t.verdict.decisionId}`} className="small">replay</Link></>}
                  </td>
                  <td>
                    {t.status === "PAID" ? <>{usdc(t.payoutUsdc)} {t.payoutTx ? <HexLink value={t.payoutTx} explorerUrl={explorer} /> : <span className="muted small">({t.payoutMode ?? "dry-run"})</span>}</>
                      : t.status === "VERIFIED" ? <>{usdc(t.payoutUsdc)} <span className="muted small">pending</span></>
                      : t.status === "SLASHED" ? <span className="muted">−{usdc(t.stakeUsdc)}</span>
                      : <span className="muted">—</span>}
                  </td>
                  <td><code>{t.submitter}</code>{t.demo && <span className="muted small"> demo</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
