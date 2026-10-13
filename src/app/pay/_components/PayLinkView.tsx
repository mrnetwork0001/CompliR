"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { PayLinkMerchant, PayLinkPublic } from "@/lib/paylinks";
import { encodeQr, qrSvgPath } from "@/lib/qr";
import { CopyButton } from "@/components/CopyButton";
import { TierBadge } from "@/components/TierBadge";
import { ADDR_RE, HttpError, apiFetch, fmtRelative, fmtTime, postJson } from "@/components/api";
import styles from "./pay.module.css";

type View = PayLinkPublic | PayLinkMerchant;
const isMerchant = (v: View): v is PayLinkMerchant => "merchantUrl" in v;
function errMsg(e: unknown): string {
  return e instanceof HttpError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

function fetchLink(id: string, key: string): Promise<View> {
  return apiFetch<View>(`/api/v1/pay/${id}${key ? `?key=${encodeURIComponent(key)}` : ""}`);
}

function QrSvg({ text }: { text: string }) {
  const q = useMemo(() => { try { return qrSvgPath(encodeQr(text)); } catch { return null; } }, [text]);
  if (!q) return null;
  return (
    <svg className={styles.qr} viewBox={`0 0 ${q.size} ${q.size}`} shapeRendering="crispEdges" role="img" aria-label="QR code of the payment link">
      <path d={q.path} />
    </svg>
  );
}

export function PayLinkView({ id, from, merchantKey }: { id: string; from: string; merchantKey: string }) {
  const [link, setLink] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payer, setPayer] = useState(from);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => fetchLink(id, merchantKey).then((v) => { setLink(v); setError(null); }, (e: unknown) => setError(errMsg(e))), [id, merchantKey]);
  useEffect(() => {
    let alive = true;
    fetchLink(id, merchantKey).then((v) => { if (alive) { setLink(v); setError(null); } }, (e: unknown) => { if (alive) setError(errMsg(e)); });
    return () => { alive = false; };
  }, [id, merchantKey]);

  async function screenNow(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { setLink(await postJson<View>(`/api/v1/pay/${id}/screen`, { from: payer.trim() })); if (merchantKey) await load(); }
    catch (err) { setError(errMsg(err)); }
    finally { setBusy(false); }
  }
  async function decide(action: "accept" | "decline") {
    setBusy(true); setError(null);
    try { setLink(await postJson<View>(`/api/v1/pay/${id}/decide`, { key: merchantKey, action })); }
    catch (err) { setError(errMsg(err)); }
    finally { setBusy(false); }
  }

  if (!link) {
    return (
      <div className={`container ${styles.wrap}`}>
        {error ? <div className="alert alertError" role="alert">{error}</div> : <p className="muted">Loading payment link…</p>}
      </div>
    );
  }

  const merchantView = isMerchant(link);
  const canScreen = (link.status === "OPEN" || link.status === "SCREENED") && !merchantView;
  const tier = link.payerTier;

  return (
    <div className={`container ${styles.wrap}`}>
      <div className="pageHead">
        <div>
          <p className="small muted">CompliR · payment request · {merchantView ? "merchant view" : "payer view"} · <span className={styles[`s_${link.status}`]}>{link.status}</span></p>
          <h1>{link.merchant} requests a payment</h1>
          <p className="muted">
            {merchantView
              ? "Screen the payer before you accept: the tier below is the wallet your customer declared they will send from."
              : "Before this merchant accepts your payment, CompliR screens the wallet you will send from. Only a clean wallet is shown the destination."}
          </p>
        </div>
      </div>

      <p className={styles.amount}>{link.amountUsdc.toLocaleString(undefined, { maximumFractionDigits: 6 })}<span className={styles.unit}>USDC · Arc</span></p>
      <dl className="dl">
        {link.memo && <div><dt>Memo</dt><dd>{link.memo}</dd></div>}
        <div><dt>Link</dt><dd className="mono">{link.id}</dd></div>
        <div><dt>Expires</dt><dd>{fmtRelative(link.expiresAt)} · {fmtTime(link.expiresAt)}</dd></div>
        {link.payerAddress && (
          <div><dt>Payer wallet</dt><dd className="mono"><span className={styles.tierRow}>{link.payerAddress} {tier && <TierBadge tier={tier} size="sm" />}{merchantView && link.payerScore != null && <span className="muted">score {link.payerScore}</span>}</span></dd></div>
        )}
        {merchantView && link.payerDecisionId && (
          <div><dt>Decision</dt><dd className="mono"><Link href={`/log/${link.payerDecisionId}`}>{link.payerDecisionId}</Link> · <Link href={`/a/${link.payerAddress}`}>full report</Link></dd></div>
        )}
        {link.payerEddUrl && <div><dt>Due diligence</dt><dd className="mono"><a href={link.payerEddUrl}>{link.payerEddUrl}</a></dd></div>}
        {merchantView && <div><dt>Payer link</dt><dd className="mono"><span className={styles.linkRow}>{link.url}<CopyButton text={link.url} /></span></dd></div>}
      </dl>

      {error && <div className="alert alertError" role="alert" style={{ marginTop: 14 }}>{error}</div>}

      {/* ── payer: declare the sending wallet ── */}
      {canScreen && (
        <form onSubmit={screenNow} className={styles.section}>
          <div className="sec-bar"><span className="sec-n">01</span><span>{link.status === "OPEN" ? "Your wallet" : "Screen a different wallet"}</span><span className="sec-meta">POST /api/v1/pay/{id}/screen</span></div>
          <div className={styles.form}>
            <div className={`${styles.field} ${styles.full}`}>
              <label htmlFor="pay-from">Address you will send from</label>
              <input id="pay-from" className="input mono" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="0x…" pattern="^0x[0-9a-fA-F]{40}$" spellCheck={false} required />
            </div>
            <div className={`${styles.actions} ${styles.full}`}>
              <button type="submit" className="btn btnPrimary" disabled={busy || !ADDR_RE.test(payer.trim())}>{busy ? "Screening…" : "Screen my wallet"}</button>
              <span className="small muted">One screen, a few seconds. The verdict is signed and logged.</span>
            </div>
          </div>
        </form>
      )}

      {/* ── outcome ── */}
      {link.status !== "OPEN" && <Outcome link={link} merchantView={merchantView} />}

      {/* ── merchant actions ── */}
      {merchantView && link.status === "SCREENED" && (
        <div className={styles.actions} style={{ marginTop: 18 }}>
          <button type="button" className="btn btnPrimary" disabled={busy} onClick={() => decide("accept")}>Accept payment</button>
          <button type="button" className="btn" disabled={busy} onClick={() => decide("decline")}>Decline</button>
          <span className="small muted">{tier === "LOW" ? "LOW payers already see the instructions; accepting only records your decision." : "Accepting shows the payer the payment instructions."}</span>
        </div>
      )}

      <p className={`small muted ${styles.foot}`}>
        Created {fmtTime(link.createdAt)}{link.screenedAt && ` · screened ${fmtTime(link.screenedAt)}`}{link.decidedAt && ` · decided ${fmtTime(link.decidedAt)}`} · chain {link.chainId}
      </p>
    </div>
  );
}

function Outcome({ link, merchantView }: { link: View; merchantView: boolean }) {
  const tier = link.payerTier;
  if (link.status === "EXPIRED") return <p className={styles.verdictLine}>This payment link has expired. Ask the merchant for a new one.</p>;
  if (link.status === "DECLINED") {
    return (
      <div className={styles.section}>
        <div className="sec-bar"><span className="sec-n">02</span><span>Declined</span></div>
        <p className={styles.verdictLine}>
          {tier === "HIGH" ? "CompliR rated this wallet HIGH risk. The merchant cannot accept a payment from it." : "The merchant declined this payment."}
        </p>
        {link.payerAddress && <p className="small muted">Why: <Link href={`/a/${link.payerAddress}`}>public verdict for {link.payerAddress}</Link>{link.payerEddUrl && <> · <a href={link.payerEddUrl}>answer the due-diligence questions</a></>}</p>}
      </div>
    );
  }
  if (link.paymentUri) {
    return (
      <div className={styles.section}>
        <div className="sec-bar"><span className="sec-n">02</span><span>Payment instructions</span><span className="sec-meta">EIP-681 · native USDC · chain {link.chainId}</span></div>
        <div className={styles.instr}>
          <div>
            <p className={styles.verdictLine}>{link.status === "ACCEPTED" ? "The merchant accepted. Send the payment below." : "Wallet cleared. Send the payment below."}</p>
            <dl className="dl">
              <div><dt>To</dt><dd className="mono"><span className={styles.linkRow}>{link.to}<CopyButton text={link.to} /></span></dd></div>
              <div><dt>Amount</dt><dd className="mono">{link.amountUsdc} USDC</dd></div>
              <div><dt>Network</dt><dd className="mono">Arc · chain id {link.chainId}</dd></div>
              <div><dt>Link</dt><dd className="mono"><span className={styles.linkRow}><a href={link.paymentUri}>{link.paymentUri}</a><CopyButton text={link.paymentUri} /></span></dd></div>
            </dl>
            <p className="small muted" style={{ marginTop: 10 }}>Send from the screened wallet only{link.payerAddress ? ` (${link.payerAddress})` : ""}. A different sender is a different counterparty.</p>
          </div>
          <QrSvg text={link.paymentUri} />
        </div>
      </div>
    );
  }
  // SCREENED + MEDIUM (or ACCEPTED without URI, which cannot happen)
  return (
    <div className={styles.section}>
      <div className="sec-bar"><span className="sec-n">02</span><span>Under review</span></div>
      <p className={styles.verdictLine}>
        {merchantView ? "This wallet is MEDIUM risk. Review the decision and accept or decline below." : "The merchant will review this payment. Keep this link; it updates when they decide."}
      </p>
      {!merchantView && link.payerEddUrl && <p className="small muted">You can speed it up: <a href={link.payerEddUrl}>answer the due-diligence questions</a>.</p>}
    </div>
  );
}
