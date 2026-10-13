"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PayoutsResponse } from "@/app/api/v1/payouts/route";
import type { Invoice, InvoiceStatus, TickResult } from "@/lib/treasury";
import { HexLink } from "@/components/HexLink";
import { TierBadge } from "@/components/TierBadge";
import { HttpError, apiFetch, fmtRelative, fmtTime, fmtUsdc, postJson, short } from "@/components/api";
import styles from "./PayoutsDashboard.module.css";

const REFRESH_MS = 15_000;

const STATUS_CLASS: Record<InvoiceStatus, string> = { PAID: "badgeLOW", LIMITED: "badgeMEDIUM", HELD: "badgeHIGH", FAILED: "badgeHIGH", PENDING: "badgeNeutral" };

function errMsg(e: unknown): string {
  return e instanceof HttpError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

export function PayoutsDashboard() {
  const [data, setData] = useState<PayoutsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(
    () =>
      apiFetch<PayoutsResponse>("/api/v1/payouts")
        .then((d) => { setData(d); setError(null); setUpdatedAt(Date.now()); })
        .catch((e: unknown) => setError(errMsg(e))),
    [],
  );
  useEffect(() => {
    void load();
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const s = data?.status;
  const live = data?.mode === "live";
  const explorer = s?.explorerUrl ?? "";

  return (
    <div className="container">
      <div className={styles.head}>
        <div>
          <p className="kicker">company · guarded payouts · GuardedTreasury</p>
          <h1>Guarded Payouts</h1>
          <p className="muted">A treasury agent that cannot pay a tainted address. Every payout is screened by CompliR; the contract enforces the verdict.</p>
        </div>
        <span className={`${styles.modeBadge} ${live ? styles.modeLive : styles.modeDry}`} title={live ? "Real USDC transfers via GuardedTreasury" : "Decisions are recorded, nothing is sent"}>
          <span className={styles.dot} aria-hidden="true" />
          {data ? (live ? `LIVE on Arc mainnet (${s?.chainId})` : "DRY-RUN") : "…"}
        </span>
      </div>

      {error && <div className="alert alertError" role="alert">Could not load payouts: {error}</div>}

      <Totals data={data} />

      <div className={styles.grid}>
        <PolicyCard data={data} explorer={explorer} />
        <div className="card">
          <AddInvoice onAdded={load} />
          <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />
          <RunAgent onDone={load} />
        </div>
      </div>

      <InvoiceTable data={data} explorer={explorer} />
      <p className="muted small" style={{ marginTop: 8 }} aria-live="polite">
        {updatedAt ? `Updated ${fmtRelative(updatedAt)}` : "Loading…"} · refreshes every 15s · agent runs every 60s (worker/treasury.ts or cron → /api/internal/treasury)
      </p>

      <section className={`card ${styles.explain}`}>
        <h2>Why the hold cannot be bypassed</h2>
        <p style={{ marginTop: 8 }}>
          The agent only <em>proposes</em> a payment. <code>GuardedTreasury.release(payee, amount)</code> asks the on-chain AttestationRegistry
          whether the payee&apos;s current CompliR tier is at most <code>MEDIUM</code> and still valid, and reverts otherwise. A HIGH-tier
          address has no valid attestation at or below that tier, so even a buggy, compromised or over-eager agent - or the treasury
          owner calling the contract by hand - cannot move the USDC. The decision is enforced by the contract, not by the agent&apos;s judgement.
        </p>
        <pre><code>{`// contracts/src/examples/GuardedTreasury.sol
function release(address payee, uint256 amount) external onlyOwner {
    require(compliR.isAllowed(payee, maxTier), "CompliR: payee tier too high"); // ← the whole integration
    (,, bytes32 decisionHash) = compliR.tierOf(payee);
    token.safeTransfer(payee, amount);
    emit Released(payee, amount, decisionHash);
}`}</code></pre>
        <p className="muted small" style={{ marginTop: 8 }}>
          Off-chain, the agent additionally caps MEDIUM payees to the analyst&apos;s recommended per-transaction limit and holds the remainder; every
          decision (including holds) is appended to the hash-chained <Link href="/ledger">decision ledger</Link> with the signed verdict.
        </p>
      </section>
    </div>
  );
}

function Totals({ data }: { data: PayoutsResponse | null }) {
  const t = data?.totals;
  const cell = (cls: string, label: string, value: string, sub?: string) => (
    <div className={`${styles.stat} ${cls}`}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  );
  return (
    <div className={styles.totals}>
      {cell(styles.statPaid, "Paid", t ? String(t.paid) : "-", "in full")}
      {cell(styles.statLimited, "Limited", t ? String(t.limited) : "-", "capped, rest held")}
      {cell(styles.statHeld, "Held", t ? String(t.held) : "-", "nothing sent")}
      {cell("", "USDC released", t ? fmtUsdc(t.paidUsdc) : "-", t ? `${fmtUsdc(t.heldUsdc)} held` : undefined)}
      {cell("", "Invoices", t ? String(t.count) : "-", t ? `${t.pending} pending${t.failed ? `, ${t.failed} failed` : ""}` : undefined)}
    </div>
  );
}

function PolicyCard({ data, explorer }: { data: PayoutsResponse | null; explorer: string }) {
  const s = data?.status;
  if (!s) return <div className="card" aria-busy="true"><span className="skeleton" style={{ width: "50%" }} /><span className="skeleton" style={{ width: "80%", marginTop: 8 }} /></div>;
  const p = s.policy;
  return (
    <div className="card">
      <h2>Policy</h2>
      <dl className={styles.kv}>
        <dt>Max tier paid</dt><dd><TierBadge tier={p.maxTier} size="sm" /> <span className="muted small">(HIGH is always held)</span></dd>
        <dt>Per payout cap</dt><dd>{fmtUsdc(p.perPayoutCapUsdc)}</dd>
        <dt>Daily cap</dt><dd>{fmtUsdc(p.dailyCapUsdc)}</dd>
        <dt>MEDIUM payees</dt><dd>capped to the analyst&apos;s recommended per-tx limit; remainder held</dd>
        <dt>Registry check</dt><dd>{p.requireAttestationOnChain ? "required - hold unless the Arc registry holds a valid attestation" : "off (dry-run); the contract still checks it in live mode"}</dd>
        <dt>Treasury</dt><dd>{s.treasuryAddress ? <HexLink value={s.treasuryAddress} explorerUrl={explorer} /> : <span className="muted">not deployed (GUARDED_TREASURY_ADDRESS)</span>}</dd>
        <dt>Agent key</dt><dd>{s.agentAddress ? <HexLink value={s.agentAddress} explorerUrl={explorer} /> : <span className="muted">unset (TREASURY_PRIVATE_KEY)</span>}</dd>
        <dt>Registry</dt><dd>{s.registryAddress ? <HexLink value={s.registryAddress} explorerUrl={explorer} /> : <span className="muted">unset (REGISTRY_ADDRESS)</span>}</dd>
        <dt>Token</dt><dd><HexLink value={s.usdcAddress} explorerUrl={explorer} /> <span className="muted small">USDC, 6 dp</span></dd>
      </dl>
      {s.mode !== "live" && (
        <p className="muted small" style={{ marginTop: 10 }}>
          Dry-run: verdicts, decisions and the ledger are real; transfers are simulated. Missing for live: <code>{s.missingForLive.join(", ")}</code>.
        </p>
      )}
    </div>
  );
}

function AddInvoice({ onAdded }: { onAdded: () => Promise<void> }) {
  const [payee, setPayee] = useState("");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await postJson<{ invoice: Invoice }>("/api/v1/payouts", { payee: payee.trim(), label: label.trim(), amountUsdc: Number(amount) });
      setMsg({ ok: true, text: `Queued ${r.invoice.label} (${fmtUsdc(r.invoice.amountUsdc)}) - pending until the next agent run.` });
      setPayee(""); setLabel(""); setAmount("");
      await onAdded();
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) });
    } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit}>
      <h2>Add invoice</h2>
      <p className="muted small">Any Arc address. Try our own wallet <code>0xc742…960c</code> (LOW, pays out) or the sanctioned Ronin exploiter <code>0x098b…2f96</code> (HIGH, held).</p>
      <div className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="payee">Payee address</label>
          <input id="payee" className="input mono" required pattern="^0x[0-9a-fA-F]{40}$" placeholder="0x…" value={payee} onChange={(e) => setPayee(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className={styles.field}>
          <label htmlFor="label">Label</label>
          <input id="label" className="input" required maxLength={80} placeholder="Vendor - what for" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label htmlFor="amount">USDC</label>
          <input id="amount" className="input" required type="number" min="0.000001" step="0.000001" placeholder="10" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <button type="submit" className="btn btnPrimary" disabled={busy}>{busy ? "Adding…" : "Add"}</button>
      </div>
      {msg && <div className={`alert ${msg.ok ? "alertInfo" : "alertError"} ${styles.result}`} role="status">{msg.text}</div>}
    </form>
  );
}

function RunAgent({ onDone }: { onDone: () => Promise<void> }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TickResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await apiFetch<TickResult>("/api/internal/treasury", { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
      setRes(r);
      await onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div>
      <h2>Run agent now</h2>
      <p className="muted small">Dev convenience: triggers one tick of <code>POST /api/internal/treasury</code> with your <code>CRON_SECRET</code>. Pending invoices are screened and settled.</p>
      <div className={styles.runRow}>
        <input className="input" type="password" placeholder="CRON_SECRET" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" aria-label="CRON_SECRET" />
        <button type="button" className="btn btnPrimary" onClick={() => void run()} disabled={busy || !secret}>{busy ? "Running…" : "Run agent now"}</button>
      </div>
      {err && <div className={`alert alertError ${styles.result}`} role="alert">{err}</div>}
      {res && (
        <div className={`alert alertInfo ${styles.result}`} role="status">
          <strong>{res.mode === "live" ? "LIVE" : "DRY-RUN"} tick:</strong> {res.processed} processed - {res.paid} paid, {res.limited} limited, {res.held} held{res.failed ? `, ${res.failed} failed` : ""}.
          {res.results.length > 0 && (
            <ul>
              {res.results.map((x) => (
                <li key={x.invoiceId}><span className={`badge ${STATUS_CLASS[x.status]}`}>{x.status}</span> {x.label}: {fmtUsdc(x.paidUsdc)} released{x.heldUsdc > 0 ? `, ${fmtUsdc(x.heldUsdc)} held` : ""}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function InvoiceTable({ data, explorer }: { data: PayoutsResponse | null; explorer: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Payee</th>
              <th>Amount</th>
              <th>Paid / held</th>
              <th>Tier</th>
              <th>Reason</th>
              <th>Decision</th>
              <th>Tx</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {!data && <tr><td colSpan={9}><span className="skeleton" /></td></tr>}
            {data && data.items.length === 0 && <tr><td colSpan={9} className="muted">No invoices yet.</td></tr>}
            {data?.items.map((it) => (
              <tr key={it.id}>
                <td><span className={`badge ${STATUS_CLASS[it.status]}`}>{it.status}</span></td>
                <td>
                  <div>{it.label}</div>
                  <div className="small"><HexLink value={it.payee} explorerUrl={explorer} /></div>
                </td>
                <td className="mono">{fmtUsdc(it.amountUsdc)}</td>
                <td>
                  {it.status === "PENDING" ? <span className="muted">-</span> : (
                    <>
                      <div className="mono">{fmtUsdc(it.paidUsdc)}</div>
                      {it.heldUsdc > 0 && <div className={`${styles.split} ${styles.splitHeld}`}>{fmtUsdc(it.heldUsdc)} held</div>}
                    </>
                  )}
                </td>
                <td>{it.tier ? <><TierBadge tier={it.tier} size="sm" /> <span className="mono small">{it.score}</span></> : <span className="muted">-</span>}</td>
                <td className={styles.reason}>
                  {it.reason ? (
                    <>
                      <div className={open[it.id] ? styles.reasonOpen : styles.reasonText}>{it.reason}</div>
                      {it.reason.length > 120 && <button type="button" className={styles.toggle} onClick={() => toggle(it.id)} aria-expanded={!!open[it.id]}>{open[it.id] ? "Show less" : "Show more"}</button>}
                    </>
                  ) : <span className="muted">awaiting agent</span>}
                </td>
                <td>
                  {it.decisionId ? (
                    <>
                      <Link href={`/log/${encodeURIComponent(it.decisionId)}`} className="mono small" title="Screening verdict (SCREEN)">{short(it.decisionId, 10, 4)}</Link>
                      {it.payoutDecisionId && <div><Link href={`/log/${encodeURIComponent(it.payoutDecisionId)}`} className="small muted" title="Payout decision (PAYOUT)">payout entry</Link></div>}
                    </>
                  ) : <span className="muted">-</span>}
                </td>
                <td>
                  {it.txHash ? <HexLink value={it.txHash} explorerUrl={explorer} /> : it.status === "PENDING" ? <span className="muted">-</span> : it.paidUsdc > 0 && it.mode !== "live" ? <span className="muted" title="Dry-run: no transaction was sent">simulated</span> : <span className="muted">none</span>}
                </td>
                <td title={fmtTime(it.decidedAt ?? it.createdAt)}>{fmtRelative(it.decidedAt ?? it.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
